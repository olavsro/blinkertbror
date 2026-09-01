/**
 * Valutaomregning med Norges Banks kurs.
 *
 * Regnskapsregelen: beløp i utenlandsk valuta omregnes med kursen på
 * transaksjonsdatoen, og BÅDE kursen og kursdatoen lagres på bilaget. Da kan
 * regnskapsfører og Skatteetaten etterprøve tallet uten å slå opp på nytt -
 * og tallet endrer seg ikke om vi kjører ekstraksjonen om igjen om to år.
 *
 * Norges Bank publiserer bare på virkedager. Faller kjøpet på en lørdag,
 * brukes siste noterte kurs før datoen, og `rateDate` viser hvilken.
 */
import { getDb, fxRates, and, eq, lte, desc } from "@qbikk/db";
import { decimalsFor, type Minor } from "./money.js";

const NB_API = "https://data.norges-bank.no/api/data/EXR";

export interface FxRate {
  currency: string;
  /** Antall NOK for én enhet av valutaen. */
  rate: number;
  /** Datoen kursen faktisk er notert - kan være tidligere enn den forespurte. */
  rateDate: string;
  source: string;
}

const NOK_RATE: FxRate = { currency: "NOK", rate: 1, rateDate: "", source: "identity" };

/** Henter et sett kurser fra Norges Bank og returnerer siste notering i intervallet. */
async function fetchFromNorgesBank(currency: string, from: string, to: string): Promise<FxRate | null> {
  const url = `${NB_API}/B.${currency}.NOK.SP?format=csv&startPeriod=${from}&endPeriod=${to}&locale=en`;
  const res = await fetch(url, { headers: { accept: "text/csv" } });
  if (!res.ok) {
    if (res.status === 404) return null; // ukjent valuta
    throw new Error(`Norges Bank svarte ${res.status} for ${currency}`);
  }
  const csv = await res.text();
  return parseNorgesBankCsv(csv, currency);
}

/**
 * Norges Bank leverer semikolonseparert CSV. Vi leser kolonnene etter navn,
 * ikke posisjon, siden kolonnesettet har endret seg før.
 */
export function parseNorgesBankCsv(csv: string, currency: string): FxRate | null {
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;

  const delimiter = (lines[0]!.match(/;/g)?.length ?? 0) > (lines[0]!.match(/,/g)?.length ?? 0) ? ";" : ",";
  const header = splitCsvLine(lines[0]!, delimiter).map((h) => h.replace(/^"|"$/g, "").trim().toUpperCase());

  const timeIdx = header.indexOf("TIME_PERIOD");
  const valueIdx = header.indexOf("OBS_VALUE");
  const multIdx = header.indexOf("UNIT_MULT");
  if (timeIdx === -1 || valueIdx === -1) return null;

  let latest: FxRate | null = null;
  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line, delimiter).map((c) => c.replace(/^"|"$/g, "").trim());
    const date = cols[timeIdx];
    const rawValue = cols[valueIdx];
    if (!date || !rawValue) continue;

    const value = Number(rawValue.replace(",", "."));
    if (!Number.isFinite(value)) continue;

    // UNIT_MULT=2 betyr at kursen er notert per 100 enheter (typisk SEK, DKK, JPY).
    const mult = multIdx >= 0 ? Number(cols[multIdx] ?? "0") : 0;
    const rate = value / 10 ** (Number.isFinite(mult) ? mult : 0);

    if (!latest || date > latest.rateDate) {
      latest = { currency, rate, rateDate: date, source: "norges-bank" };
    }
  }
  return latest;
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Kurs for valuta på dato, med cache i `fx_rates`.
 *
 * Rekkefølge: (1) eksakt treff i cache, (2) siste cachede kurs innenfor 10
 * dager før datoen, (3) Norges Bank. Cachen gjør at et bilag alltid får
 * samme kurs ved reekstraksjon.
 */
export async function getRate(currency: string, date: string): Promise<FxRate> {
  const cur = currency.toUpperCase();
  if (cur === "NOK") return { ...NOK_RATE, rateDate: date };

  const db = getDb();

  const [exact] = await db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.currency, cur), eq(fxRates.rateDate, date)))
    .limit(1);
  if (exact) return { currency: cur, rate: Number(exact.rate), rateDate: exact.rateDate, source: exact.source };

  const windowStart = addDays(date, -10);
  const fetched = await fetchFromNorgesBank(cur, windowStart, date).catch((err: unknown) => {
    // Nettverksfeil skal ikke stoppe importen - vi faller tilbake på cache.
    console.warn(`[fx] kunne ikke hente ${cur} ${date}:`, err instanceof Error ? err.message : err);
    return null;
  });

  if (fetched) {
    await db
      .insert(fxRates)
      .values({
        currency: cur,
        rateDate: fetched.rateDate,
        rate: String(fetched.rate),
        source: fetched.source,
      })
      .onConflictDoNothing();
    return fetched;
  }

  const [nearest] = await db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.currency, cur), lte(fxRates.rateDate, date)))
    .orderBy(desc(fxRates.rateDate))
    .limit(1);
  if (nearest) {
    return { currency: cur, rate: Number(nearest.rate), rateDate: nearest.rateDate, source: nearest.source };
  }

  throw new Error(`Fant ingen kurs for ${cur} på eller før ${date}`);
}

export interface ConvertedAmount {
  amountNok: Minor;
  exchangeRate: number;
  rateDate: string;
}

/**
 * Omregner et beløp i minste enhet til ØRE NOK.
 *
 * Merk skaleringen: JPY har null desimaler, så 1000 JPY er 1000 minor units,
 * mens 1000 NOK er 100 000 øre. Vi går derfor via hele enheter før vi ganger
 * med kursen.
 */
export async function convertToNok(amount: Minor | number, currency: string, date: string): Promise<ConvertedAmount> {
  const cur = currency.toUpperCase();
  if (cur === "NOK") return { amountNok: amount as Minor, exchangeRate: 1, rateDate: date };
  const rate = await getRate(cur, date);
  const majorUnits = amount / 10 ** decimalsFor(cur);
  return {
    amountNok: Math.round(majorUnits * rate.rate * 100) as Minor,
    exchangeRate: rate.rate,
    rateDate: rate.rateDate,
  };
}
