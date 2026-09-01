/**
 * Normalisering: ExtractedDocument -> bilag.
 *
 * Dette er stedet der et hvilket som helst dokument fra en hvilken som helst
 * bransje blir til den samme raden. Ingenting her vet hva en DJ eller en
 * frisør er - bransjen kommer inn som data (profilen), ikke som kodevei.
 *
 * Statusene brukes slik:
 *   needs_review - lav confidence, manglende påkrevd felt, eller mulig dublett
 *   matched      - komplett bilag, evt. avstemt mot bank. Klart til bokføring.
 *   confirmed    - brukeren har godkjent det
 */
import type { NewVoucher, NewVoucherLine, CategoryRule } from "@qbikk/db";
import type { ExtractedDocument } from "./contract.js";
import { overallConfidence, REVIEW_THRESHOLD } from "./contract.js";
import { parseAmount, minor, type Minor } from "./money.js";
import { convertToNok } from "./fx.js";
import { splitFromGross, vatCodeFromRate, type VatCode } from "./vat.js";
import { categorize } from "./categorize.js";
import { dedupHash, type VoucherOrigin } from "./dedup.js";
import { emailDomain } from "./text.js";
import type { IndustryProfile } from "./profiles/types.js";

export interface NormalizeContext {
  userId: string;
  profile: IndustryProfile;
  rules: CategoryRule[];
  origin: VoucherOrigin;
  sourceChannel: NewVoucher["sourceChannel"];
  sourceChannelId?: string | null;
  rawDocumentId?: string | null;
  extractionId?: string | null;
  /** Blob-nøkkel til dokumentasjonen. Null for bankbilag uten kvittering. */
  attachmentPath?: string | null;
  /** Brukes som datofallback og til domenebasert kategorisering. */
  receivedAt: Date;
  senderAddress?: string | null;
  externalRef?: string | null;
  rawPayload?: Record<string, unknown> | null;
}

export interface NormalizedVoucher {
  voucher: NewVoucher;
  lines: Omit<NewVoucherLine, "voucherId">[];
  /** Grunner til at bilaget havnet i gjennomgangskøen. Vises i UI. */
  reviewReasons: string[];
}

