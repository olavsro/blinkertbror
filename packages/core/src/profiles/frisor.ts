import type { IndustryProfile } from "./types.js";

/**
 * Frisør.
 *
 * Helt andre leverandører enn DJ-en, helt samme kodevei. Det som skiller er
 * bare denne fila: kategorier, kontoer og forventede grossister.
 *
 * Én ting er egen for bransjen: produkter kjøpes inn både til bruk i salongen
 * (forbruksmateriell, konto 6560) og for videresalg over disk (konto 4300).
 * Skillet går på hva dokumentet sier, ikke på hvem som er leverandør, så begge
 * kategoriene peker på de samme grossistene.
 */
export const frisorProfile: IndustryProfile = {
  key: "frisor",
  label: "Frisør",
  description: "Behandlinger, produktsalg, grossistkjøp og salongdrift.",

  categories: [
    {
      key: "treatment_income",
      label: "Behandling",
      direction: "income",
      accountCode: "3000",
      defaultVatCode: "standard_25",
      hint: "Klipp, farge, styling. Frisørtjenester har alminnelig sats.",
    },
    {
      key: "product_sales_income",
      label: "Produktsalg",
      direction: "income",
      accountCode: "3000",
      defaultVatCode: "standard_25",
      hint: "Sjampo og stylingprodukter solgt over disk.",
    },
    {
      key: "chair_rent_income",
      label: "Stolleie",
      direction: "income",
      accountCode: "3600",
      defaultVatCode: "standard_25",
      hint: "Utleie av stol til selvstendig frisør.",
    },
    {
      key: "goods_for_resale",
      label: "Varer for videresalg",
      direction: "expense",
      accountCode: "4300",
      defaultVatCode: "standard_25",
      hint: "Produkter som skal selges videre til kunden.",
    },
    {
      key: "salon_supplies",
      label: "Forbruksmateriell",
      direction: "expense",
      accountCode: "6560",
      defaultVatCode: "standard_25",
      hint: "Farge, folie, håndklær, hansker - brukes opp i salongen.",
    },
    {
      key: "equipment",
      label: "Utstyr og inventar",
      direction: "expense",
      accountCode: "6540",
      defaultVatCode: "standard_25",
      hint: "Sakser, klippemaskiner, stoler, tørkehjelmer.",
    },
    {
      key: "rent",
      label: "Lokalleie",
      direction: "expense",
      accountCode: "6300",
      defaultVatCode: "standard_25",
    },
    {
      key: "utilities",
      label: "Strøm og kommunale avgifter",
      direction: "expense",
      accountCode: "6340",
      defaultVatCode: "standard_25",
    },
    {
      key: "booking_software",
      label: "Timebok og kassesystem",
      direction: "expense",
      accountCode: "6810",
      defaultVatCode: "standard_25",
      hint: "Fresha, Timma, kassaløsning, kortterminal-abonnement.",
    },
    {
      key: "education",
      label: "Kurs og faglig oppdatering",
      direction: "expense",
      accountCode: "6860",
      defaultVatCode: "standard_25",
    },
    {
      key: "marketing",
      label: "Markedsføring",
      direction: "expense",
      accountCode: "7320",
      defaultVatCode: "standard_25",
    },
    {
      key: "bank_fees",
      label: "Bank- og kortgebyr",
      direction: "expense",
      accountCode: "7770",
      defaultVatCode: "exempt",
      hint: "Terminalgebyr fra Nets, Vipps, Zettle.",
    },
    {
      key: "other_expense",
      label: "Annen driftskostnad",
      direction: "expense",
      accountCode: "6790",
      defaultVatCode: "standard_25",
    },
  ],

  vendors: [
    // Grossister: kan gi både videresalgsvarer og forbruksmateriell.
    // Dokumentets varelinjer avgjør hvilken kategori, ikke leverandørnavnet.
    { match: "loreal", matchType: "counterparty", expenseCategory: "goods_for_resale", country: "NO" },
    { match: "l oreal", matchType: "counterparty", expenseCategory: "goods_for_resale", country: "NO" },
    { match: "wella", matchType: "counterparty", expenseCategory: "goods_for_resale", country: "NO" },
    { match: "schwarzkopf", matchType: "counterparty", expenseCategory: "goods_for_resale", country: "NO" },
    { match: "kao", matchType: "counterparty", expenseCategory: "goods_for_resale", country: "NO" },
    { match: "nordic hair", matchType: "counterparty", expenseCategory: "goods_for_resale", country: "NO" },
    { match: "skjonnhetsgrossisten", matchType: "counterparty", expenseCategory: "salon_supplies", country: "NO" },
    { match: "frisorgrossisten", matchType: "counterparty", expenseCategory: "salon_supplies", country: "NO" },
    { match: "olivia", matchType: "counterparty", expenseCategory: "salon_supplies", country: "NO" },

    // Drift
    { match: "fresha", matchType: "counterparty", expenseCategory: "booking_software", country: "GB", digitalService: true },
    { match: "timma", matchType: "counterparty", expenseCategory: "booking_software", country: "NO" },
    { match: "bestilltime", matchType: "counterparty", expenseCategory: "booking_software", country: "NO" },
    { match: "nets", matchType: "counterparty", expenseCategory: "bank_fees", country: "NO" },
    { match: "zettle", matchType: "counterparty", expenseCategory: "bank_fees", incomeCategory: "treatment_income", country: "SE" },
    { match: "vipps", matchType: "counterparty", expenseCategory: "bank_fees", incomeCategory: "treatment_income", country: "NO" },
    { match: "hafslund", matchType: "counterparty", expenseCategory: "utilities", country: "NO" },
    { match: "fortum", matchType: "counterparty", expenseCategory: "utilities", country: "NO" },
    { match: "elvia", matchType: "counterparty", expenseCategory: "utilities", country: "NO" },
  ],

  fallbackIncomeCategory: "treatment_income",
  fallbackExpenseCategory: "other_expense",
};
