import type { ExtractedDocument } from "@qbikk/core/contract";

/**
 * Ekstraktoren er systemets eneste generiske lag mot dokumenter.
 * Alt annet - kanaler, dedup, matching, dashboard - er leverandøruavhengig
 * fordi denne funksjonen er det.
 */
export interface ExtractionInput {
  /** Ren tekst (e-postbrødtekst, OCR-resultat). Brukes hvis `data` mangler. */
  text?: string;
  /** Rå bytes for PDF eller bilde. Claude leser begge direkte - ingen egen OCR. */
  data?: Buffer;
  mime?: string;
  filename?: string;
  /**
   * Kontekst som hjelper modellen uten å styre den: avsender, emne, mottaksdato.
   * Brukes til å utlede land og dato når dokumentet selv er utydelig.
   */
  hints?: {
    sender?: string | null;
    subject?: string | null;
    receivedAt?: string | null;
    /** Brukerens egne firmanavn - lar modellen se hvem som er "vi" og dermed retningen. */
    ownNames?: string[];
  };
}

export interface ExtractionResult {
  document: ExtractedDocument;
  extractor: string;
  model: string | null;
  promptVersion: string;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
}

export interface Extractor {
  readonly name: string;
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}

export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}
