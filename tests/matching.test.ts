/**
 * Matching: usikre matcher FORESLÅS, de utføres ikke.
 *
 * Den viktigste testen her er den tvetydige: to abonnementer med samme beløp
 * på samme dag. Det er nettopp da en automatisk kobling ville festet
 * kvitteringen til feil betaling - og feilen ville vært usynlig, fordi
 * totalen fortsatt stemmer.
 */
import { describe, expect, it } from "vitest";
import { scoreMatch, bestMatch, MATCH_CONFIG, type MatchCandidate } from "@qbikk/core/matching";

const bank: MatchCandidate = {
  id: "bank-1",
  date: "2026-03-13",
  direction: "expense",
  amountNok: 125_000,
  currency: "NOK",
  counterpartyName: "ELEKTRONIKKBUTIKKEN AS*OSLO",
};

const doc = (over: Partial<MatchCandidate> = {}): MatchCandidate => ({
  id: "doc-1",
  date: "2026-03-12",
  direction: "expense",
  amountNok: 125_000,
  currency: "NOK",
  counterpartyName: "Elektronikkbutikken AS",
  ...over,
});

describe("poengsetting", () => {
  it("gir topp score for eksakt beløp, nær dato og gjenkjennelig navn", () => {
    const result = scoreMatch(bank, doc());
    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThan(0.9);
    expect(result!.reasons.amount).toBe(1);
    expect(result!.reasons.dateDiffDays).toBe(1);
  });

  it("diskvalifiserer motsatt retning", () => {
    expect(scoreMatch(bank, doc({ direction: "income" }))).toBeNull();
  });

  it("diskvalifiserer dato utenfor vinduet", () => {
    expect(scoreMatch(bank, doc({ date: "2026-01-01" }))).toBeNull();
  });

  it("diskvalifiserer beløp som er for langt unna", () => {
    expect(scoreMatch(bank, doc({ amountNok: 250_000 }))).toBeNull();
  });

  it("tåler øreavrunding fra valutaomregning", () => {
    // To øre fra hverandre er avrunding, ikke et annet kjøp.
    const result = scoreMatch(bank, doc({ amountNok: 125_002 }));
    expect(result).not.toBeNull();
    expect(result!.reasons.amount).toBeGreaterThanOrEqual(0.99);
  });

  it("straffer, men diskvalifiserer ikke, et lite gebyrpåslag", () => {
    const result = scoreMatch(bank, doc({ amountNok: 126_500 }));
    expect(result).not.toBeNull();
    expect(result!.reasons.amount).toBeLessThan(0.9);
  });
});

describe("bestMatch", () => {
  it("kobler automatisk når matchen er utvilsom", () => {
    const proposal = bestMatch(bank, [doc()]);
    expect(proposal).not.toBeNull();
    expect(proposal!.autoLink).toBe(true);
    expect(proposal!.documentVoucherId).toBe("doc-1");
    expect(proposal!.bankVoucherId).toBe("bank-1");
  });

  it("FORESLÅR, men kobler ikke, når to kandidater er like gode", () => {
    // To abonnementer trukket samme dag, samme beløp. Dette er tilfellet der
    // en automatisk kobling ville vært feil omtrent halvparten av gangene.
    const proposal = bestMatch(bank, [
      doc({ id: "doc-a", counterpartyName: "Elektronikkbutikken AS" }),
      doc({ id: "doc-b", counterpartyName: "Elektronikkbutikken AS" }),
    ]);

    expect(proposal).not.toBeNull();
    expect(proposal!.autoLink).toBe(false);
  });

  it("kobler igjen når den ene kandidaten er tydelig bedre", () => {
    const proposal = bestMatch(bank, [
      doc({ id: "doc-a" }),
      // Feil navn og feil dato - klart dårligere.
      doc({ id: "doc-b", counterpartyName: "Helt Annen Leverandør AS", date: "2026-03-05" }),
    ]);

    expect(proposal!.documentVoucherId).toBe("doc-a");
    expect(proposal!.autoLink).toBe(true);
  });

  it("kobler ikke automatisk når beløpet ikke er eksakt", () => {
    // Ett tvilsomt beløp er nok til at et menneske skal se på det.
    const proposal = bestMatch(bank, [doc({ amountNok: 126_500 })]);
    if (proposal) expect(proposal.autoLink).toBe(false);
  });

  it("returnerer null når ingenting er godt nok", () => {
    expect(bestMatch(bank, [])).toBeNull();
    expect(bestMatch(bank, [doc({ amountNok: 999_999, date: "2025-01-01" })])).toBeNull();
  });

  it("terskelen for autokobling er strengere enn for forslag", () => {
    expect(MATCH_CONFIG.autoLinkThreshold).toBeGreaterThan(MATCH_CONFIG.proposeThreshold);
  });
});
