import type { IndustryProfile } from "./types.js";
import { djProfile } from "./dj.js";
import { frisorProfile } from "./frisor.js";
import { dagligvareProfile } from "./dagligvare.js";

/** Profil for brukere som ikke har valgt bransje. Bare de universelle kategoriene. */
export const genericProfile: IndustryProfile = {
  key: "generic",
  label: "Generell næringsdrivende",
  description: "Nøytralt kategorisett uten bransjeantakelser.",
  categories: [
    { key: "sales_income", label: "Salgsinntekt", direction: "income", accountCode: "3000", defaultVatCode: "standard_25" },
    { key: "other_income", label: "Annen inntekt", direction: "income", accountCode: "3900", defaultVatCode: "exempt" },
    { key: "goods", label: "Varekjøp", direction: "expense", accountCode: "4300", defaultVatCode: "standard_25" },
    { key: "software_subscription", label: "Programvare og lisenser", direction: "expense", accountCode: "6810", defaultVatCode: "reverse_charge" },
    { key: "equipment", label: "Utstyr og inventar", direction: "expense", accountCode: "6540", defaultVatCode: "standard_25" },
    { key: "office", label: "Kontorrekvisita", direction: "expense", accountCode: "6800", defaultVatCode: "standard_25" },
    { key: "travel", label: "Reise", direction: "expense", accountCode: "7140", defaultVatCode: "transport_12" },
    { key: "marketing", label: "Markedsføring", direction: "expense", accountCode: "7320", defaultVatCode: "standard_25" },
    { key: "bank_fees", label: "Bank- og kortgebyr", direction: "expense", accountCode: "7770", defaultVatCode: "exempt" },
    { key: "other_expense", label: "Annen driftskostnad", direction: "expense", accountCode: "6790", defaultVatCode: "standard_25" },
  ],
  vendors: [
    { match: "adobe", matchType: "counterparty", expenseCategory: "software_subscription", country: "IE", digitalService: true },
    { match: "microsoft", matchType: "counterparty", expenseCategory: "software_subscription", country: "IE", digitalService: true },
    { match: "google", matchType: "counterparty", expenseCategory: "software_subscription", country: "IE", digitalService: true },
    { match: "amazon web services", matchType: "counterparty", expenseCategory: "software_subscription", country: "LU", digitalService: true },
    { match: "vipps", matchType: "counterparty", expenseCategory: "bank_fees", country: "NO" },
  ],
  fallbackIncomeCategory: "sales_income",
  fallbackExpenseCategory: "other_expense",
};

export const PROFILES: Record<string, IndustryProfile> = {
  generic: genericProfile,
  dj: djProfile,
  frisor: frisorProfile,
  dagligvare: dagligvareProfile,
};

export function getProfile(key: string | null | undefined): IndustryProfile {
  return PROFILES[key ?? "generic"] ?? genericProfile;
}

export * from "./types.js";
export { djProfile, frisorProfile, dagligvareProfile };
