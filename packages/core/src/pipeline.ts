/**
 * Pipeline: veien fra «noe kom inn» til «det ligger et bilag i regnskapet».
 *
 * Dette er limet. Alt annet - webhooks, worker, MCP-verktøy, manuelle
 * handlinger i UI - kaller inn HIT. Grunnen er ikke ryddighet for
 * ryddighetens skyld: dedup, versjonering av ekstraksjoner,
 * korreksjonshistorikk og matchereglene er invariantene som gjør at
 * regnskapet holder. En skrivevei utenom disse funksjonene er en skrivevei
 * som kan bryte dem.
 *
 * Stegene:
 *   1. storeRawDocument   - lagre uendret, idempotent på sha256
 *   2. runExtraction      - tolk med LLM, versjonert, aldri destruktivt
 *   3. upsertVoucher      - normaliser til bilag, hard dedup
 *   4. proposeMatches     - koble bank og dokument, usikkert foreslås
 *   5. mergeMatched       - slå de to sammen til ett bilag
 *
 * Bankveien er kortere: upsertBankTransaction gjør 1 + 3 i ett, fordi en
 * banktransaksjon ikke har et dokument å tolke.
 */
import { and, desc, eq, gte, inArray, isNull, lte, ne, sql } from "@qbikk/db";
import type { Database } from "@qbikk/db";
import {
  attachments as attachmentsTable,
  bankTransactions,
  categoryRules,
  corrections,
  counterparties,
  counterpartyAliases,
  extractions,
  rawDocuments,
  users,
  voucherLines,
  voucherMatches,
  vouchers,
} from "@qbikk/db";
import type { Attachment, CategoryRule, RawDocument, Voucher } from "@qbikk/db";
import { extractedDocumentSchema, overallConfidence, type ExtractedDocument } from "./contract.js";
import { sha256 } from "./dedup.js";
import { bestMatch, MATCH_CONFIG, type MatchCandidate, type MatchProposal } from "./matching.js";
import { normalizeBankTransaction, normalizeDocument, type BankVoucherInput } from "./normalize.js";
import { getProfile, type IndustryProfile } from "./profiles/index.js";
import { docKindFor, guessMime, type BlobStore } from "./storage.js";
import { normalizeCounterparty, emailDomain, htmlToText } from "./text.js";
import { ruleFromCorrection } from "./categorize.js";
import type { VatCode } from "./vat.js";

/* ------------------------------------------------------------------ typer */

/**
 * Formen pipeline tar imot dokumenter i.
 *
 * Bevisst strukturelt lik `DocumentItem` i @qbikk/ingestion, men uten import
 * derfra: avhengighetsretningen er `core <- ingestion`, aldri motsatt. En
 * kanal produserer noe som passer her; core vet ikke at kanaler finnes.
 */
export interface PipelineDocument {
  externalRef: string | null;
  receivedAt: Date;
  subject: string | null;
  sender: string | null;
  recipient: string | null;
  text: string | null;
  html: string | null;
  raw: Buffer | null;
  rawMime: string;
  attachments: Array<{
    filename: string | null;
    mime: string;
    data: Buffer;
    contentId?: string | null;
    inline?: boolean;
  }>;
  rawPayload: Record<string, unknown>;
}

export type ChannelKind =
  | "email_forward"
  | "inbox_scan"
  | "bank"
  | "file_upload"
  | "folder_watch"
  | "browser"
  | "manual";

export interface StoreRawResult {
  rawDocumentId: string;
  /** Sann når nøyaktig disse bytene allerede lå der. Ingenting ble skrevet. */
  isDuplicate: boolean;
  attachments: Attachment[];
}

/* --------------------------------------------------- 1. lagre rådokument - */

/**
 * Lagrer et dokument uendret og returnerer id-en.
 *
 * Idempotent på sha256 over råbytene: den samme e-posten videresendt to ganger
 * gir én rad. Det er første forsvarslinje mot dubletter, og den som gjør at en
 * webhook trygt kan leveres om igjen når leverandøren ikke fikk 200-svaret vårt.
 *
 * Merk at vi lagrer FØR vi tolker. Rådokumentet er sannheten; ekstraksjonen er
 * en mening om den, og meninger kan kjøres om igjen.
 */
