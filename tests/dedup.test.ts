/**
 * Dedup i tre lag.
 *
 * De to kravene fra oppdraget som testes her:
 *   - Samme kvittering fra to kanaler skal bli ETT bilag.
 *   - Bank + kvittering for det samme kjøpet skal bli TO bilag som matches.
 *
 * Det andre kravet er det som gjør at `origin` er med i hashen. Uten det
 * hadde bankraden og dokumentraden fått samme nøkkel, og den andre importen
 * ville blitt stille avvist av unique-indeksen - vi hadde mistet enten
 * bankens fasit på beløp eller kvitteringens MVA og varelinjer.
 */
import { describe, expect, it } from "vitest";
import { dedupHash, isProbableDuplicate, sha256, daysBetween } from "@qbikk/core/dedup";
import { normalizeDocument, normalizeBankTransaction, type NormalizeContext } from "@qbikk/core/normalize";
import type { ExtractedDocument } from "@qbikk/core/contract";
import { getProfile } from "@qbikk/core/profiles/index";

const USER_ID = "00000000-0000-0000-0000-000000000001";

const baseContext: Omit<NormalizeContext, "origin" | "sourceChannel"> = {
  userId: USER_ID,
  profile: getProfile("dj"),
  rules: [],
  receivedAt: new Date("2026-03-12T19:41:00Z"),
  senderAddress: "noreply@beatport.com",
};

const receipt: ExtractedDocument = {
  documentType: "receipt",
  direction: "expense",
  issueDate: "2026-03-12",
  dueDate: null,
  currency: "NOK",
  grossAmount: "1250.00",
  netAmount: "1000.00",
  vatAmount: "250.00",
  vatRate: 25,
  vatCode: "standard_25",
  counterparty: { name: "Elektronikkbutikken AS", country: "NO", orgNumber: null, vatNumber: null },
  invoiceNumber: null,
  orderNumber: null,
  description: "Lydkabel og adapter",
  paymentMethod: "kort",
  isPaid: true,
  lines: [],
  fieldConfidence: {
    grossAmount: 1, issueDate: 1, direction: 1, currency: 1,
    "counterparty.name": 1, vatAmount: 1, vatRate: 1, netAmount: 1, description: 1,
  },
  notes: null,
};

describe("lag 1 - råbytes", () => {
  it("samme bytes gir samme hash, ulike bytes gir ulik", () => {
    expect(sha256("hei")).toBe(sha256("hei"));
    expect(sha256("hei")).not.toBe(sha256("hei "));
    expect(sha256(Buffer.from("hei"))).toBe(sha256("hei"));
  });
});

describe("lag 2 - samme kvittering fra to kanaler blir ETT bilag", () => {
  it("videresendt e-post og IMAP-backfill gir samme dedup-hash", async () => {
    const viaEmail = await normalizeDocument(receipt, {
      ...baseContext,
      origin: "document",
      sourceChannel: "email_forward",
    });
    const viaImap = await normalizeDocument(receipt, {
      ...baseContext,
      origin: "document",
      // Annen kanal, annen mottakstid - men det er det samme kjøpet.
      sourceChannel: "inbox_scan",
      receivedAt: new Date("2026-04-02T08:00:00Z"),
    });

    expect(viaEmail.voucher.dedupHash).toBe(viaImap.voucher.dedupHash);
  });

  it("fakturanummer er sterkere enn beløp og dato", () => {
    const withRef = (ref: string, amount: number) =>
      dedupHash({
        userId: USER_ID,
        origin: "document",
        date: "2026-03-12",
        direction: "expense",
        amountNok: amount,
        currency: "NOK",
        counterpartyName: "Elektronikkbutikken AS",
        externalRef: ref,
      });

    // Samme faktura, men beløpet ble lest litt ulikt av to ekstraksjoner:
    // referansen avgjør, så det er fortsatt ett bilag.
    expect(withRef("F-1001", 125_000)).toBe(withRef("F-1001", 125_100));
    // Ulike fakturaer er ulike bilag, selv med identisk beløp.
    expect(withRef("F-1001", 125_000)).not.toBe(withRef("F-1002", 125_000));
  });

  it("normaliserer motpartsnavnet, så skrivemåten ikke lager dubletter", () => {
    const named = (name: string) =>
      dedupHash({
        userId: USER_ID,
        origin: "document",
        date: "2026-03-12",
        direction: "expense",
        amountNok: 125_000,
        currency: "NOK",
        counterpartyName: name,
      });

    expect(named("Beatport, LLC")).toBe(named("BEATPORT LLC"));
    expect(named("Beatport, LLC")).toBe(named("Beatport"));
  });

  it("holder brukere fra hverandre", () => {
    const forUser = (userId: string) =>
      dedupHash({
        userId,
        origin: "document",
        date: "2026-03-12",
        direction: "expense",
        amountNok: 125_000,
        currency: "NOK",
        counterpartyName: "Elektronikkbutikken AS",
      });

    expect(forUser(USER_ID)).not.toBe(forUser("00000000-0000-0000-0000-000000000002"));
  });
});

