/**
 * Kategorisering.
 *
 * Tre kilder, i denne rekkefølgen:
 *   1. Brukerlærte regler (fra korreksjoner) - høyest prioritet, for brukeren
 *      har allerede rettet dette én gang og skal ikke måtte gjøre det igjen.
 *   2. Profilregler lagret i databasen.
 *   3. Leverandørhint fra bransjeprofilen i koden.
 *
 * Funksjonen er ren: den tar reglene inn, den slår ikke opp noe selv. Det gjør
 * den testbar uten database og gjør det trivielt å vise brukeren HVORFOR et
 * bilag fikk kategorien det fikk.
 */
import type { CategoryRule } from "@qbikk/db";
import type { IndustryProfile, VendorHint } from "./profiles/types.js";
import { categoryByKey } from "./profiles/types.js";
import { normalizeCounterparty } from "./text.js";
import type { VatCode } from "./vat.js";
import { shouldReverseCharge } from "./vat.js";

export interface CategorizationInput {
  direction: "income" | "expense";
  counterpartyName: string | null;
  counterpartyCountry: string | null;
  description: string | null;
  senderDomain: string | null;
  vatAmount: number | null;
  vatRate: number | null;
  /** MVA-kode ekstraktoren selv foreslo, hvis den var sikker. */
  suggestedVatCode: VatCode | null;
}

export interface CategorizationResult {
  category: string;
  accountCode: string;
  vatCode: VatCode;
  reverseCharge: boolean;
  /** Hvor avgjørelsen kom fra - vises i UI som forklaring. */
  source: "user_rule" | "profile_rule" | "vendor_hint" | "fallback";
  matchedOn: string | null;
}

function ruleMatches(rule: CategoryRule, input: CategorizationInput): boolean {
  if (rule.direction && rule.direction !== input.direction) return false;

  switch (rule.matchType) {
    case "counterparty":
      return normalizeCounterparty(input.counterpartyName) === rule.matchValue;
    case "domain":
      return input.senderDomain === rule.matchValue;
    case "regex":
      try {
        return new RegExp(rule.matchValue, "i").test(
          `${input.counterpartyName ?? ""} ${input.description ?? ""}`,
        );
      } catch {
        return false; // ugyldig regex skal ikke velte importen
      }
    case "amount_range":
      return false; // håndteres av kalleren når beløp er relevant
    default:
      return false;
  }
}

function vendorMatches(hint: VendorHint, input: CategorizationInput): boolean {
  if (hint.matchType === "domain") return input.senderDomain === hint.match;
  const name = normalizeCounterparty(input.counterpartyName);
  if (!name) return false;
  // Delvis treff er med vilje tillatt: "beatport com" skal matche "beatport".
  return name === hint.match || name.startsWith(`${hint.match} `) || name.includes(` ${hint.match} `) || name.endsWith(` ${hint.match}`);
}

export function categorize(
  profile: IndustryProfile,
  rules: CategoryRule[],
  input: CategorizationInput,
): CategorizationResult {
  const reverseCharge = shouldReverseCharge({
    direction: input.direction,
    counterpartyCountry: input.counterpartyCountry,
    vatAmount: input.vatAmount,
    vatRate: input.vatRate,
  });

  // 1 + 2: databaseregler, allerede sortert på prioritet av kalleren.
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!ruleMatches(rule, input)) continue;
    const cat = categoryByKey(profile, rule.setCategory);
    return {
      category: rule.setCategory ?? cat?.key ?? fallbackKey(profile, input.direction),
      accountCode: rule.setAccountCode ?? cat?.accountCode ?? fallbackAccount(profile, input.direction),
      vatCode: resolveVatCode(rule.setVatCode as VatCode | null, cat?.defaultVatCode, input, reverseCharge),
      reverseCharge,
      source: rule.origin === "user_correction" ? "user_rule" : "profile_rule",
      matchedOn: rule.matchValue,
    };
  }

  // 3: leverandørhint fra profilen.
  for (const hint of profile.vendors) {
    if (!vendorMatches(hint, input)) continue;
    // Hintet velger kategori PER RETNING. Retningen kommer fra dokumentet.
    const key = input.direction === "income" ? hint.incomeCategory : hint.expenseCategory;
    if (!key) continue;
    const cat = categoryByKey(profile, key);
    const foreignDigital = hint.digitalService === true && (hint.country ?? "NO") !== "NO";
    return {
      category: key,
      accountCode: cat?.accountCode ?? fallbackAccount(profile, input.direction),
      vatCode: resolveVatCode(null, cat?.defaultVatCode, input, reverseCharge || (foreignDigital && input.direction === "expense" && !input.vatAmount)),
      reverseCharge: reverseCharge || (foreignDigital && input.direction === "expense" && !input.vatAmount),
      source: "vendor_hint",
      matchedOn: hint.match,
    };
  }

  const key = fallbackKey(profile, input.direction);
  const cat = categoryByKey(profile, key);
  return {
    category: key,
    accountCode: cat?.accountCode ?? fallbackAccount(profile, input.direction),
    vatCode: resolveVatCode(null, cat?.defaultVatCode, input, reverseCharge),
    reverseCharge,
    source: "fallback",
    matchedOn: null,
  };
}

/**
 * MVA-kode: det dokumentet faktisk viser vinner over det profilen antar.
 * En faktura med 15 % skal bokføres med 15 %, selv om kategorien normalt er 25 %.
 */
function resolveVatCode(
  ruleCode: VatCode | null,
  categoryDefault: VatCode | undefined,
  input: CategorizationInput,
  reverseCharge: boolean,
): VatCode {
  if (reverseCharge) return "reverse_charge";
  if (input.suggestedVatCode) return input.suggestedVatCode;
  if (ruleCode) return ruleCode;
  if (categoryDefault && categoryDefault !== "reverse_charge") return categoryDefault;
  return "standard_25";
}

function fallbackKey(profile: IndustryProfile, direction: "income" | "expense"): string {
  return direction === "income" ? profile.fallbackIncomeCategory : profile.fallbackExpenseCategory;
}

function fallbackAccount(profile: IndustryProfile, direction: "income" | "expense"): string {
  const cat = categoryByKey(profile, fallbackKey(profile, direction));
  return cat?.accountCode ?? (direction === "income" ? "3000" : "6790");
}

/**
 * Bygger en regel av en brukerkorreksjon, slik at samme leverandør havner
 * riktig neste gang. Prioritet 10 gjør at den slår alle profilregler.
 */
export function ruleFromCorrection(input: {
  userId: string;
  counterpartyName: string | null;
  senderDomain: string | null;
  direction: "income" | "expense";
  category: string | null;
  accountCode: string | null;
  vatCode: VatCode | null;
}): {
  userId: string;
  priority: number;
  matchType: "counterparty" | "domain";
  matchValue: string;
  direction: "income" | "expense";
  setCategory: string | null;
  setAccountCode: string | null;
  setVatCode: VatCode | null;
  origin: "user_correction";
} | null {
  const name = normalizeCounterparty(input.counterpartyName);
  const matchValue = name || input.senderDomain;
  if (!matchValue) return null;
  return {
    userId: input.userId,
    priority: 10,
    matchType: name ? "counterparty" : "domain",
    matchValue,
    // Regelen bindes til retningen den ble lært i - ellers ville en korreksjon
    // på et Beatport-KJØP også endret kategorien på Beatport-UTBETALINGER.
    direction: input.direction,
    setCategory: input.category,
    setAccountCode: input.accountCode,
    setVatCode: input.vatCode,
    origin: "user_correction",
  };
}