export async function storeRawDocument(
  db: Database,
  blobs: BlobStore,
  input: {
    userId: string;
    channelId: string | null;
    channelType: ChannelKind;
    item: PipelineDocument;
  },
): Promise<StoreRawResult> {
  const { userId, item } = input;

  // Har vi ikke råbytes (kanaler som bare gir oss tekst), hasher vi teksten.
  // Poenget er at det samme innholdet skal gi den samme hashen hver gang.
  const rawBytes = item.raw ?? Buffer.from(item.text ?? item.html ?? "", "utf8");
  const contentSha256 = sha256(rawBytes);

  const existing = await findRawBySha(db, userId, contentSha256);
  if (existing) {
    return {
      rawDocumentId: existing.id,
      isDuplicate: true,
      attachments: await listAttachments(db, existing.id),
    };
  }

  const rawBlob = await blobs.put({
    data: rawBytes,
    mime: item.rawMime,
    prefix: `${userId}/raw`,
  });

  const textBody = item.text?.trim() || (item.html ? htmlToText(item.html) : null);

  const inserted = await db
    .insert(rawDocuments)
    .values({
      userId,
      channelId: input.channelId,
      channelType: input.channelType,
      externalRef: item.externalRef,
      kind: docKindFor(item.rawMime),
      receivedAt: item.receivedAt,
      subject: item.subject,
      sender: item.sender,
      recipient: item.recipient,
      storageKey: rawBlob.key,
      mime: item.rawMime,
      sizeBytes: rawBlob.sizeBytes,
      contentSha256,
      textBody,
      rawPayload: item.rawPayload,
    })
    // To workere som får samme e-post samtidig skal ikke velte hverandre.
    .onConflictDoNothing({ target: [rawDocuments.userId, rawDocuments.contentSha256] })
    .returning({ id: rawDocuments.id });

  const row = inserted[0];
  if (!row) {
    // Kappløpet tapt - den andre skriveren vant. Deres rad er like god som vår.
    const winner = await findRawBySha(db, userId, contentSha256);
    if (!winner) throw new Error("Rådokument forsvant mellom konflikt og oppslag");
    return {
      rawDocumentId: winner.id,
      isDuplicate: true,
      attachments: await listAttachments(db, winner.id),
    };
  }

  const stored = await storeAttachments(db, blobs, userId, row.id, item.attachments);
  return { rawDocumentId: row.id, isDuplicate: false, attachments: stored };
}

async function findRawBySha(db: Database, userId: string, contentSha256: string) {
  const [row] = await db
    .select()
    .from(rawDocuments)
    .where(and(eq(rawDocuments.userId, userId), eq(rawDocuments.contentSha256, contentSha256)))
    .limit(1);
  return row;
}

async function listAttachments(db: Database, rawDocumentId: string): Promise<Attachment[]> {
  return db.select().from(attachmentsTable).where(eq(attachmentsTable.rawDocumentId, rawDocumentId));
}

async function storeAttachments(
  db: Database,
  blobs: BlobStore,
  userId: string,
  rawDocumentId: string,
  incoming: PipelineDocument["attachments"],
): Promise<Attachment[]> {
  if (incoming.length === 0) return [];

  const primaryIndex = pickPrimaryAttachment(incoming);

  const rows = [];
  for (const [index, att] of incoming.entries()) {
    const mime = att.mime && att.mime !== "application/octet-stream" ? att.mime : guessMime(att.filename, att.mime);
    const blob = await blobs.put({ data: att.data, mime, prefix: `${userId}/att` });
    rows.push({
      userId,
      rawDocumentId,
      filename: att.filename,
      mime,
      sizeBytes: blob.sizeBytes,
      storageKey: blob.key,
      sha256: blob.sha256,
      isPrimary: index === primaryIndex,
    });
  }

  return db.insert(attachmentsTable).values(rows).returning();
}

/**
 * Hvilket vedlegg ER bilaget.
 *
 * En e-postkvittering har typisk tre vedlegg: en logo i signaturen, et
 * sporingspiksel og fakturaen. PDF slår bilde, bilde slår ingenting, og alt
 * med Content-ID er innebygd i HTML-en og dermed nesten alltid pynt.
 * Returnerer -1 når brødteksten selv er bilaget.
 */
export function pickPrimaryAttachment(list: PipelineDocument["attachments"]): number {
  const candidates = list
    .map((a, index) => ({ a, index }))
    .filter(({ a }) => !a.inline && !a.contentId && a.data.byteLength > 0);

  const pdf = candidates.find(({ a }) => a.mime === "application/pdf" || a.filename?.toLowerCase().endsWith(".pdf"));
  if (pdf) return pdf.index;

  const image = candidates.find(({ a }) => a.mime.startsWith("image/"));
  // Bilder under 20 kB er logoer, ikke kvitteringsfoto.
  if (image && image.a.data.byteLength > 20_000) return image.index;

  return -1;
}

/* ------------------------------------------------------ 2. kjør ekstraksjon */

export interface ExtractionInputLike {
  text?: string;
  data?: Buffer;
  mime?: string;
  filename?: string;
  hints?: {
    sender?: string | null;
    subject?: string | null;
    receivedAt?: string | null;
    ownNames?: string[];
  };
}

export interface ExtractionResultLike {
  document: ExtractedDocument;
  extractor: string;
  model: string | null;
  promptVersion: string;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
}

/** Strukturelt lik `Extractor` i @qbikk/extraction - se kommentaren på PipelineDocument. */
export interface ExtractorLike {
  readonly name: string;
  extract(input: ExtractionInputLike): Promise<ExtractionResultLike>;
}

export interface RunExtractionResult {
  extractionId: string;
  document: ExtractedDocument;
  /** Sann når vi gjenbrukte en tidligere ekstraksjon uten å kalle modellen. */
  reused: boolean;
}

/**
 * Tolker et rådokument og lagrer resultatet som en NY rad.
 *
 * Ekstraksjoner oppdateres aldri. Kjører vi om igjen - fordi prompten er
 * forbedret, eller fordi modellen er byttet - får den gamle raden
 * `superseded_at` og blir stående. Det gjør at et bilag fra 2026 fortsatt kan
 * forklares i 2031: du ser hvilken prompt og hvilken modell som produserte
 * tallene, og du kan kjøre om uten å miste historikken.
 */
