/**
 * DEN VIKTIGSTE TESTEN I PROSJEKTET.
 *
 * Kravet fra oppdraget er at en DJ og en frisør skal gjennom NØYAKTIG samme
 * kodevei, og at bransje er DATA og ikke en kodegren. Denne testen kjører de
 * to casene gjennom det samme `normalizeDocument()`-kallet med bare `profile`
 * forskjellig, og slår fast at det eneste som skiller resultatene er kategori
 * og kontokode.
 *
 * Feiler denne, har noen lagt en `if (profile === "dj")` et sted, og hele
 * premisset i CLAUDE.md er brutt.
 */
import { describe, expect, it } from "vitest";
import { normalizeDocument, type NormalizeContext } from "@qbikk/core/normalize";
import type { ExtractedDocument } from "@qbikk/core/contract";
import { getProfile } from "@qbikk/core/profiles/index";

const USER_ID = "00000000-0000-0000-0000-000000000001";

function context(profileKey: string): NormalizeContext {
  return {
    userId: USER_ID,
    profile: getProfile(profileKey),
    // Ingen databaseregler: profilen alene skal gjøre jobben.
    rules: [],
    origin: "document",
    sourceChannel: "email_forward",
    receivedAt: new Date("2026-03-09T10:00:00Z"),
    senderAddress: null,
  };
}

/** Et kjøp fra en bransjetypisk grossist. Samme form for begge. */
function purchase(counterparty: string, description: string): ExtractedDocument {
  return {
    documentType: "invoice",
    direction: "expense",
    issueDate: "2026-03-09",
    dueDate: "2026-03-23",
    currency: "NOK",
    grossAmount: "3456.25",
    netAmount: "2765.00",
    vatAmount: "691.25",
    vatRate: 25,
    vatCode: "standard_25",
    counterparty: { name: counterparty, country: "NO", orgNumber: null, vatNumber: null },
    invoiceNumber: "240118",
    orderNumber: null,
    description,
    paymentMethod: null,
    isPaid: false,
    lines: [],
    fieldConfidence: {
      grossAmount: 1,
      issueDate: 1,
      direction: 1,
      currency: 1,
      "counterparty.name": 1,
      vatAmount: 1,
      vatRate: 1,
      netAmount: 1,
      description: 0.9,
    },
    notes: null,
  };
}

describe("bransjeprofiler går gjennom samme kodevei", () => {
  it("gir gyldige bilag for både DJ og frisør fra identisk kall", async () => {
    const dj = await normalizeDocument(purchase("Beatport", "Kjøp av musikk"), context("dj"));
    const frisor = await normalizeDocument(
      purchase("Wella Norge AS", "Hårfarge og folie fra grossist"),
      context("frisor"),
    );

    for (const result of [dj, frisor]) {
      // Begge skal være ferdige, bokførbare bilag - ikke halvferdige.
      expect(result.voucher.date).toBe("2026-03-09");
      expect(result.voucher.direction).toBe("expense");
      expect(result.voucher.grossAmount).toBe(345_625);
      expect(result.voucher.netAmount).toBe(276_500);
      expect(result.voucher.vatAmount).toBe(69_125);
      expect(result.voucher.currency).toBe("NOK");
      expect(result.voucher.amountNok).toBe(345_625);
      expect(result.voucher.status).toBe("matched");
      expect(result.reviewReasons).toEqual([]);
      expect(result.voucher.accountCode).toBeTruthy();
      expect(result.voucher.category).toBeTruthy();
    }
  });

  it("skiller seg BARE på kategori og kontokode", async () => {
    const dj = await normalizeDocument(purchase("Beatport", "Kjøp av musikk"), context("dj"));
    const frisor = await normalizeDocument(
      purchase("Wella Norge AS", "Hårfarge og folie fra grossist"),
      context("frisor"),
    );

    // Alt som IKKE er bransjeavhengig skal være identisk. Vi sammenligner
    // hele bilaget med de bransjeavhengige feltene - og de som naturlig
    // varierer med inputen - tatt ut.
    const strip = (voucher: Record<string, unknown>) => {
      const copy = { ...voucher };
      for (const key of ["category", "accountCode", "counterpartyName", "description", "dedupHash"]) {
        delete copy[key];
      }
      return copy;
    };

    expect(strip(dj.voucher as unknown as Record<string, unknown>)).toEqual(
      strip(frisor.voucher as unknown as Record<string, unknown>),
    );

    // ...og bransjen skal faktisk ha gjort en forskjell.
    expect(dj.voucher.category).not.toBe(frisor.voucher.category);
    expect(dj.voucher.category).toBe("music_purchase");
    expect(frisor.voucher.category).toBe("goods_for_resale");
  });

  it("profilene er ren data - ingen kodevei kjenner bransjen", () => {
    for (const key of ["dj", "frisor", "dagligvare", "generic"]) {
      const profile = getProfile(key);
      expect(profile.categories.length).toBeGreaterThan(0);
      expect(profile.key).toBe(key);

      // Alle kategorier må ha en NS 4102-konto, ellers kan bilaget ikke bokføres.
      for (const category of profile.categories) {
        expect(category.accountCode).toMatch(/^\d{4}$/);
      }
      // Fallbackene må peke på kategorier som faktisk finnes.
      expect(profile.categories.some((c) => c.key === profile.fallbackIncomeCategory)).toBe(true);
      expect(profile.categories.some((c) => c.key === profile.fallbackExpenseCategory)).toBe(true);
    }
  });

  it("ukjent bransje faller tilbake på generic i stedet for å kræsje", () => {
    expect(getProfile("tannlege").key).toBe("generic");
    expect(getProfile(null).key).toBe("generic");
    expect(getProfile(undefined).key).toBe("generic");
  });
});
