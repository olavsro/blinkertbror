/**
 * Penger som heltall i minste enhet (øre/cent). Aldri float i regnskap.
 *
 * All lagring og all aritmetikk går gjennom disse funksjonene. LLM-en får
 * levere desimaltall som streng - `parseAmount` er det eneste stedet en
 * desimalstreng blir til et tall.
 */

/** Beløp i minste enhet. Nominell type så det ikke forveksles med kroner. */
export type Minor = number & { readonly __brand: "minor" };

export const minor = (n: number): Minor => {
  if (!Number.isFinite(n)) throw new Error(`Ugyldig beløp: ${n}`);
  return Math.round(n) as Minor;
};

/** Valutaer uten desimaler. JPY 1000 = 1000 minor, ikke 100000. */
const ZERO_DECIMAL = new Set(["JPY", "KRW", "ISK", "CLP", "VND"]);

export function decimalsFor(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

/**
 * Tolker beløp fra dokumenter. Tåler formatene vi faktisk ser i norske og
 * internasjonale kvitteringer:
 *   "1 234,56"  "1.234,56"  "1,234.56"  "kr 349,-"  "349"  "-99.00"  "349.00 NOK"
 */
export function parseAmount(input: string | number | null | undefined, currency = "NOK"): Minor | null {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input === "number") {
    return minor(input * 10 ** decimalsFor(currency));
  }

  let s = input.trim().replace(/[ \s]/g, "");
  s = s.replace(/^(kr|nok|usd|eur|gbp|sek|dkk|\$|€|£)/i, "");
  s = s.replace(/(kr|nok|usd|eur|gbp|sek|dkk)$/i, "");
  s = s.replace(/,-$/, ""); // norsk "349,-"
  s = s.replace(/[^0-9.,-]/g, "");
  if (s === "" || s === "-") return null;

  const negative = s.startsWith("-");
  if (negative) s = s.slice(1);

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  let normalized: string;
  if (lastComma === -1 && lastDot === -1) {
    normalized = s;
  } else if (lastComma > lastDot) {
    // komma er desimalskilletegn: "1.234,56"
    normalized = s.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma) {
    // punktum er desimalskilletegn: "1,234.56"
    normalized = s.replace(/,/g, "");
  } else {
    normalized = s;
  }

  // "1.234" uten desimaler: tre siffer etter skilletegnet = tusenskille, ikke desimaler.
  const parts = normalized.split(".");
  if (parts.length === 2 && parts[1]!.length === 3 && lastComma === -1) {
    normalized = parts.join("");
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  const result = minor(value * 10 ** decimalsFor(currency));
  return (negative ? -result : result) as Minor;
}

/** Formaterer for visning: 34900 -> "349,00". */
export function formatAmount(amount: Minor | number, currency = "NOK", locale = "nb-NO"): string {
  const d = decimalsFor(currency);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  }).format(amount / 10 ** d);
}

/** Uten valutasymbol - til tabeller der kolonnen allerede sier valutaen. */
export function formatPlain(amount: Minor | number, currency = "NOK", locale = "nb-NO"): string {
  const d = decimalsFor(currency);
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  }).format(amount / 10 ** d);
}

export const abs = (a: Minor | number): Minor => Math.abs(a) as Minor;
export const add = (a: Minor | number, b: Minor | number): Minor => (a + b) as Minor;
export const sub = (a: Minor | number, b: Minor | number): Minor => (a - b) as Minor;

/** Multiplikasjon med avrunding halvveis-opp - den eneste avrundingsregelen vi bruker. */
export function mulRate(amount: Minor | number, rate: number): Minor {
  return Math.round(amount * rate) as Minor;
}

/** Andel av et beløp, f.eks. MVA-uttrekk. Alltid avrundet til hele øre. */
export function percentOf(amount: Minor | number, percent: number): Minor {
  return Math.round((amount * percent) / 100) as Minor;
}