export async function runExtraction(
  db: Database,
  extractor: ExtractorLike,
  input: { userId: string; rawDocumentId: string; force?: boolean },
): Promise<RunExtractionResult> {
  const [doc] = await db
    .select()
    .from(rawDocuments)
    .where(and(eq(rawDocuments.id, input.rawDocumentId), eq(rawDocuments.userId, input.userId)))
    .limit(1);
  if (!doc) throw new Error(`Ukjent rådokument: ${input.rawDocumentId}`);

  if (!input.force) {
    const current = await currentExtraction(db, input.rawDocumentId);
    if (current?.output) {
      return {
        extractionId: current.id,
        document: current.output as unknown as ExtractedDocument,
        reused: true,
      };
    }
  }

  const files = await listAttachments(db, input.rawDocumentId);
  const primary = files.find((f) => f.isPrimary) ?? null;

  const [user] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
  const ownNames = [user?.name, user?.email].filter((v): v is string => Boolean(v));

  const extractionInput: ExtractionInputLike = {
    text: doc.textBody ?? undefined,
    hints: {
      sender: doc.sender,
      subject: doc.subject,
      receivedAt: doc.receivedAt.toISOString(),
      ownNames,
    },
  };

  if (primary) {
    extractionInput.data = await readBlobFor(primary.storageKey);
    extractionInput.mime = primary.mime;
    extractionInput.filename = primary.filename ?? undefined;
  }

  const inputRef = primary ? primary.id : "body";

  let result: ExtractionResultLike;
  try {
    result = await extractor.extract(extractionInput);
  } catch (err) {
    // Feilen loggføres som en ekstraksjon slik at den er synlig i historikken,
    // men merkes superseded med en gang: et mislykket forsøk skal aldri kunne
    // bli lest som «dette er tolkningen av dokumentet».
    await db.insert(extractions).values({
      userId: input.userId,
      rawDocumentId: input.rawDocumentId,
      inputRef,
      extractor: extractor.name,
      promptVersion: "n/a",
      error: err instanceof Error ? err.message : String(err),
      supersededAt: new Date(),
    });
    throw err;
  }

  // Skjemaet valideres på nytt her. Den regelbaserte ekstraktoren går ikke
  // gjennom messages.parse(), og en fremtidig ekstraktor gjør det kanskje
  // heller ikke - kontrakten skal holde uansett hvem som fylte den.
  const parsed = extractedDocumentSchema.parse(result.document);

  const extractionId = await db.transaction(async (tx) => {
    await tx
      .update(extractions)
      .set({ supersededAt: new Date() })
      .where(and(eq(extractions.rawDocumentId, input.rawDocumentId), isNull(extractions.supersededAt)));

    const [row] = await tx
      .insert(extractions)
      .values({
        userId: input.userId,
        rawDocumentId: input.rawDocumentId,
        inputRef,
        extractor: result.extractor,
        model: result.model,
        promptVersion: result.promptVersion,
        output: parsed as unknown as Record<string, unknown>,
        fieldConfidence: parsed.fieldConfidence,
        overallConfidence: String(overallConfidence(parsed)),
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        latencyMs: result.latencyMs,
      })
      .returning({ id: extractions.id });

    if (!row) throw new Error("Klarte ikke å lagre ekstraksjonen");
    return row.id;
  });

  return { extractionId, document: parsed, reused: false };
}

async function currentExtraction(db: Database, rawDocumentId: string) {
  const [row] = await db
    .select()
    .from(extractions)
    .where(and(eq(extractions.rawDocumentId, rawDocumentId), isNull(extractions.supersededAt)))
    .orderBy(desc(extractions.createdAt))
    .limit(1);
  return row;
}

/** Lazy import: core skal ikke dra inn filsystemet før noen faktisk leser en blob. */
async function readBlobFor(key: string): Promise<Buffer> {
  const { getBlobStore } = await import("./storage.js");
  return getBlobStore().get(key);
}

/* ------------------------------------------------------- 3. lag bilaget --- */

export interface UpsertVoucherInput {
  userId: string;
  profile: IndustryProfile;
  rules: CategoryRule[];
  extractionId: string;
  document: ExtractedDocument;
  rawDocument: RawDocument;
  attachments?: Attachment[];
}

export interface UpsertVoucherResult {
  voucherId: string;
  /** Sann når bilaget allerede fantes. Ingenting ble overskrevet. */
  isDuplicate: boolean;
  reviewReasons: string[];
}

/**
 * Normaliserer en ekstraksjon til et bilag og lagrer det.
 *
 * Dedupen er hard: unique index på (user_id, dedup_hash). Kommer den samme
 * kvitteringen inn både via videresending og via IMAP-backfill, blir det ett
 * bilag - ikke to som brukeren må rydde i. Konflikt er derfor et normalt
 * utfall her, ikke en feil.
 */
