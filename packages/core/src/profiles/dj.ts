import type { IndustryProfile } from "./types.js";

/**
 * DJ / artist.
 *
 * Det interessante caset: Beatport og Bandcamp går begge veier. Kjøper du
 * musikk er det utgift, får du utbetalt salg er det inntekt. Derfor har de
 * både `expenseCategory` og `incomeCategory`, og profilen sier ingenting om
 * hvilken som gjelder - det avgjør dokumentet.
 *
 * Spotify, Tidal og SoundCloud er derimot rene abonnementsutgifter, selv om
 * en DJ også kan ha inntekter fra streaming. De inntektene kommer fra
 * distributøren (DistroKid, TuneCore), ikke fra plattformen.
 */
export const djProfile: IndustryProfile = {
  key: "dj",
  label: "DJ / artist",
  description: "Spillejobber, musikkjøp, streaming-abonnement og utstyr.",

  categories: [
    {
      key: "gig_income",
      label: "Spillejobb",
      direction: "income",
      accountCode: "3000",
      defaultVatCode: "standard_25",
      hint: "Honorar for opptreden. MVA-pliktig når du er registrert.",
    },
    {
      key: "royalty_income",
      label: "Royalty / streaming-utbetaling",
      direction: "income",
      accountCode: "3100",
      defaultVatCode: "zero_0",
      hint: "Utbetaling fra distributør eller plattform. Ofte fra utlandet - avgiftsfri eksport.",
    },
    {
      key: "music_sales_income",
      label: "Salg av musikk",
      direction: "income",
      accountCode: "3000",
      defaultVatCode: "standard_25",
      hint: "Beatport/Bandcamp-utbetaling for egne utgivelser.",
    },
    {
      key: "music_purchase",
      label: "Kjøp av musikk",
      direction: "expense",
      accountCode: "6560",
      defaultVatCode: "reverse_charge",
      hint: "Nedlastinger fra Beatport, Bandcamp, Traxsource. Fra utlandet = omvendt avgiftsplikt.",
    },
    {
      key: "streaming_subscription",
      label: "Streaming-abonnement",
      direction: "expense",
      accountCode: "6810",
      defaultVatCode: "reverse_charge",
      hint: "Spotify, Tidal, SoundCloud Go, Apple Music.",
    },
    {
      key: "software_subscription",
      label: "Programvare og lisenser",
      direction: "expense",
      accountCode: "6810",
      defaultVatCode: "reverse_charge",
      hint: "Ableton, Serato, Splice, Adobe, skylagring.",
    },
    {
      key: "equipment",
      label: "Utstyr",
      direction: "expense",
      accountCode: "6540",
      defaultVatCode: "standard_25",
      hint: "Kontrollere, hodetelefoner, kabler. Over 30 000 kr skal aktiveres, ikke kostnadsføres.",
    },
    {
      key: "travel",
      label: "Reise til jobb",
      direction: "expense",
      accountCode: "7140",
      defaultVatCode: "transport_12",
      hint: "Tog, fly, taxi til og fra spillejobb. Persontransport har 12 %.",
    },
    {
      key: "accommodation",
      label: "Overnatting",
      direction: "expense",
      accountCode: "7140",
      defaultVatCode: "transport_12",
    },
    {
      key: "marketing",
      label: "Markedsføring",
      direction: "expense",
      accountCode: "7320",
      defaultVatCode: "standard_25",
      hint: "Annonser, promo, coverdesign, fotograf.",
    },
    {
      key: "membership",
      label: "Kontingent og rettighetsorganisasjoner",
      direction: "expense",
      accountCode: "7420",
      defaultVatCode: "exempt",
      hint: "TONO, Gramo, forbund.",
    },
    {
      key: "bank_fees",
      label: "Bank- og betalingsgebyr",
      direction: "expense",
      accountCode: "7770",
      defaultVatCode: "exempt",
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
    // --- Går begge veier. Retningen avgjøres av dokumentet, ikke av navnet. ---
    {
      match: "beatport",
      matchType: "counterparty",
      expenseCategory: "music_purchase",
      incomeCategory: "music_sales_income",
      country: "US",
      digitalService: true,
      note: "Kjøp av musikk = utgift. Label-utbetaling = inntekt. Sjekk dokumentet.",
    },
    {
      match: "bandcamp",
      matchType: "counterparty",
      expenseCategory: "music_purchase",
      incomeCategory: "music_sales_income",
      country: "US",
      digitalService: true,
      note: "Samme som Beatport: kan være begge deler.",
    },
    {
      match: "traxsource",
      matchType: "counterparty",
      expenseCategory: "music_purchase",
      incomeCategory: "music_sales_income",
      country: "US",
      digitalService: true,
    },

    // --- Rene abonnementsutgifter ---
    { match: "spotify", matchType: "counterparty", expenseCategory: "streaming_subscription", country: "SE", digitalService: true },
    { match: "tidal", matchType: "counterparty", expenseCategory: "streaming_subscription", country: "NO" },
    { match: "soundcloud", matchType: "counterparty", expenseCategory: "streaming_subscription", country: "DE", digitalService: true },
    { match: "apple", matchType: "counterparty", expenseCategory: "streaming_subscription", country: "IE", digitalService: true },

    { match: "ableton", matchType: "counterparty", expenseCategory: "software_subscription", country: "DE", digitalService: true },
    { match: "native instruments", matchType: "counterparty", expenseCategory: "software_subscription", country: "DE", digitalService: true },
    { match: "serato", matchType: "counterparty", expenseCategory: "software_subscription", country: "NZ", digitalService: true },
    { match: "splice", matchType: "counterparty", expenseCategory: "software_subscription", country: "US", digitalService: true },
    { match: "adobe", matchType: "counterparty", expenseCategory: "software_subscription", country: "IE", digitalService: true },
    { match: "dropbox", matchType: "counterparty", expenseCategory: "software_subscription", country: "US", digitalService: true },

    // --- Utstyr ---
    { match: "thomann", matchType: "counterparty", expenseCategory: "equipment", country: "DE" },
    { match: "pioneer dj", matchType: "counterparty", expenseCategory: "equipment", country: "JP" },
    { match: "4sound", matchType: "counterparty", expenseCategory: "equipment", country: "NO" },
    { match: "musikkbutikken", matchType: "counterparty", expenseCategory: "equipment", country: "NO" },

    // --- Inntektskilder ---
    { match: "distrokid", matchType: "counterparty", incomeCategory: "royalty_income", expenseCategory: "software_subscription", country: "US", digitalService: true },
    { match: "tunecore", matchType: "counterparty", incomeCategory: "royalty_income", expenseCategory: "software_subscription", country: "US", digitalService: true },
    { match: "tono", matchType: "counterparty", incomeCategory: "royalty_income", expenseCategory: "membership", country: "NO" },
    { match: "gramo", matchType: "counterparty", incomeCategory: "royalty_income", country: "NO" },

    // --- Reise ---
    { match: "vy", matchType: "counterparty", expenseCategory: "travel", country: "NO" },
    { match: "sas", matchType: "counterparty", expenseCategory: "travel", country: "NO" },
    { match: "norwegian", matchType: "counterparty", expenseCategory: "travel", country: "NO" },
    { match: "ruter", matchType: "counterparty", expenseCategory: "travel", country: "NO" },
  ],

  fallbackIncomeCategory: "gig_income",
  fallbackExpenseCategory: "other_expense",
};
