/**
 * Bransjeprofiler.
 *
 * En profil er REN DATA. Den styrer kategorisett, kontoplan-mapping og hvilke
 * leverandører systemet forventer å se. Den styrer IKKE hvilke tekniske
 * integrasjoner som finnes, og den har ingen egen kodevei: en DJ og en frisør
 * går gjennom nøyaktig samme ekstraksjon, normalisering, dedup og matching.
 * Se `profiles.test.ts` - den testen finnes for å hindre at noen bryter dette.
 *
 * Leverandørhintene setter aldri `direction`. Retning avgjøres av dokumentet.
 * Beatport er utgift når du kjøper musikk og inntekt når de utbetaler salg;
 * navnet alene sier ingenting.
 */
import type { VatCode } from "../vat.js";

export interface CategoryDef {
  key: string;
  label: string;
  /** Null = kategorien kan brukes begge veier. */
  direction: "income" | "expense" | null;
  /** NS 4102-konto. */
  accountCode: string;
  defaultVatCode: VatCode;
  hint?: string;
}

export interface VendorHint {
  /** Normalisert motpartsnavn eller e-postdomene. Se normalizeCounterparty(). */
  match: string;
  matchType: "counterparty" | "domain";
  /** Kategori når retningen er utgift. */
  expenseCategory?: string;
  /** Kategori når retningen er inntekt. Satt på leverandører som kan gå begge veier. */
  incomeCategory?: string;
  country?: string;
  /** Fjernleverbar tjeneste fra utlandet -> kandidat for omvendt avgiftsplikt. */
  digitalService?: boolean;
  note?: string;
}

export interface IndustryProfile {
  key: string;
  label: string;
  description: string;
  categories: CategoryDef[];
  vendors: VendorHint[];
  /** Kategori som brukes når ingenting matcher. */
  fallbackIncomeCategory: string;
  fallbackExpenseCategory: string;
}

export function categoryByKey(profile: IndustryProfile, key: string | null | undefined): CategoryDef | undefined {
  if (!key) return undefined;
  return profile.categories.find((c) => c.key === key);
}
