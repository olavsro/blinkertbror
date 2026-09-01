/**
 * Norsk MVA: satser, splitting og omvendt avgiftsplikt.
 *
 * Omvendt avgiftsplikt får mest plass her, fordi den er den vanligste feilen
 * i småbedrifter med utenlandske abonnementer - og fordi den er den eneste
 * regelen som endrer hva som skal RAPPORTERES uten å endre hva som ble betalt.
 */
import { describe, expect, it } from "vitest";
import {
  VAT_RATES,
  VAT_LABELS,
  splitFromGross,
  splitFromNet,
  vatCodeFromRate,
  shouldReverseCharge,
  reverseChargeVat,
  vatTermFor,
  isForeign,
} from "@qbikk/core/vat";

describe("satser", () => {
  it("har de norske satsene", () => {
    expect(VAT_RATES.standard_25).toBe(25);
    expect(VAT_RATES.food_15).toBe(15);
    expect(VAT_RATES.transport_12).toBe(12);
    expect(VAT_RATES.zero_0).toBe(0);
    expect(VAT_RATES.exempt).toBe(0);
  });

  it("har en norsk etikett for hver kode", () => {
    for (const code of Object.keys(VAT_RATES)) {
      expect(VAT_LABELS[code as keyof typeof VAT_LABELS]).toBeTruthy();
    }
  });

  it("gjenkjenner sats fra tall, og nekter å gjette på ukjente", () => {
    expect(vatCodeFromRate(25)).toBe("standard_25");
    expect(vatCodeFromRate(15)).toBe("food_15");
    expect(vatCodeFromRate(12)).toBe("transport_12");
    expect(vatCodeFromRate(0)).toBe("zero_0");
    // Utenlandske satser skal IKKE snappe til en norsk kode. En tysk faktura
    // med 19 % er ikke et norsk 25 %-bilag, og å late som ville gitt feil
    // beløp i MVA-meldingen.
    expect(vatCodeFromRate(19)).toBeNull();
    expect(vatCodeFromRate(20)).toBeNull();
    expect(vatCodeFromRate(null)).toBeNull();

    // Små avvik snappes derimot med vilje: en kvittering som er lest som
    // 24,8 % er 25 %, ikke en ukjent sats.
    expect(vatCodeFromRate(24.8)).toBe("standard_25");
  });
});

describe("splitting", () => {
  it("splitter brutto i netto og mva", () => {
    // 1250,00 inkl. 25 % -> 1000,00 + 250,00
    const s = splitFromGross(125_000, "standard_25");
    expect(s.net).toBe(100_000);
    expect(s.vat).toBe(25_000);
    expect(s.gross).toBe(125_000);
  });

  it("splitter 15 % næringsmidler", () => {
    const s = splitFromGross(11_500, "food_15");
    expect(s.net).toBe(10_000);
    expect(s.vat).toBe(1500);
  });

  it("splitter 12 % lav sats", () => {
    const s = splitFromGross(11_200, "transport_12");
    expect(s.net).toBe(10_000);
    expect(s.vat).toBe(1200);
  });

  it("netto + mva er alltid nøyaktig brutto, også med avrunding", () => {
    // Alle beløp fra 1 til 1000 øre: summen skal aldri bomme med ett øre.
    for (let gross = 1; gross <= 1000; gross++) {
      const s = splitFromGross(gross, "standard_25");
      expect(s.net + s.vat).toBe(gross);
    }
  });

  it("splitter fra netto når fakturaen viser eks. mva", () => {
    const s = splitFromNet(100_000, "standard_25");
    expect(s.vat).toBe(25_000);
    expect(s.gross).toBe(125_000);
  });

  it("lar beløpet stå urørt ved omvendt avgiftsplikt", () => {
    // Selger fakturerer uten mva, så fakturabeløpet ER netto. MVA beregnes i
    // tillegg og nulles ut mot fradraget - bilagets brutto endrer seg ikke.
    const s = splitFromGross(10_000, "reverse_charge");
    expect(s.net).toBe(10_000);
    expect(s.vat).toBe(0);
    expect(s.gross).toBe(10_000);
    // ...men beløpet som skal rapporteres på begge sider er 25 %.
    expect(reverseChargeVat(10_000)).toBe(2500);
  });
});

describe("omvendt avgiftsplikt", () => {
  const base = { direction: "expense" as const, vatAmount: null, vatRate: null };

  it("utløses av utenlandsk selger uten fakturert mva", () => {
    expect(shouldReverseCharge({ ...base, counterpartyCountry: "US" })).toBe(true);
    expect(shouldReverseCharge({ ...base, counterpartyCountry: "IE" })).toBe(true);
  });

  it("utløses IKKE av norsk selger", () => {
    expect(shouldReverseCharge({ ...base, counterpartyCountry: "NO" })).toBe(false);
  });

  it("utløses IKKE når selger faktisk har fakturert mva", () => {
    // Har selger krevd inn norsk mva, er det ikke omvendt avgiftsplikt -
    // da ville vi rapportert den samme avgiften to ganger.
    expect(shouldReverseCharge({ ...base, counterpartyCountry: "SE", vatAmount: 2500 })).toBe(false);
    expect(shouldReverseCharge({ ...base, counterpartyCountry: "SE", vatRate: 25 })).toBe(false);
  });

  it("gjelder aldri inntekter", () => {
    expect(shouldReverseCharge({ ...base, direction: "income", counterpartyCountry: "US" })).toBe(false);
  });

  it("gjelder ikke når landet er ukjent - da flagger vi ikke", () => {
    expect(shouldReverseCharge({ ...base, counterpartyCountry: null })).toBe(false);
    expect(isForeign(null)).toBe(false);
  });
});

describe("MVA-terminer", () => {
  it("deler året i seks terminer på to måneder", () => {
    expect(vatTermFor("2026-01-15")).toMatchObject({ term: 1, from: "2026-01-01", to: "2026-02-28" });
    expect(vatTermFor("2026-02-28")).toMatchObject({ term: 1 });
    expect(vatTermFor("2026-03-01")).toMatchObject({ term: 2, from: "2026-03-01", to: "2026-04-30" });
    expect(vatTermFor("2026-11-30")).toMatchObject({ term: 6, from: "2026-11-01", to: "2026-12-31" });
  });

  it("håndterer skuddår", () => {
    expect(vatTermFor("2028-01-15").to).toBe("2028-02-29");
  });
});
