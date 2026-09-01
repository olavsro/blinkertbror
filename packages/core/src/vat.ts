/**
 * Norsk merverdiavgift.
 *
 * Satser (2026): 25 % alminnelig, 15 % næringsmidler, 12 % lav sats
 * (persontransport, overnatting, kino, museum), 0 % nullsats (aviser, bøker,
 * elbil-relatert, eksport) og "fritatt/utenfor loven" (helse, undervisning,
 * finans - ingen MVA og ingen fradrag).
 *
 * Omvendt avgiftsplikt: ved kjøp av fjernleverbare tjenester fra utlandet
 * (Beatport, Bandcamp, Spotify, Adobe, AWS) beregner KJØPER 25 % utgående MVA
 * og fører samme beløp som inngående. Selger fakturerer uten MVA. Dette må
 * flagges på bilaget - det er en av de vanligste feilene i småbedrifter.
 */
import type { Minor } from "./money.js";
import { percentOf, minor } from "./money.js";

export type VatCode =
  | "standard_25"
  | "food_15"
  | "transport_12"
  | "zero_0"
  | "exempt"
  | "reverse_charge"
  | "outside_scope";

export const VAT_RATES: Record<VatCode, number> = {
  standard_25: 25,
  food_15: 15,
  transport_12: 12,
  zero_0: 0,
  exempt: 0,
  reverse_charge: 25, // beregnet av kjøper, ikke betalt til selger
  outside_scope: 0,
};

export const VAT_LABELS: Record<VatCode, string> = {
  standard_25: "25 % alminnelig",
  food_15: "15 % næringsmidler",
  transport_12: "12 % lav sats",
  zero_0: "0 % nullsats",
  exempt: "Fritatt",
  reverse_charge: "Omvendt avgiftsplikt (25 %)",
  outside_scope: "Utenfor MVA-loven",
};

/** Nærmeste gyldige norske sats. Ukjente satser gir null i stedet for gjetning. */
export function vatCodeFromRate(rate: number | null | undefined): VatCode | null {
  if (rate === null || rate === undefined) return null;
  const r = Math.round(rate * 100) / 100;
  if (Math.abs(r - 25) < 0.51) return "standard_25";
  if (Math.abs(r - 15) < 0.51) return "food_15";
  if (Math.abs(r - 12) < 0.51) return "transport_12";
  if (r === 0) return "zero_0";
  return null;
}

export interface VatSplit {
  net: Minor;
  vat: Minor;
  gross: Minor;
  rate: number;
  code: VatCode;
}

/** Splitter et bruttobeløp i netto og MVA. Brutto er det vi nesten alltid får fra en kvittering. */
export function splitFromGross(gross: Minor | number, code: VatCode): VatSplit {
  const rate = VAT_RATES[code];
  if (code === "reverse_charge" || rate === 0) {
    // Ved omvendt avgiftsplikt er fakturabeløpet netto. MVA beregnes i tillegg
    // og nulles ut mot fradraget, så bilagets brutto forblir uendret.
    return { net: minor(gross), vat: minor(0), gross: minor(gross), rate: 0, code };
  }
  const net = Math.round(gross / (1 + rate / 100)) as Minor;
  const vat = (gross - net) as Minor;
  return { net, vat, gross: minor(gross), rate, code };
}

/** Splitter et nettobeløp - brukes når fakturaen viser eks. mva. */
export function splitFromNet(net: Minor | number, code: VatCode): VatSplit {
  const rate = VAT_RATES[code];
  if (code === "reverse_charge" || rate === 0) {
    return { net: minor(net), vat: minor(0), gross: minor(net), rate: 0, code };
  }
  const vat = percentOf(net, rate);
  return { net: minor(net), vat, gross: (net + vat) as Minor, rate, code };
}

/**
 * Beløpet som skal rapporteres som utgående OG inngående MVA ved
 * omvendt avgiftsplikt. Netto = fakturabeløpet.
 */
export function reverseChargeVat(net: Minor | number): Minor {
  return percentOf(net, 25);
}

/** EØS/EU + typiske digitale leverandørland. Brukes bare til flagging, ikke til bokføring. */
export function isForeign(country: string | null | undefined): boolean {
  if (!country) return false;
  return country.toUpperCase() !== "NO";
}

/**
 * Avgjør om et kjøp utløser omvendt avgiftsplikt.
 * Regelen her er bevisst konservativ: den FLAGGER, den bokfører ikke.
 * Alt som flagges havner synlig i MVA-oppsummeringen for gjennomgang.
 */
export function shouldReverseCharge(input: {
  direction: "income" | "expense";
  counterpartyCountry: string | null | undefined;
  vatAmount: Minor | number | null | undefined;
  vatRate: number | null | undefined;
}): boolean {
  if (input.direction !== "expense") return false;
  if (!isForeign(input.counterpartyCountry)) return false;
  // Har selger fakturert norsk MVA, er det ikke omvendt avgiftsplikt.
  if (input.vatAmount && input.vatAmount > 0) return false;
  if (input.vatRate && input.vatRate > 0) return false;
  return true;
}

export interface VatPeriodSummary {
  /** MVA-termin: 1-6 (annenhver måned) eller "year" for årsterminoppgave. */
  term: string;
  from: string;
  to: string;
  outgoing: Record<string, Minor>;
  incoming: Record<string, Minor>;
  reverseChargeBase: Minor;
  reverseChargeVat: Minor;
  net: Minor;
}

/** Norske MVA-terminer: jan-feb = 1, mar-apr = 2, ... nov-des = 6. */
export function vatTermFor(date: Date | string): { term: number; from: string; to: string } {
  const d = typeof date === "string" ? new Date(date + "T00:00:00Z") : date;
  const month = d.getUTCMonth(); // 0-11
  const term = Math.floor(month / 2) + 1;
  const year = d.getUTCFullYear();
  const startMonth = (term - 1) * 2;
  const from = new Date(Date.UTC(year, startMonth, 1));
  const to = new Date(Date.UTC(year, startMonth + 2, 0));
  return {
    term,
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}