export async function upsertVoucher(db: Database, input: UpsertVoucherInput): Promise<UpsertVoucherResult> {
  const { rawDocument } = input;
  const files = input.attachments ?? (await listAttachments(db, rawDocument.id));
  const primary = files.find((f) => f.isPrimary) ?? null;

  const normalized = await normalizeDocument(input.document, {
    userId: input.userId,
    profile: input.profile,
    rules: input.rules,
    origin: "document",
    sourceChannel: rawDocument.channelType,
    sourceChannelId: rawDocument.channelId,
    rawDocumentId: rawDocument.id,
    extractionId: input.extractionId,
    attachmentPath: primary?.storageKey ?? rawDocument.storageKey ?? null,
    receivedAt: rawDocument.receivedAt,
    senderAddress: rawDocument.sender,
    externalRef: null,
    rawPayload: null,
  });

  const counterpartyId = await ensureCounterparty(db, {
    userId: input.userId,
    name: normalized.voucher.counterpartyName ?? null,
    country: input.document.counterparty.country,
    orgNumber: input.document.counterparty.orgNumber,
    vatNumber: input.document.counterparty.vatNumber,
    source: rawDocument.channelType,
  });

  const [row] = await db
    .insert(vouchers)
    .values({ ...normalized.voucher, counterpartyId })
    .onConflictDoNothing({ target: [vouchers.userId, vouchers.dedupHash] })
    .returning({ id: vouchers.id });

  if (!row) {
    const [existing] = await db
      .select({ id: vouchers.id })
      .from(vouchers)
      .where(and(eq(vouchers.userId, input.userId), eq(vouchers.dedupHash, normalized.voucher.dedupHash)))
      .limit(1);
    if (!existing) throw new Error("Bilaget kolliderte, men fantes ikke ved oppslag");
    return { voucherId: existing.id, isDuplicate: true, reviewReasons: normalized.reviewReasons };
  }

  if (normalized.lines.length > 0) {
    await db.insert(voucherLines).values(normalized.lines.map((l) => ({ ...l, voucherId: row.id })));
  }

  return { voucherId: row.id, isDuplicate: false, reviewReasons: normalized.reviewReasons };
}

/**
 * Banktransaksjon -> bilag uten dokumentasjon.
 *
 * Bilaget får `needsDocumentation` og havner i «krever handling» til en
 * kvittering matcher det. Vi gjetter aldri MVA på et bankbilag: banken vet
 * hva som ble betalt, ikke hva det gjaldt.
 */
export async function upsertBankTransaction(
  db: Database,
  input: {
    userId: string;
    channelId: string | null;
    profile: IndustryProfile;
    rules: CategoryRule[];
    tx: BankVoucherInput & { accountId: string; counterpartyAccount?: string | null; rawPayload?: Record<string, unknown> };
  },
): Promise<{ voucherId: string; bankTransactionId: string; isDuplicate: boolean }> {
  const normalized = await normalizeBankTransaction(input.tx, {
    userId: input.userId,
    profile: input.profile,
    rules: input.rules,
    sourceChannel: "bank",
    sourceChannelId: input.channelId,
    receivedAt: new Date(`${input.tx.bookingDate}T00:00:00Z`),
    rawPayload: input.tx.rawPayload ?? null,
  });

  const counterpartyId = await ensureCounterparty(db, {
    userId: input.userId,
    name: input.tx.counterpartyName,
    country: null,
    orgNumber: null,
    vatNumber: null,
    source: "bank",
  });

  const [row] = await db
    .insert(vouchers)
    .values({ ...normalized.voucher, counterpartyId })
    .onConflictDoNothing({ target: [vouchers.userId, vouchers.dedupHash] })
    .returning({ id: vouchers.id });

  let voucherId: string;
  let isDuplicate = false;
  if (row) {
    voucherId = row.id;
  } else {
    const [existing] = await db
      .select({ id: vouchers.id })
      .from(vouchers)
      .where(and(eq(vouchers.userId, input.userId), eq(vouchers.dedupHash, normalized.voucher.dedupHash)))
      .limit(1);
    if (!existing) throw new Error("Bankbilaget kolliderte, men fantes ikke ved oppslag");
    voucherId = existing.id;
    isDuplicate = true;
  }

  const [txRow] = await db
    .insert(bankTransactions)
    .values({
      userId: input.userId,
      channelId: input.channelId,
      externalId: input.tx.externalId,
      accountId: input.tx.accountId,
      bookingDate: input.tx.bookingDate,
      valueDate: input.tx.valueDate,
      amount: input.tx.amount,
      currency: input.tx.currency.toUpperCase(),
      counterpartyNameRaw: input.tx.counterpartyName,
      counterpartyAccount: input.tx.counterpartyAccount ?? null,
      remittanceInfo: input.tx.remittanceInfo,
      rawPayload: input.tx.rawPayload ?? null,
      voucherId,
    })
    .onConflictDoNothing({
      target: [bankTransactions.userId, bankTransactions.accountId, bankTransactions.externalId],
    })
    .returning({ id: bankTransactions.id });

  if (txRow) return { voucherId, bankTransactionId: txRow.id, isDuplicate };

  const [existingTx] = await db
    .select({ id: bankTransactions.id })
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.userId, input.userId),
        eq(bankTransactions.accountId, input.tx.accountId),
        eq(bankTransactions.externalId, input.tx.externalId),
      ),
    )
    .limit(1);
  if (!existingTx) throw new Error("Banktransaksjonen kolliderte, men fantes ikke ved oppslag");
  return { voucherId, bankTransactionId: existingTx.id, isDuplicate: true };
}