export async function normalizeDocument(
  doc: ExtractedDocument,
  ctx: NormalizeContext,
): Promise<NormalizedVoucher> {
  const reviewReasons: string[] = [];

  const currency = (doc.currency ?? "NOK").toUpperCase();

  const date = doc.issueDate ?? ctx.receivedAt.toISOString().slice(0, 10);
  if (!doc.issueDate) reviewReasons.push("Dokumentdato manglet - bruker mottaksdato");

  // Retning skal komme fra dokumentet. Er den ukjent, gjetter vi ikke -
  // vi setter utgift som plassholder og sender bilaget til gjennomgang.
  let direction: "income" | "expense";
  if (doc.direction === "unknown") {
    direction = "expense";
    reviewReasons.push("Kunne ikke avgjøre om dette er inntekt eller utgift");
  } else {
    direction = doc.direction;
  }

  const grossParsed = parseAmount(doc.grossAmount, currency);
  const gross = grossParsed === null ? minor(0) : (Math.abs(grossParsed) as Minor);
  if (grossParsed === null) reviewReasons.push("Fant ikke totalbeløp");

  const senderDomain = emailDomain(ctx.senderAddress);
  const suggestedVatCode = (doc.vatCode as VatCode | null) ?? vatCodeFromRate(doc.vatRate);
  const parsedVat = parseAmount(doc.vatAmount, currency);

  const categorization = categorize(ctx.profile, ctx.rules, {
    direction,
    counterpartyName: doc.counterparty.name,
    counterpartyCountry: doc.counterparty.country,
    description: doc.description,
    senderDomain,
    vatAmount: parsedVat,
    vatRate: doc.vatRate,
    suggestedVatCode,
  });

  // MVA: dokumentets egne tall vinner. Bare når de mangler regner vi ut.
  let vatAmount: Minor;
  let netAmount: Minor;
  let vatRate: number;

  const parsedNet = parseAmount(doc.netAmount, currency);
  if (parsedVat !== null && parsedNet !== null) {
    vatAmount = Math.abs(parsedVat) as Minor;
    netAmount = Math.abs(parsedNet) as Minor;
    vatRate = doc.vatRate ?? (netAmount > 0 ? Math.round((vatAmount / netAmount) * 10000) / 100 : 0);
  } else if (parsedVat !== null) {
    vatAmount = Math.abs(parsedVat) as Minor;
    netAmount = (gross - vatAmount) as Minor;
    vatRate = doc.vatRate ?? (netAmount > 0 ? Math.round((vatAmount / netAmount) * 10000) / 100 : 0);
  } else {
    const split = splitFromGross(gross, categorization.vatCode);
    vatAmount = split.vat;
    netAmount = split.net;
    vatRate = split.rate;
    if (gross > 0 && categorization.vatCode !== "reverse_charge" && categorization.vatCode !== "exempt") {
      reviewReasons.push("MVA-beløp sto ikke i dokumentet - beregnet fra kategoriens standardsats");
    }
  }

  const converted = await convertToNok(gross, currency, date);

  const confidence = overallConfidence(doc);
  if (confidence < REVIEW_THRESHOLD) reviewReasons.push(`Lav sikkerhet i ekstraksjonen (${Math.round(confidence * 100)} %)`);
  if (doc.documentType === "not_a_voucher") reviewReasons.push("Ser ikke ut som et bilag");
  if (categorization.reverseCharge) reviewReasons.push("Kjøp fra utlandet - omvendt avgiftsplikt");

  const counterpartyName = doc.counterparty.name;
  const externalRef = ctx.externalRef ?? doc.invoiceNumber ?? doc.orderNumber ?? null;

  const voucher: NewVoucher = {
    userId: ctx.userId,
    sourceChannel: ctx.sourceChannel,
    sourceChannelId: ctx.sourceChannelId ?? null,
    externalRef,
    rawDocumentId: ctx.rawDocumentId ?? null,
    extractionId: ctx.extractionId ?? null,
    date,
    direction,
    grossAmount: gross,
    netAmount,
    vatAmount,
    vatRate: String(vatRate),
    vatCode: categorization.vatCode,
    currency,
    amountNok: converted.amountNok,
    exchangeRate: String(converted.exchangeRate),
    rateDate: converted.rateDate,
    counterpartyName,
    counterpartyCountry: doc.counterparty.country ?? null,
    description: doc.description,
    category: categorization.category,
    accountCode: categorization.accountCode,
    attachmentPath: ctx.attachmentPath ?? null,
    rawPayload: ctx.rawPayload ?? null,
    confidence: String(confidence),
    status: reviewReasons.length > 0 ? "needs_review" : "matched",
    dedupHash: dedupHash({
      userId: ctx.userId,
      origin: ctx.origin,
      date,
      direction,
      amountNok: converted.amountNok,
      currency,
      counterpartyName,
      externalRef,
    }),
    needsDocumentation: ctx.attachmentPath === null && ctx.origin === "bank",
    reverseCharge: categorization.reverseCharge,
  };

  const lines = buildLines(doc, currency, categorization.vatCode, categorization.accountCode, categorization.category);

  return { voucher, lines, reviewReasons };
}

/**
 * Varelinjer med MVA per linje. Kritisk for blandede kvitteringer der
 * 15 % og 25 % står om hverandre - totalen alene holder ikke til MVA-meldingen.
 */
