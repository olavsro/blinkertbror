/**
 * Beløp er heltall i øre. Alltid.
 *
 * `parseAmount` er det ENESTE stedet en desimalstreng blir til et tall i hele
 * systemet, så formatene her er de formatene systemet faktisk tåler.
 */
import { describe, expect, it } from "vitest";
import {
  parseAmount,
  formatAmount,
  formatPlain,
  decimalsFor,
  minor,
  mulRate,
  percentOf,
} from "@qbikk/core/money";

describe("parseAmount", () => {
  it("tåler formatene vi ser i norske og internasjonale kvitteringer", () => {
    // norsk: mellomrom som tusenskille, komma som desimal
    expect(parseAmount("1 234,56")).toBe(123_456);
    // norsk med punktum som tusenskille
    expect(parseAmount("1.234,56")).toBe(123_456);
    // engelsk
    expect(parseAmount("1,234.56")).toBe(123_456);
    // norsk kortform for «hele kroner»
    expect(parseAmount("kr 349,-")).toBe(34_900);
    expect(parseAmount("349")).toBe(34_900);
    expect(parseAmount("349.00 NOK")).toBe(34_900);
    expect(parseAmount("$1,999.99")).toBe(199_999);
    expect(parseAmount("€10,99")).toBe(1099);
  });

  it("beholder fortegn", () => {
    expect(parseAmount("-99.00")).toBe(-9900);
    expect(parseAmount("-1 234,56")).toBe(-123_456);
  });

  it("leser tre siffer etter punktum som tusenskille, ikke desimaler", () => {
    // «1.234» er 1234 kroner, ikke 1 krone og 234 øre. Uten denne regelen
    // ville hver tusende krone blitt til én krone.
    expect(parseAmount("1.234")).toBe(123_400);
    // Men to siffer ER desimaler.
    expect(parseAmount("1.23")).toBe(123);
  });

  it("returnerer null i stedet for å gjette på søppel", () => {
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("ikke et tall")).toBeNull();
    expect(parseAmount("-")).toBeNull();
  });

  it("respekterer valutaer uten desimaler", () => {
    // 1000 JPY er 1000 minor units, ikke 100 000.
    expect(parseAmount("1000", "JPY")).toBe(1000);
    expect(parseAmount("1000", "NOK")).toBe(100_000);
    expect(decimalsFor("JPY")).toBe(0);
    expect(decimalsFor("NOK")).toBe(2);
    expect(decimalsFor("usd")).toBe(2);
  });

  it("tar imot tall direkte", () => {
    expect(parseAmount(349.5)).toBe(34_950);
    expect(parseAmount(1000, "JPY")).toBe(1000);
  });
});

describe("formatering", () => {
  it("viser øre som kroner", () => {
    expect(formatPlain(34_900)).toBe("349,00");
    // Intl bruker hardt mellomrom (U+00A0) som tusenskille på nb-NO, ikke
    // vanlig mellomrom. Skrevet ut som escape her, ellers ser testen ut til
    // å feile på to identiske strenger.
    expect(formatPlain(123_456)).toBe("1\u00A0234,56");
    expect(formatAmount(34_900, "NOK")).toContain("349,00");
  });

  it("er rundtur-sikker: parse -> format -> parse gir samme tall", () => {
    for (const input of ["1 234,56", "349", "0,01", "99 999,99"]) {
      const parsed = parseAmount(input);
      expect(parsed).not.toBeNull();
      expect(parseAmount(formatPlain(parsed!))).toBe(parsed);
    }
  });
});

describe("aritmetikk", () => {
  it("runder halvveis opp, konsekvent", () => {
    expect(minor(10.5)).toBe(11);
    expect(mulRate(1000, 1.055)).toBe(1055);
    expect(percentOf(10_000, 25)).toBe(2500);
  });

  it("kaster på tall som ikke er tall", () => {
    expect(() => minor(NaN)).toThrow();
    expect(() => minor(Infinity)).toThrow();
  });
});