/**
 * Slår opp eller oppretter motparten, og husker skrivemåten vi så.
 *
 * Aliaslista er det som gjør at «BEATPORT LLC*US» fra banken og
 * «Beatport, LLC» fra kvitteringen etter hvert kjennes igjen som samme
 * leverandør. Vi setter aldri `typicalDirection` her - retningen kommer fra
 * dokumentet, hver gang.
 */
export async function ensureCounterparty(
  db: Database,
  input: {
    userId: string;
    name: string | null;
    country?: string | null;
    orgNumber?: string | null;
    vatNumber?: string | null;
    source?: ChannelKind | null;
  },
): Promise<string | null> {
  const normalizedKey = normalizeCounterparty(input.name);
  if (!normalizedKey || !input.name) return null;

  await db
    .insert(counterparties)
    .values({
      userId: input.userId,
      canonicalName: input.name,
      normalizedKey,
      country: input.country ?? null,
      orgNumber: input.orgNumber ?? null,
      vatNumber: input.vatNumber ?? null,
    })
    .onConflictDoNothing({ target: [counterparties.userId, counterparties.normalizedKey] });

  const [row] = await db
    .select({ id: counterparties.id })
    .from(counterparties)
    .where(and(eq(counterparties.userId, input.userId), eq(counterparties.normalizedKey, normalizedKey)))
    .limit(1);
  if (!row) return null;

  if (input.name.trim() && input.source && input.source !== "manual") {
    await db
      .insert(counterpartyAliases)
      .values({
        counterpartyId: row.id,
        alias: input.name.trim(),
        normalizedKey,
        source: input.source,
      })
      .onConflictDoNothing();
  }

  return row.id;
}

/* --------------------------------------------------------- 4. matching ---- */

export interface ProposeMatchesResult {
  proposals: MatchProposal[];
  /** Koblinger som var utvilsomme nok til å utføres med en gang. */
  linked: Array<{ bankVoucherId: string; documentVoucherId: string }>;
}

/**
 * Finner motstykket til et bilag og skriver forslaget.
 *
 * Regelen fra oppdraget: USIKRE MATCHER FORESLÅS, IKKE UTFØRES. Bare en match
 * som er praktisk talt utvilsom - eksakt beløp, riktig retning, dato innenfor
 * vinduet, og tydelig bedre enn nummer to - kobles uten at brukeren har sagt
 * ja. Alt annet blir en rad med status `proposed` som dukker opp i
 * «krever handling».
 *
 * Funksjonen fungerer fra begge sider: gi den et bankbilag, og den leter etter
 * kvitteringen; gi den et dokumentbilag, og den leter etter betalingen.
 */
export async function proposeMatches(
  db: Database,
  input: { userId: string; voucherId: string; autoLink?: boolean },
): Promise<ProposeMatchesResult> {
  const [anchor] = await db
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.id, input.voucherId), eq(vouchers.userId, input.userId)))
    .limit(1);
  if (!anchor) throw new Error(`Ukjent bilag: ${input.voucherId}`);
  if (anchor.status === "duplicate") return { proposals: [], linked: [] };

  const anchorIsBank = anchor.sourceChannel === "bank";
  const from = shiftDate(anchor.date, -MATCH_CONFIG.dateWindowDays);
  const to = shiftDate(anchor.date, MATCH_CONFIG.dateWindowDays);

  const candidateRows = await db
    .select({
      id: vouchers.id,
      date: vouchers.date,
      direction: vouchers.direction,
      amountNok: vouchers.amountNok,
      currency: vouchers.currency,
      counterpartyName: vouchers.counterpartyName,
    })
    .from(vouchers)
    .where(
      and(
        eq(vouchers.userId, input.userId),
        eq(vouchers.direction, anchor.direction),
        gte(vouchers.date, from),
        lte(vouchers.date, to),
        ne(vouchers.id, anchor.id),
        ne(vouchers.status, "duplicate"),
        // Motstykket til et bankbilag er et dokumentbilag, og omvendt.
        anchorIsBank ? ne(vouchers.sourceChannel, "bank") : eq(vouchers.sourceChannel, "bank"),
        // Et bankbilag som allerede har fått dokumentasjon er ikke lenger ledig.
        anchorIsBank ? sql`true` : eq(vouchers.needsDocumentation, true),
      ),
    );

  if (candidateRows.length === 0) return { proposals: [], linked: [] };

  const already = await db
    .select({ bank: voucherMatches.bankVoucherId, doc: voucherMatches.documentVoucherId })
    .from(voucherMatches)
    .where(
      and(
        eq(voucherMatches.userId, input.userId),
        anchorIsBank
          ? eq(voucherMatches.bankVoucherId, anchor.id)
          : eq(voucherMatches.documentVoucherId, anchor.id),
      ),
    );
  const seen = new Set(already.map((m) => (anchorIsBank ? m.doc : m.bank)));

  const candidates: MatchCandidate[] = candidateRows
    .filter((c) => !seen.has(c.id))
    .map((c) => ({
      id: c.id,
      date: c.date,
      direction: c.direction,
      amountNok: c.amountNok,
      currency: c.currency,
      counterpartyName: c.counterpartyName,
    }));
  if (candidates.length === 0) return { proposals: [], linked: [] };

  const anchorCandidate: MatchCandidate = {
    id: anchor.id,
    date: anchor.date,
    direction: anchor.direction,
    amountNok: anchor.amountNok,
    currency: anchor.currency,
    counterpartyName: anchor.counterpartyName,
  };

  // `bestMatch` scorer én mot mange og nekter å auto-koble når nr. 1 og nr. 2
  // er for like. Poengsettingen er symmetrisk, så vi kan alltid sette
  // ankeret først og heller bytte om id-ene etterpå. Det gir oss den samme
  // tvetydighetsbeskyttelsen uansett hvilken side vi kom fra.
  const raw = bestMatch(anchorCandidate, candidates);
  if (!raw) return { proposals: [], linked: [] };

  const proposal: MatchProposal = anchorIsBank
    ? raw
    : { ...raw, bankVoucherId: raw.documentVoucherId, documentVoucherId: raw.bankVoucherId };

  const allowAuto = input.autoLink !== false && proposal.autoLink;

  await db
    .insert(voucherMatches)
    .values({
      userId: input.userId,
      bankVoucherId: proposal.bankVoucherId,
      documentVoucherId: proposal.documentVoucherId,
      score: String(proposal.score),
      reasons: proposal.reasons as unknown as Record<string, unknown>,
      status: allowAuto ? "confirmed" : "proposed",
      decidedAt: allowAuto ? new Date() : null,
      decidedBy: allowAuto ? "auto" : null,
    })
    .onConflictDoNothing({ target: [voucherMatches.bankVoucherId, voucherMatches.documentVoucherId] });

  if (!allowAuto) return { proposals: [proposal], linked: [] };

  await mergeMatched(db, {
    userId: input.userId,
    bankVoucherId: proposal.bankVoucherId,
    documentVoucherId: proposal.documentVoucherId,
  });
  return {
    proposals: [proposal],
    linked: [{ bankVoucherId: proposal.bankVoucherId, documentVoucherId: proposal.documentVoucherId }],
  };
}

