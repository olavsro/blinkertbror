/**
 * Matching mellom banktransaksjoner og dokumenter.
 *
 * Banken er fasit på HVA som er betalt. Dokumentet er fasit på HVA det gjaldt
 * og hvor mye MVA det var. Sammen blir de ett bilag.
 *
 * Regelen som styrer designet: usikre matcher foreslås, aldri utføres.
 * Bare en match som er praktisk talt utvilsom (eksakt beløp, samme valuta,
 * dato innenfor noen dager, gjenkjennelig motpart) kobles uten at brukeren
 * har sagt ja.
 */
import { counterpartySimilarity } from "./text.js";
import { daysBetween } from "./dedup.js";

export interface MatchCandidate {
  id: string;
  date: string;
  direction: "income" | "expense";
  amountNok: number;
  currency: string;
  counterpartyName: string | null;
}

export interface MatchScore {
  score: number;
  reasons: {
    amount: number;
    date: number;
    name: number;
    currency: number;
    dateDiffDays: number;
    nameSimilarity: number;
  };
}

export const MATCH_CONFIG = {
  /** Hvor mange dager banken kan ligge etter kvitteringen. Kort belastes ofte 1-3 dager senere. */
  dateWindowDays: 10,
  /** Slingringsmonn på beløp - dekker øreavrunding ved valutaomregning. */
  amountTolerance: 0.005,
  weights: { amount: 0.5, date: 0.2, name: 0.3 },
  /** Under denne vises matchen ikke i det hele tatt. */
  proposeThreshold: 0.6,
  /** Over denne kobles bilagene automatisk (status `matched`, fortsatt ikke `confirmed`). */
  autoLinkThreshold: 0.92,
} as const;

function scoreAmount(bank: number, doc: number): number {
  const a = Math.abs(bank);
  const b = Math.abs(doc);
  if (a === b) return 1;
  const diff = Math.abs(a - b);
  const rel = diff / Math.max(a, b, 1);
  if (diff <= 2) return 0.99; // to øre - ren avrunding
  if (rel <= MATCH_CONFIG.amountTolerance) return 0.9;
  if (rel <= 0.02) return 0.6; // gebyr eller valutapåslag
  return 0;
}

function scoreDate(diffDays: number): number {
  const d = Math.abs(diffDays);
  if (d === 0) return 1;
  if (d <= 3) return 0.9;
  if (d <= 7) return 0.7;
  if (d <= MATCH_CONFIG.dateWindowDays) return 0.45;
  return 0;
}

/** Poengsetter ett par. Returnerer null når paret er diskvalifisert. */
export function scoreMatch(bank: MatchCandidate, doc: MatchCandidate): MatchScore | null {
  if (bank.direction !== doc.direction) return null;

  const dateDiffDays = daysBetween(bank.date, doc.date);
  if (Math.abs(dateDiffDays) > MATCH_CONFIG.dateWindowDays) return null;

  const amount = scoreAmount(bank.amountNok, doc.amountNok);
  if (amount === 0) return null;

  const date = scoreDate(dateDiffDays);
  const nameSimilarity = counterpartySimilarity(bank.counterpartyName, doc.counterpartyName);
  const currency = bank.currency === doc.currency ? 1 : 0.8;

  const w = MATCH_CONFIG.weights;
  const score = (amount * w.amount + date * w.date + nameSimilarity * w.name) * currency;

  return {
    score: Math.round(score * 1000) / 1000,
    reasons: { amount, date, name: nameSimilarity, currency, dateDiffDays, nameSimilarity },
  };
}

export interface MatchProposal {
  bankVoucherId: string;
  documentVoucherId: string;
  score: number;
  reasons: MatchScore["reasons"];
  /** true = koble nå, false = legg i "krever handling" og spør brukeren. */
  autoLink: boolean;
}

/**
 * Finner beste dokument for én banktransaksjon.
 *
 * Vi returnerer bare toppkandidaten, og bare hvis den er tydelig bedre enn
 * nummer to. To like gode kandidater (samme beløp, samme dag, to abonnementer)
 * er nettopp tilfellet der en automatisk kobling ville vært feil.
 */
export function bestMatch(bank: MatchCandidate, documents: MatchCandidate[]): MatchProposal | null {
  const scored = documents
    .map((doc) => ({ doc, result: scoreMatch(bank, doc) }))
    .filter((x): x is { doc: MatchCandidate; result: MatchScore } => x.result !== null)
    .sort((a, b) => b.result.score - a.result.score);

  const top = scored[0];
  if (!top || top.result.score < MATCH_CONFIG.proposeThreshold) return null;

  const runnerUp = scored[1];
  const ambiguous = runnerUp !== undefined && top.result.score - runnerUp.result.score < 0.08;

  return {
    bankVoucherId: bank.id,
    documentVoucherId: top.doc.id,
    score: top.result.score,
    reasons: top.result.reasons,
    autoLink: !ambiguous && top.result.score >= MATCH_CONFIG.autoLinkThreshold && top.result.reasons.amount >= 0.99,
  };
}