function buildLines(
  doc: ExtractedDocument,
  currency: string,
  fallbackVatCode: VatCode,
  accountCode: string,
  category: string,
): Omit<NewVoucherLine, "voucherId">[] {
  return doc.lines.flatMap((line, index) => {
    const grossParsed = parseAmount(line.grossAmount, currency);
    const netParsed = parseAmount(line.netAmount, currency);
    if (grossParsed === null && netParsed === null) return [];

    const code = vatCodeFromRate(line.vatRate) ?? fallbackVatCode;
    const split =
      grossParsed !== null
        ? splitFromGross(Math.abs(grossParsed), code)
        : splitFromGross(Math.abs(netParsed!) + (parseAmount(line.vatAmount, currency) ?? 0), code);

    const explicitVat = parseAmount(line.vatAmount, currency);

    return [
      {
        lineNo: index + 1,
        description: line.description,
        quantity: line.quantity ? line.quantity.replace(",", ".") : null,
        unitPrice: parseAmount(line.unitPrice, currency),
        netAmount: netParsed !== null ? (Math.abs(netParsed) as Minor) : split.net,
        vatCode: code,
        vatRate: String(line.vatRate ?? split.rate),
        vatAmount: explicitVat !== null ? (Math.abs(explicitVat) as Minor) : split.vat,
        grossAmount: split.gross,
        accountCode,
        category,
      },
    ];
  });
}

/**
 * Bankbilag: en transaksjon uten dokumentasjon.
 *
 * Banken er fasit på beløp og dato, men vet ingenting om MVA. Derfor settes
 * MVA til null og bilaget flagges `needsDocumentation` til en kvittering
 * matcher det.
 */
export interface BankVoucherInput {
  externalId: string;
  bookingDate: string;
  valueDate: string | null;
  /** Fortegn beholdt fra banken: negativ = utgift. */
  amount: number;
  currency: string;
  counterpartyName: string | null;
  remittanceInfo: string | null;
}

export async function normalizeBankTransaction(
  tx: BankVoucherInput,
  ctx: Omit<NormalizeContext, "origin">,
): Promise<NormalizedVoucher> {
  const direction: "income" | "expense" = tx.amount >= 0 ? "income" : "expense";
  const gross = Math.abs(tx.amount) as Minor;
  const currency = tx.currency.toUpperCase();
  const date = tx.valueDate ?? tx.bookingDate;

  const converted = await convertToNok(gross, currency, date);

  const categorization = categorize(ctx.profile, ctx.rules, {
    direction,
    counterpartyName: tx.counterpartyName,
    counterpartyCountry: null,
    description: tx.remittanceInfo,
    senderDomain: null,
    vatAmount: null,
    vatRate: null,
    suggestedVatCode: null,
  });

  const voucher: NewVoucher = {
    userId: ctx.userId,
    sourceChannel: "bank",
    sourceChannelId: ctx.sourceChannelId ?? null,
    externalRef: tx.externalId,
    date,
    bookingDate: tx.bookingDate,
    direction,
    grossAmount: gross,
    // MVA er ukjent til vi har dokumentasjon. Vi gjetter ikke.
    netAmount: null,
    vatAmount: null,
    vatRate: null,
    vatCode: null,
    currency,
    amountNok: converted.amountNok,
    exchangeRate: String(converted.exchangeRate),
    rateDate: converted.rateDate,
    counterpartyName: tx.counterpartyName,
    counterpartyCountry: null,
    description: tx.remittanceInfo,
    category: categorization.category,
    accountCode: categorization.accountCode,
    attachmentPath: null,
    rawPayload: ctx.rawPayload ?? null,
    confidence: "1",
    status: "needs_review",
    dedupHash: dedupHash({
      userId: ctx.userId,
      origin: "bank",
      date,
      direction,
      amountNok: converted.amountNok,
      currency,
      counterpartyName: tx.counterpartyName,
      externalRef: tx.externalId,
    }),
    needsDocumentation: true,
    reverseCharge: false,
  };

  return { voucher, lines: [], reviewReasons: ["Banktransaksjon uten kvittering"] };
}