describe("lag 3 - bank og dokument skal IKKE deduppe mot hverandre", () => {
  it("gir to bilag for det samme kjøpet, med ulik hash", async () => {
    const fromDocument = await normalizeDocument(receipt, {
      ...baseContext,
      origin: "document",
      sourceChannel: "email_forward",
    });

    const fromBank = await normalizeBankTransaction(
      {
        externalId: "tx-99110",
        bookingDate: "2026-03-13",
        valueDate: "2026-03-12",
        // Banken oppgir utgående betaling med minus.
        amount: -125_000,
        currency: "NOK",
        counterpartyName: "ELEKTRONIKKBUTIKKEN AS",
        remittanceInfo: "Varekjøp 12.03",
      },
      { ...baseContext, sourceChannel: "bank" },
    );

    // Samme kjøp, samme beløp, samme motpart - men bevisst ulike nøkler,
    // slik at begge overlever importen og kan kobles av matcheren.
    expect(fromDocument.voucher.dedupHash).not.toBe(fromBank.voucher.dedupHash);
    expect(fromDocument.voucher.amountNok).toBe(fromBank.voucher.amountNok);

    // Banken utleder retning fra fortegnet.
    expect(fromBank.voucher.direction).toBe("expense");
    expect(fromBank.voucher.grossAmount).toBe(125_000);

    // Bankbilaget mangler dokumentasjon og gjetter ikke MVA.
    expect(fromBank.voucher.needsDocumentation).toBe(true);
    expect(fromBank.voucher.vatAmount).toBeNull();
    expect(fromBank.voucher.vatCode).toBeNull();
    expect(fromBank.voucher.status).toBe("needs_review");

    // Dokumentbilaget har MVA og trenger ikke dokumentasjon.
    expect(fromDocument.voucher.vatAmount).toBe(25_000);
    expect(fromDocument.voucher.needsDocumentation).toBe(false);
  });

  it("innbetaling fra banken blir en inntekt", async () => {
    const income = await normalizeBankTransaction(
      {
        externalId: "tx-99111",
        bookingDate: "2026-03-20",
        valueDate: null,
        amount: 500_000,
        currency: "NOK",
        counterpartyName: "Klubb Oslo AS",
        remittanceInfo: "Honorar DJ-sett",
      },
      { ...baseContext, sourceChannel: "bank" },
    );

    expect(income.voucher.direction).toBe("income");
    expect(income.voucher.grossAmount).toBe(500_000);
  });
});

describe("myk dublett-mistanke", () => {
  const a = { date: "2026-03-12", amountNok: 125_000, direction: "expense", counterpartyName: "Beatport, LLC" };

  it("fanger samme beløp og motpart innenfor noen dager", () => {
    expect(isProbableDuplicate(a, { ...a, date: "2026-03-13" })).toBe(true);
    expect(isProbableDuplicate(a, { ...a, counterpartyName: "BEATPORT LLC" })).toBe(true);
  });

  it("fanger IKKE ulikt beløp, retning eller for stor datoavstand", () => {
    expect(isProbableDuplicate(a, { ...a, amountNok: 125_001 })).toBe(false);
    expect(isProbableDuplicate(a, { ...a, direction: "income" })).toBe(false);
    expect(isProbableDuplicate(a, { ...a, date: "2026-03-20" })).toBe(false);
  });
});

describe("daysBetween", () => {
  it("teller dager med fortegn", () => {
    expect(daysBetween("2026-03-13", "2026-03-12")).toBe(1);
    expect(daysBetween("2026-03-12", "2026-03-13")).toBe(-1);
    expect(daysBetween("2026-03-12", "2026-03-12")).toBe(0);
    // Over månedsskifte og skuddårsdag.
    expect(daysBetween("2028-03-01", "2028-02-28")).toBe(2);
  });
});
