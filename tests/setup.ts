/**
 * Testoppsett.
 *
 * To ting gjøres her, og begge handler om at en test skal teste KODEN VÅR:
 *
 *  1. `@qbikk/core/fx` mockes bort. Ekte valutaomregning slår opp i databasen
 *     og ringer Norges Bank. En test som gjør det, feiler når nettet er nede
 *     og gir ulike svar på ulike dager - da tester den ikke normaliseringen,
 *     den tester internett.
 *  2. Miljøvariabler settes til kjente verdier, så ingenting plukker opp en
 *     ekte .env og skriver i en ekte database.
 *
 * Kursene er faste og urealistisk runde med vilje: da er det åpenbart i en
 * feilmelding at tallet kom herfra.
 */
import { vi } from "vitest";

process.env.DATABASE_URL = "postgres://test:test@localhost:1/test";
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.INBOUND_EMAIL_DOMAIN = "bilag.test";
process.env.BLOB_DRIVER = "local";

export const TEST_RATES: Record<string, number> = { NOK: 1, USD: 10, EUR: 12, SEK: 1 };

vi.mock("../packages/core/src/fx.js", async () => {
  const actual = await vi.importActual<typeof import("../packages/core/src/fx.js")>(
    "../packages/core/src/fx.js",
  );
  return {
    ...actual,
    getRate: async (currency: string, date: string) => ({
      currency: currency.toUpperCase(),
      rate: TEST_RATES[currency.toUpperCase()] ?? 1,
      rateDate: date,
      source: "test",
    }),
    convertToNok: async (amount: number, currency: string, date: string) => {
      const cur = currency.toUpperCase();
      const rate = TEST_RATES[cur] ?? 1;
      if (cur === "NOK") return { amountNok: amount, exchangeRate: 1, rateDate: date };
      const zeroDecimal = new Set(["JPY", "KRW", "ISK", "CLP", "VND"]);
      const decimals = zeroDecimal.has(cur) ? 0 : 2;
      return {
        amountNok: Math.round((amount / 10 ** decimals) * rate * 100),
        exchangeRate: rate,
        rateDate: date,
      };
    },
  };
});
