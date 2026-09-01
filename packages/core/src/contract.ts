/**
 * Kontrakten mellom ekstraksjonslaget og resten av systemet.
 *
 * Dette er DET generiske laget: uansett om input er en e-postkvittering fra
 * Beatport, en PDF-faktura fra en hårproduktgrossist eller et mobilfoto av en
 * papirkvittering fra Rema, kommer det ut det samme objektet. Ingen
 * leverandørspesifikk kode noe sted.
 *
 * Skjemaet sendes til LLM-en som tool-definisjon, så feltnavnene her er
 * samtidig prompten. Beskrivelsene betyr noe - endrer du dem, endrer du
 * modellens oppførsel.
 */
/**
 * MERK IMPORTEN: `zod/v4`, ikke `zod`.
 *
 * `zodOutputFormat()` i @anthropic-ai/sdk tar imot et zod v4-skjema. Skjemaet
 * her sendes rett inn dit, så det MÅ være v4. zod 3.25 leverer begge API-ene
 * side om side under hvert sitt inngangspunkt, så resten av kodebasen kan bli
 * stående på det klassiske API-et.
 *
 * Flytter du denne importen tilbake til "zod", slutter `messages.parse()` å
 * typesjekke - og verre: skjemaet blir ikke lenger det modellen faktisk får.
 */
import * as z from "zod/v4";

export const DOCUMENT_TYPES = [
  "receipt",
  "invoice",
  "credit_note",
  "order_confirmation",
  "payout_statement",
  "subscription_renewal",
  "not_a_voucher",
] as const;

export const VAT_CODES = [
  "standard_25",
  "food_15",
  "transport_12",
  "zero_0",
  "exempt",
  "reverse_charge",
  "outside_scope",
] as const;

/** Desimaltall som streng. LLM-er er upålitelige på flyttall, men pålitelige på siffer. */
const decimalString = z
  .string()
  .regex(/^-?\d+([.,]\d{1,4})?$/, "Må være et desimaltall, f.eks. \"1234.50\"")
  .nullable();

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Må være YYYY-MM-DD")
  .nullable();

export const extractedLineSchema = z.object({
  description: z.string().nullable(),
  quantity: decimalString,
  unitPrice: decimalString,
  netAmount: decimalString,
  vatRate: z.number().min(0).max(100).nullable(),
  vatAmount: decimalString,
  grossAmount: decimalString,
});

export const extractedCounterpartySchema = z.object({
  /** Selskapsnavnet slik det står i dokumentet, uten normalisering. */
  name: z.string().nullable(),
  /** ISO 3166-1 alfa-2. Utled fra adresse, valuta eller domene hvis det ikke står. */
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable(),
  orgNumber: z.string().nullable(),
  vatNumber: z.string().nullable(),
});

export const extractedDocumentSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES),

  /**
   * Retningen SETT FRA BRUKEREN. Dette er kjernen i Beatport-problemet:
   * samme leverandør kan gi både utgift (jeg kjøpte musikk) og inntekt
   * (jeg fikk utbetalt salg). Avgjør ut fra dokumentets innhold - hvem
   * betaler hvem - aldri ut fra leverandørnavnet.
   */
  direction: z.enum(["income", "expense", "unknown"]),

  /** Dokumentdato / kjøpsdato. Ikke forfallsdato. */
  issueDate: isoDate,
  dueDate: isoDate,

  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "ISO 4217")
    .nullable(),

  grossAmount: decimalString,
  netAmount: decimalString,
  vatAmount: decimalString,
  vatRate: z.number().min(0).max(100).nullable(),
  vatCode: z.enum(VAT_CODES).nullable(),

  counterparty: extractedCounterpartySchema,

  invoiceNumber: z.string().nullable(),
  orderNumber: z.string().nullable(),

  /** Én kort norsk setning som beskriver hva kjøpet gjelder. Vises i bilagslista. */
  description: z.string().nullable(),

  paymentMethod: z.string().nullable(),
  isPaid: z.boolean().nullable(),

  lines: z.array(extractedLineSchema).default([]),

  /**
   * Sikkerhet per felt, 0-1. Sett lavt når verdien er gjettet, utledet eller
   * uleselig. Lav score sender bilaget til gjennomgang - det er alltid bedre
   * enn å gjette.
   */
  fieldConfidence: z.record(z.string(), z.number().min(0).max(1)).default({}),

  /** Kort begrunnelse på norsk for retning og for felter du var usikker på. */
  notes: z.string().nullable(),
});

export type ExtractedDocument = z.infer<typeof extractedDocumentSchema>;
export type ExtractedLine = z.infer<typeof extractedLineSchema>;

/** Feltene som må være til stede for at et bilag skal kunne bokføres. */
export const REQUIRED_FIELDS = ["issueDate", "grossAmount", "currency", "direction"] as const;

/**
 * Samlet confidence. Vektet mot feltene som faktisk betyr noe regnskapsmessig -
 * feil beløp er alvorlig, manglende ordrenummer er det ikke.
 */
export const FIELD_WEIGHTS: Record<string, number> = {
  grossAmount: 3,
  issueDate: 2,
  direction: 2,
  currency: 1.5,
  "counterparty.name": 1.5,
  vatAmount: 1,
  vatRate: 1,
  netAmount: 0.5,
  description: 0.5,
};

export function overallConfidence(doc: ExtractedDocument): number {
  let weighted = 0;
  let total = 0;
  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    const score = doc.fieldConfidence[field];
    if (score === undefined) continue;
    weighted += score * weight;
    total += weight;
  }
  if (total === 0) return 0;

  let confidence = weighted / total;

  // Harde nedjusteringer: mangler et påkrevd felt er det ikke "ganske sikkert",
  // uansett hva modellen selv mener.
  for (const field of REQUIRED_FIELDS) {
    if (doc[field] === null || doc[field] === "unknown") confidence = Math.min(confidence, 0.4);
  }
  if (!doc.counterparty.name) confidence = Math.min(confidence, 0.6);

  return Math.round(confidence * 1000) / 1000;
}

/** Under denne grensa går bilaget rett i "krever gjennomgang"-køen. */
export const REVIEW_THRESHOLD = 0.8;
