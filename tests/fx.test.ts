/**
 * Norges Bank-parseren.
 *
 * UNIT_MULT er det som gjør denne verdt en test. SEK, DKK og JPY noteres per
 * 100 enheter, ikke per én. Leser man tallet rått, blir en svensk faktura
 * hundre ganger for dyr - og totalen ser fortsatt plausibel ut i en tabell.
 */
import { describe, expect, it } from "vitest";
// Parseren er ren og testes direkte fra kilden, utenom mocken i setup.ts.
import { parseNorgesBankCsv } from "../packages/core/src/fx.js";

describe("parseNorgesBankCsv", () => {
  it("leser kolonner etter navn, ikke posisjon", () => {
    // Kolonnesettet fra Norges Bank har endret seg før, så rekkefølgen her
    // er med vilje en annen enn den «vanlige».
    const csv = [
      "FREQ;BASE_CUR;QUOTE_CUR;OBS_VALUE;TIME_PERIOD;UNIT_MULT",
      "B;USD;NOK;10.4231;2026-03-12;0",
    ].join("\n");

    const rate = parseNorgesBankCsv(csv, "USD");
    expect(rate).not.toBeNull();
    expect(rate!.rate).toBeCloseTo(10.4231, 4);
    expect(rate!.rateDate).toBe("2026-03-12");
    expect(rate!.currency).toBe("USD");
    expect(rate!.source).toBe("norges-bank");
  });

  it("deler på 100 når UNIT_MULT=2", () => {
    // SEK noteres per 100 kroner: «97,45» betyr 0,9745 NOK per SEK.
    const csv = [
      "FREQ;TIME_PERIOD;OBS_VALUE;UNIT_MULT",
      "B;2026-03-12;97.4500;2",
    ].join("\n");

    const rate = parseNorgesBankCsv(csv, "SEK");
    expect(rate!.rate).toBeCloseTo(0.9745, 6);
  });

  it("lar kursen stå når UNIT_MULT=0", () => {
    const csv = ["TIME_PERIOD;OBS_VALUE;UNIT_MULT", "2026-03-12;11.7200;0"].join("\n");
    expect(parseNorgesBankCsv(csv, "EUR")!.rate).toBeCloseTo(11.72, 4);
  });

  it("velger SISTE notering i intervallet", () => {
    // Vi ber om et vindu på ti dager for å dekke helger. Da må vi bruke den
    // ferskeste noteringen, ikke den første i fila.
    const csv = [
      "TIME_PERIOD;OBS_VALUE;UNIT_MULT",
      "2026-03-10;10.1000;0",
      "2026-03-12;10.4000;0",
      "2026-03-11;10.2000;0",
    ].join("\n");

    const rate = parseNorgesBankCsv(csv, "USD");
    expect(rate!.rateDate).toBe("2026-03-12");
    expect(rate!.rate).toBeCloseTo(10.4, 4);
  });

  it("tåler komma som desimalskilletegn", () => {
    const csv = ["TIME_PERIOD;OBS_VALUE;UNIT_MULT", "2026-03-12;10,4231;0"].join("\n");
    expect(parseNorgesBankCsv(csv, "USD")!.rate).toBeCloseTo(10.4231, 4);
  });

  it("tåler komma som kolonneskilletegn og siterte felt", () => {
    const csv = ['"TIME_PERIOD","OBS_VALUE","UNIT_MULT"', '"2026-03-12","10.4231","0"'].join("\n");
    expect(parseNorgesBankCsv(csv, "USD")!.rate).toBeCloseTo(10.4231, 4);
  });

  it("returnerer null i stedet for å gjette på tom eller ugyldig CSV", () => {
    expect(parseNorgesBankCsv("", "USD")).toBeNull();
    expect(parseNorgesBankCsv("bare en overskrift", "USD")).toBeNull();
    // Mangler OBS_VALUE - da har vi ingen kurs, og en gjetning ville vært verre.
    expect(parseNorgesBankCsv("TIME_PERIOD;NOE_ANNET\n2026-03-12;5", "USD")).toBeNull();
  });

  it("hopper over rader uten brukbart tall", () => {
    const csv = [
      "TIME_PERIOD;OBS_VALUE;UNIT_MULT",
      "2026-03-13;;0",
      "2026-03-12;10.4231;0",
    ].join("\n");
    expect(parseNorgesBankCsv(csv, "USD")!.rateDate).toBe("2026-03-12");
  });
});
