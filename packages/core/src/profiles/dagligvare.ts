import type { IndustryProfile } from "./types.js";

/**
 * Dagligvare / kiosk.
 *
 * Bransjen som virkelig trenger MVA per linje: samme kvittering fra grossisten
 * blander 15 % (næringsmidler) og 25 % (vaskemidler, tobakk, emballasje).
 * Derfor er `voucher_lines` ikke valgfritt her - totalen alene er ikke nok
 * til å fylle ut MVA-meldingen riktig.
 */
export const dagligvareProfile: IndustryProfile = {
  key: "dagligvare",
  label: "Dagligvare / kiosk",
  description: "Varesalg med blandet MVA-sats, grossistkjøp og butikkdrift.",

  categories: [
    {
      key: "food_sales",
      label: "Salg næringsmidler",
      direction: "income",
      accountCode: "3000",
      defaultVatCode: "food_15",
      hint: "Mat og drikke til å ta med. 15 %.",
    },
    {
      key: "other_sales",
      label: "Salg øvrige varer",
      direction: "income",
      accountCode: "3000",
      defaultVatCode: "standard_25",
      hint: "Tobakk, alkohol, husholdningsartikler, servering på stedet. 25 %.",
    },
    {
      key: "deposit_income",
      label: "Pant",
      direction: "income",
      accountCode: "3000",
      defaultVatCode: "standard_25",
    },
    {
      key: "food_purchase",
      label: "Varekjøp næringsmidler",
      direction: "expense",
      accountCode: "4300",
      defaultVatCode: "food_15",
    },
    {
      key: "other_purchase",
      label: "Varekjøp øvrig",
      direction: "expense",
      accountCode: "4300",
      defaultVatCode: "standard_25",
    },
    { key: "rent", label: "Lokalleie", direction: "expense", accountCode: "6300", defaultVatCode: "standard_25" },
    { key: "utilities", label: "Strøm", direction: "expense", accountCode: "6340", defaultVatCode: "standard_25" },
    { key: "wages", label: "Lønn", direction: "expense", accountCode: "5000", defaultVatCode: "outside_scope" },
    {
      key: "waste",
      label: "Renovasjon",
      direction: "expense",
      accountCode: "6395",
      defaultVatCode: "standard_25",
    },
    {
      key: "pos_software",
      label: "Kassesystem",
      direction: "expense",
      accountCode: "6810",
      defaultVatCode: "standard_25",
    },
    { key: "bank_fees", label: "Bank- og kortgebyr", direction: "expense", accountCode: "7770", defaultVatCode: "exempt" },
    { key: "other_expense", label: "Annen driftskostnad", direction: "expense", accountCode: "6790", defaultVatCode: "standard_25" },
  ],

  vendors: [
    { match: "asko", matchType: "counterparty", expenseCategory: "food_purchase", country: "NO" },
    { match: "bama", matchType: "counterparty", expenseCategory: "food_purchase", country: "NO" },
    { match: "tine", matchType: "counterparty", expenseCategory: "food_purchase", country: "NO" },
    { match: "nortura", matchType: "counterparty", expenseCategory: "food_purchase", country: "NO" },
    { match: "ringnes", matchType: "counterparty", expenseCategory: "other_purchase", country: "NO" },
    { match: "coca cola", matchType: "counterparty", expenseCategory: "other_purchase", country: "NO" },
    { match: "servicegrossistene", matchType: "counterparty", expenseCategory: "food_purchase", country: "NO" },
    { match: "infinitum", matchType: "counterparty", incomeCategory: "deposit_income", country: "NO" },
    { match: "nets", matchType: "counterparty", expenseCategory: "bank_fees", country: "NO" },
    { match: "elvia", matchType: "counterparty", expenseCategory: "utilities", country: "NO" },
  ],

  fallbackIncomeCategory: "other_sales",
  fallbackExpenseCategory: "other_expense",
};