/* ------------------------------------------------------- 5. slå sammen ---- */

/**
 * Slår et bankbilag og et dokumentbilag sammen til ETT bilag.
 *
 * Dokumentbilaget overlever, fordi det er det som har MVA, varelinjer og
 * selve dokumentasjonen - alt en revisor spør etter. Fra banken henter vi det
 * banken er fasit på: bokføringsdatoen. Bankbilaget slettes ikke, det får
 * status `duplicate` og en peker til bilaget det ble en del av. Ingenting
 * forsvinner; det er hele poenget med et revisjonsspor.
 */
export async function mergeMatched(
  db: Database,
  input: { userId: string; bankVoucherId: string; documentVoucherId: string; actor?: string },
): Promise<{ voucherId: string }> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.userId, input.userId), inArray(vouchers.id, [input.bankVoucherId, input.documentVoucherId])));

    const bank = rows.find((r) => r.id === input.bankVoucherId);
    const doc = rows.find((r) => r.id === input.documentVoucherId);
    if (!bank || !doc) throw new Error("Fant ikke begge bilagene som skulle slås sammen");
    if (bank.id === doc.id) throw new Error("Et bilag kan ikke slås sammen med seg selv");

    await tx
      .update(vouchers)
      .set({
        bookingDate: bank.bookingDate ?? bank.date,
        needsDocumentation: false,
        // `confirmed` er brukerens ord. En maskinell kobling stopper på `matched`.
        status: doc.status === "confirmed" ? "confirmed" : "matched",
        supersedesVoucherId: bank.id,
        updatedAt: new Date(),
      })
      .where(eq(vouchers.id, doc.id));

    await tx
      .update(vouchers)
      .set({ status: "duplicate", needsDocumentation: false, updatedAt: new Date() })
      .where(eq(vouchers.id, bank.id));

    // Banktransaksjonen skal peke på bilaget som overlevde, ellers mister vi
    // sporet fra kontoutskriften til dokumentasjonen.
    await tx.update(bankTransactions).set({ voucherId: doc.id }).where(eq(bankTransactions.voucherId, bank.id));

    await tx
      .update(voucherMatches)
      .set({ status: "confirmed", decidedAt: new Date(), decidedBy: input.actor ?? "auto" })
      .where(
        and(
          eq(voucherMatches.bankVoucherId, bank.id),
          eq(voucherMatches.documentVoucherId, doc.id),
        ),
      );

    return { voucherId: doc.id };
  });
}

/** Avviser et forslag. Bilagene røres ikke - bare koblingen lukkes. */
export async function rejectMatch(
  db: Database,
  input: { userId: string; bankVoucherId: string; documentVoucherId: string; actor?: string },
): Promise<void> {
  await db
    .update(voucherMatches)
    .set({ status: "rejected", decidedAt: new Date(), decidedBy: input.actor ?? "user" })
    .where(
      and(
        eq(voucherMatches.userId, input.userId),
        eq(voucherMatches.bankVoucherId, input.bankVoucherId),
        eq(voucherMatches.documentVoucherId, input.documentVoucherId),
      ),
    );
}

