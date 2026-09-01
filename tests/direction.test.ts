/**
 * Retning kommer fra DOKUMENTET, aldri fra leverandørnavnet.
 *
 * Beatport er hele grunnen til at denne regelen finnes: den samme
 * leverandøren selger musikk til brukeren (utgift) OG betaler ut brukerens
 * eget salg (inntekt). Et system som gjettet retning ut fra navnet, ville
 * bokført halvparten av en DJs inntekter som kostnader.
 *
 * Testen bruker det samme motpartsnavnet i begge retninger, så det ENESTE
 * som skiller er hva dokumentet sier.
 */
import { describe, expect, it } from "vitest";
import { normalizeDocument, type NormalizeContext } from "@qbikk/core/normalize";
import type { ExtractedDocument } from "@qbikk/core/contract";
import { getProfile } from "@qbikk/core/profiles/index";
import { categorize } from "@qbikk/core/categorize";

const context: NormalizeContext = {
  userId: "00000000-0000-0000-0000-000000000001",
  profile: getProfile("dj"),
  rules: [],
  origin: "document",
  sourceChannel: "email_forward",
  receivedAt: new Date("2026-03-12T19:41:00Z"),
  senderAddress: "noreply@beatport.com",
};

function beatport(direction: "income" | "expense", gross: string, type: ExtractedDocument["documentType"]): ExtractedDocument {
  return {
    documentType: type,
    direction,
    issueDate: "2026-03-12",
    dueDate: null,
    currency: "USD",
    grossAmount: gross,
    netAmount: gross,
    vatAmount: "0",
    vatRate: 0,
    vatCode: null,
    counterparty: { name: "Beatport, LLC", country: "US", orgNumber: null, vatNumber: null },
    invoiceNumber: null,
    orderNumber: null,
    description: direction === "income" ? "Utbetaling for eget salg" : "Kjøp av musikk",
    paymentMethod: null,
    isPaid: true,
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
      description: 1,
    },
    notes: null,
  };
}

describe("samme leverandør, begge retninger", () => {
  it("kjøpskvittering fra Beatport blir en UTGIFT", async () => {
    const result = await normalizeDocument(beatport("expense", "14.94", "receipt"), context);

    expect(result.voucher.direction).toBe("expense");
    expect(result.voucher.category).toBe("music_purchase");
    expect(result.voucher.grossAmount).toBe(1494);
  });

  it("payout statement fra Beatport blir en INNTEKT", async () => {
    const result = await normalizeDocument(beatport("income", "730.24", "payout_statement"), context);

    expect(result.voucher.direction).toBe("income");
    expect(result.voucher.category).toBe("music_sales_income");
    expect(result.voucher.grossAmount).toBe(73_024);
  });

  it("de to får ULIKE kategorier fra det samme leverandørhintet", async () => {
    const expense = await normalizeDocument(beatport("expense", "14.94", "receipt"), context);
    const income = await normalizeDocument(beatport("income", "730.24", "payout_statement"), context);

    expect(expense.voucher.category).not.toBe(income.voucher.category);
    expect(expense.voucher.accountCode).not.toBe(income.voucher.accountCode);
  });

  it("de to får ULIKE dedup-hasher og kan derfor eksistere samtidig", async () => {
    const expense = await normalizeDocument(beatport("expense", "14.94", "receipt"), context);
    const income = await normalizeDocument(beatport("income", "730.24", "payout_statement"), context);

    expect(expense.voucher.dedupHash).not.toBe(income.voucher.dedupHash);
  });

  it("leverandørhintet setter aldri retning selv", () => {
    const profile = getProfile("dj");
    for (const hint of profile.vendors) {
      // Et hint har kategori PER retning, men ingen retning. Legger noen til
      // et `direction`-felt her, er premisset brutt.
      expect(hint).not.toHaveProperty("direction");
      expect(hint.expenseCategory ?? hint.incomeCategory).toBeTruthy();
    }
  });

  it("kategoriseringen snur når bare retningen snur", () => {
    const input = {
      counterpartyName: "Beatport, LLC",
      counterpartyCountry: "US",
      description: null,
      senderDomain: "beatport.com",
      vatAmount: null,
      vatRate: null,
      suggestedVatCode: null,
    } as const;

    const asExpense = categorize(getProfile("dj"), [], { ...input, direction: "expense" });
    const asIncome = categorize(getProfile("dj"), [], { ...input, direction: "income" });

    expect(asExpense.source).toBe("vendor_hint");
    expect(asIncome.source).toBe("vendor_hint");
    expect(asExpense.category).toBe("music_purchase");
    expect(asIncome.category).toBe("music_sales_income");
  });

  it("ukjent retning gjettes ikke - bilaget sendes til gjennomgang", async () => {
    const unclear = { ...beatport("expense", "14.94", "receipt"), direction: "unknown" as const };
    const result = await normalizeDocument(unclear, context);

    expect(result.voucher.status).toBe("needs_review");
    expect(result.reviewReasons.join(" ")).toMatch(/inntekt eller utgift/i);
  });
});
