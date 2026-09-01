import { normalizeCounterparty, emailDomain } from "@qbikk/core/text";
import type { ExtractedDocument } from "@qbikk/core/contract";
import type { ExtractionInput, ExtractionResult, Extractor } from "./types.js";
import { PROMPT_VERSION } from "./prompt.js";

/**
 * Regelbasert ekstraktor uten LLM.
 *
 * To grunner til at denne finnes:
 *  1. Prosjektet skal kunne kjøres og demonstreres uten API-nøkkel.
 *  2. Tester må være deterministiske. En test som kaller en modell er ikke
 *     en test av koden vår.
 *
 * Den er med vilje forsiktig: den setter lav fieldConfidence overalt, så alt
 * den produserer havner i gjennomgangskøen. Den skal aldri brukes i produksjon,
 * og den later ikke som noe annet.
 */
export class HeuristicExtractor implements Extractor {
  readonly name = "heuristic";

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const started = Date.now();
    const text = input.text ?? "";
    const doc = parseText(text, input.hints);
    return {
      document: doc,
      extractor: this.name,
      model: null,
      promptVersion: `${PROMPT_VERSION}-heuristic`,
      tokensIn: null,
      tokensOut: null,
      latencyMs: Date.now() - started,
    };
  }
}

const CURRENCY_WORDS: Record<string, string> = {
  kr: "NOK", nok: "NOK", kroner: "NOK",
  usd: "USD", $: "USD", eur: "EUR", "€": "EUR",
  gbp: "GBP", "£": "GBP", sek: "SEK", dkk: "DKK",
};

const INCOME_MARKERS = /\b(payout|utbetaling|earnings|royalt|statement|kreditnota|credit note|innbetalt|honorar mottatt)\b/i;
const EXPENSE_MARKERS = /\b(invoice|faktura|receipt|kvittering|order|ordre|betalt|charged|belastet|subscription renewed)\b/i;

const TOTAL_PATTERNS = [
  /(?:total(?:t|beløp)?|sum|å betale|amount (?:due|paid|charged)|grand total|beløp)\s*[:\s]\s*([A-Z]{3}|kr|\$|€|£)?\s*([\d\s.,]+)/i,
  /([A-Z]{3}|kr|\$|€|£)\s*([\d\s.,]+)\s*(?:total|å betale)/i,
];

const VAT_PATTERNS = [
  /(?:mva|moms|vat|tax)\s*(?:\((\d{1,2})\s*%\))?\s*[:\s]\s*([A-Z]{3}|kr|\$|€|£)?\s*([\d\s.,]+)/i,
];

const DATE_PATTERNS = [
  /\b(\d{4})-(\d{2})-(\d{2})\b/,
  /\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/,
];

function parseText(text: string, hints?: ExtractionInput["hints"]): ExtractedDocument {
  const currency = detectCurrency(text) ?? "NOK";
  const gross = matchAmount(text, TOTAL_PATTERNS);
  const vat = matchVat(text);
  const issueDate = matchDate(text) ?? hints?.receivedAt?.slice(0, 10) ?? null;

  const income = INCOME_MARKERS.test(text);
  const expense = EXPENSE_MARKERS.test(text);
  const direction: ExtractedDocument["direction"] = income && !expense ? "income" : expense && !income ? "expense" : "unknown";

  const name = guessCounterparty(text, hints?.sender ?? null);
  const domain = emailDomain(hints?.sender);

  return {
    documentType: gross ? "receipt" : "not_a_voucher",
    direction,
    issueDate,
    dueDate: null,
    currency,
    grossAmount: gross,
    netAmount: null,
    vatAmount: vat.amount,
    vatRate: vat.rate,
    vatCode: null,
    counterparty: {
      name,
      country: guessCountry(domain, currency),
      orgNumber: text.match(/\b(\d{9})\s*MVA\b/i)?.[1] ?? null,
      vatNumber: null,
    },
    invoiceNumber: text.match(/(?:faktura(?:nr)?|invoice)\s*#?\s*[:\s]\s*([A-Za-z0-9-]{3,})/i)?.[1] ?? null,
    orderNumber: text.match(/(?:ordre(?:nr)?|order)\s*#?\s*[:\s]\s*([A-Za-z0-9-]{3,})/i)?.[1] ?? null,
    description: hints?.subject ?? null,
    paymentMethod: null,
    isPaid: null,
    lines: [],
    // Bevisst lave tall: alt fra denne ekstraktoren skal gjennomgås av et menneske.
    fieldConfidence: {
      grossAmount: gross ? 0.6 : 0,
      issueDate: issueDate ? 0.6 : 0,
      direction: direction === "unknown" ? 0.1 : 0.5,
      currency: 0.5,
      "counterparty.name": name ? 0.4 : 0,
      vatAmount: vat.amount ? 0.5 : 0,
      vatRate: vat.rate ? 0.5 : 0,
      description: 0.2,
    },
    notes: "Tolket uten språkmodell (regelbasert fallback). Bør kontrolleres.",
  };
}

function detectCurrency(text: string): string | null {
  const iso = text.match(/\b(NOK|USD|EUR|GBP|SEK|DKK|JPY)\b/);
  if (iso) return iso[1]!;
  for (const [word, code] of Object.entries(CURRENCY_WORDS)) {
    if (new RegExp(`(^|[\\s])${escapeRegex(word)}[\\s\\d]`, "i").test(text)) return code;
  }
  return null;
}

function matchAmount(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    const raw = m?.[2];
    if (raw) {
      const normalized = normalizeNumber(raw);
      if (normalized) return normalized;
    }
  }
  return null;
}

function matchVat(text: string): { amount: string | null; rate: number | null } {
  for (const pattern of VAT_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;
    const amount = m[3] ? normalizeNumber(m[3]) : null;
    const rate = m[1] ? Number(m[1]) : null;
    if (amount || rate !== null) return { amount, rate };
  }
  const rateOnly = text.match(/\b(25|15|12)\s*%\s*(?:mva|moms|vat)/i);
  return { amount: null, rate: rateOnly ? Number(rateOnly[1]) : null };
}

function normalizeNumber(raw: string): string | null {
  const cleaned = raw.replace(/\s/g, "").replace(/,-$/, "");
  if (!/\d/.test(cleaned)) return null;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let value: string;
  if (lastComma > lastDot) value = cleaned.replace(/\./g, "").replace(",", ".");
  else value = cleaned.replace(/,/g, "");
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num.toFixed(2);
}

function matchDate(text: string): string | null {
  for (const pattern of DATE_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;
    if (pattern.source.startsWith("\\b(\\d{4})")) return `${m[1]}-${m[2]}-${m[3]}`;
    const day = m[1]!.padStart(2, "0");
    const month = m[2]!.padStart(2, "0");
    return `${m[3]}-${month}-${day}`;
  }
  return null;
}

function guessCounterparty(text: string, sender: string | null): string | null {
  const domain = emailDomain(sender);
  if (domain) {
    const base = domain.split(".")[0];
    if (base && base.length > 2) return base.charAt(0).toUpperCase() + base.slice(1);
  }
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 2 && l.length < 60);
  return firstLine && normalizeCounterparty(firstLine) ? firstLine : null;
}

function guessCountry(domain: string | null, currency: string): string | null {
  if (domain?.endsWith(".no")) return "NO";
  if (domain?.endsWith(".se")) return "SE";
  if (domain?.endsWith(".dk")) return "DK";
  if (domain?.endsWith(".de")) return "DE";
  if (currency === "NOK") return "NO";
  // Ingen gjetning på "NO" for utenlandsk valuta - feil land gir feil mva.
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