/* ---------------------------------------------------------- korreksjoner -- */

/** Feltene en bruker får rette. Beløp og dato er med; id og hash er det ikke. */
export const CORRECTABLE_FIELDS = [
  "date",
  "direction",
  "grossAmount",
  "currency",
  "counterpartyName",
  "description",
  "category",
  "accountCode",
  "vatCode",
  "status",
] as const;

export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];

/**
 * Retter et felt på et bilag - append-only.
 *
 * Selve raden oppdateres (den skal vise riktig verdi), men HVER endring
 * skriver en rad i `corrections` med gammel og ny verdi. Det er
 * revisjonssporet bokføringsloven krever, og det er samtidig
 * treningsmaterialet: en korreksjon av kategori lærer en regel som gjør at
 * den samme leverandøren havner riktig neste gang.
 */
export async function applyCorrection(
  db: Database,
  input: {
    userId: string;
    voucherId: string;
    field: CorrectableField;
    value: unknown;
    reason?: string | null;
    actor?: string;
  },
): Promise<{ voucherId: string; learnedRuleId: string | null }> {
  const [voucher] = await db
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.id, input.voucherId), eq(vouchers.userId, input.userId)))
    .limit(1);
  if (!voucher) throw new Error(`Ukjent bilag: ${input.voucherId}`);

  const oldValue = (voucher as unknown as Record<string, unknown>)[input.field] ?? null;

  const patch: Record<string, unknown> = { [input.field]: input.value, updatedAt: new Date() };
  if (input.field === "status" && input.value === "confirmed") patch.confirmedAt = new Date();

  await db.update(vouchers).set(patch).where(eq(vouchers.id, input.voucherId));

  let learnedRuleId: string | null = null;

  // Bare kategori-, konto- og MVA-rettinger er verdt å lære av. At brukeren
  // rettet et beløp sier ingenting om neste bilag fra samme leverandør.
  if (input.field === "category" || input.field === "accountCode" || input.field === "vatCode") {
    learnedRuleId = await learnFromCorrection(db, {
      userId: input.userId,
      voucher,
      field: input.field,
      value: input.value,
    });
  }

  await db.insert(corrections).values({
    userId: input.userId,
    voucherId: input.voucherId,
    field: input.field,
    oldValue: oldValue as never,
    newValue: (input.value ?? null) as never,
    reason: input.reason ?? null,
    actor: input.actor ?? "user",
    learnedRuleId,
  });

  return { voucherId: input.voucherId, learnedRuleId };
}

async function learnFromCorrection(
  db: Database,
  input: {
    userId: string;
    voucher: Voucher;
    field: "category" | "accountCode" | "vatCode";
    value: unknown;
  },
): Promise<string | null> {
  const [raw] = input.voucher.rawDocumentId
    ? await db.select().from(rawDocuments).where(eq(rawDocuments.id, input.voucher.rawDocumentId)).limit(1)
    : [];

  const rule = ruleFromCorrection({
    userId: input.userId,
    counterpartyName: input.voucher.counterpartyName,
    senderDomain: emailDomain(raw?.sender ?? null),
    direction: input.voucher.direction,
    category: input.field === "category" ? (input.value as string) : input.voucher.category,
    accountCode: input.field === "accountCode" ? (input.value as string) : input.voucher.accountCode,
    vatCode: input.field === "vatCode" ? (input.value as VatCode) : (input.voucher.vatCode as VatCode | null),
  });
  if (!rule) return null;

  const [row] = await db.insert(categoryRules).values(rule).returning({ id: categoryRules.id });
  return row?.id ?? null;
}

/* ---------------------------------------------------------------- oppslag - */

/** Reglene som gjelder for en bruker, sortert slik `categorize()` forventer. */
export async function loadRules(db: Database, userId: string): Promise<CategoryRule[]> {
  return db
    .select()
    .from(categoryRules)
    .where(and(eq(categoryRules.userId, userId), eq(categoryRules.enabled, true)))
    .orderBy(categoryRules.priority, desc(categoryRules.createdAt));
}

/** Bruker + bransjeprofil i ett oppslag - alle pipeline-kall trenger begge. */
export async function loadUserContext(
  db: Database,
  userId: string,
): Promise<{ profile: IndustryProfile; rules: CategoryRule[] }> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error(`Ukjent bruker: ${userId}`);
  return { profile: getProfile(user.profile), rules: await loadRules(db, userId) };
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------ manuelle bilag --- */

export interface ManualVoucherInput {
  userId: string;
  profile: IndustryProfile;
  rules: CategoryRule[];
  date: string;
  direction: "income" | "expense";
  /** I minste enhet av `currency`. Alltid positivt. */
  grossAmount: number;
  currency: string;
  counterpartyName: string | null;
  description: string | null;
  category?: string | null;
  vatAmount?: number | null;
  vatRate?: number | null;
  counterpartyCountry?: string | null;
  externalRef?: string | null;
}

/**
 * Bilag opprettet for hånd - i UI eller av en agent gjennom MCP.
 *
 * Går gjennom NØYAKTIG samme `normalizeDocument()` som et innlest dokument.
 * Det er ikke omstendelig for omstendelighetens skyld: et manuelt bilag skal
 * treffe den samme dedupen, den samme kategoriseringen og den samme
 * MVA-behandlingen. En egen, kortere skrivevei ville før eller siden gitt to
 * ulike svar på det samme spørsmålet.
 *
 * Confidence settes til 1: et menneske har oppgitt tallene, og da er det ikke
 * ekstraksjonen som er usikker.
 */
export async function createManualVoucher(
  db: Database,
  input: ManualVoucherInput,
): Promise<UpsertVoucherResult> {
  const amountString = (input.grossAmount / 100).toFixed(2);

  const document: ExtractedDocument = {
    documentType: "receipt",
    direction: input.direction,
    issueDate: input.date,
    dueDate: null,
    currency: input.currency.toUpperCase(),
    grossAmount: amountString,
    netAmount: null,
    vatAmount: input.vatAmount !== null && input.vatAmount !== undefined ? (input.vatAmount / 100).toFixed(2) : null,
    vatRate: input.vatRate ?? null,
    vatCode: null,
    counterparty: {
      name: input.counterpartyName,
      country: input.counterpartyCountry ?? null,
      orgNumber: null,
      vatNumber: null,
    },
    invoiceNumber: input.externalRef ?? null,
    orderNumber: null,
    description: input.description,
    paymentMethod: null,
    isPaid: null,
    lines: [],
    fieldConfidence: {
      grossAmount: 1,
      issueDate: 1,
      direction: 1,
      currency: 1,
      "counterparty.name": input.counterpartyName ? 1 : 0,
      description: input.description ? 1 : 0,
    },
    notes: "Opprettet manuelt.",
  };

  const normalized = await normalizeDocument(document, {
    userId: input.userId,
    profile: input.profile,
    rules: input.rules,
    origin: "document",
    sourceChannel: "manual",
    receivedAt: new Date(`${input.date}T00:00:00Z`),
    externalRef: input.externalRef ?? null,
  });

  // En eksplisitt kategori fra brukeren slår det reglene gjettet seg fram til.
  if (input.category) {
    normalized.voucher.category = input.category;
    const category = input.profile.categories.find((c) => c.key === input.category);
    if (category) normalized.voucher.accountCode = category.accountCode;
  }

  const counterpartyId = await ensureCounterparty(db, {
    userId: input.userId,
    name: input.counterpartyName,
    country: input.counterpartyCountry ?? null,
    source: "manual",
  });

  const [row] = await db
    .insert(vouchers)
    .values({ ...normalized.voucher, counterpartyId })
    .onConflictDoNothing({ target: [vouchers.userId, vouchers.dedupHash] })
    .returning({ id: vouchers.id });

  if (!row) {
    const [existing] = await db
      .select({ id: vouchers.id })
      .from(vouchers)
      .where(and(eq(vouchers.userId, input.userId), eq(vouchers.dedupHash, normalized.voucher.dedupHash)))
      .limit(1);
    if (!existing) throw new Error("Bilaget kolliderte, men fantes ikke ved oppslag");
    return { voucherId: existing.id, isDuplicate: true, reviewReasons: normalized.reviewReasons };
  }

  return { voucherId: row.id, isDuplicate: false, reviewReasons: normalized.reviewReasons };
}

/**
 * Legger dokumentasjon på et bilag som mangler den - typisk et bankbilag.
 *
 * Filen lagres som et helt vanlig rådokument, slik at den arkiveres,
 * dedupliseres og kan tolkes på nytt som alt annet. Bilaget peker på blob-en
 * og mister `needsDocumentation`; det forsvinner dermed fra
 * «krever handling» uten at noe annet på bilaget røres.
 */
export async function attachDocumentToVoucher(
  db: Database,
  blobs: BlobStore,
  input: {
    userId: string;
    voucherId: string;
    filename: string;
    mime: string;
    data: Buffer;
  },
): Promise<{ rawDocumentId: string; isDuplicate: boolean }> {
  const [voucher] = await db
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.id, input.voucherId), eq(vouchers.userId, input.userId)))
    .limit(1);
  if (!voucher) throw new Error(`Ukjent bilag: ${input.voucherId}`);

  const stored = await storeRawDocument(db, blobs, {
    userId: input.userId,
    channelId: null,
    channelType: "file_upload",
    item: {
      externalRef: null,
      receivedAt: new Date(),
      subject: input.filename,
      sender: null,
      recipient: null,
      text: null,
      html: null,
      raw: input.data,
      rawMime: input.mime,
      attachments: [{ filename: input.filename, mime: input.mime, data: input.data, inline: false }],
      rawPayload: { attachedTo: input.voucherId, filename: input.filename },
    },
  });

  const files = await listAttachments(db, stored.rawDocumentId);
  const primary = files.find((f) => f.isPrimary) ?? files[0];

  await db
    .update(vouchers)
    .set({
      rawDocumentId: voucher.rawDocumentId ?? stored.rawDocumentId,
      attachmentPath: primary?.storageKey ?? voucher.attachmentPath,
      needsDocumentation: false,
      updatedAt: new Date(),
    })
    .where(eq(vouchers.id, input.voucherId));

  return { rawDocumentId: stored.rawDocumentId, isDuplicate: stored.isDuplicate };
}
