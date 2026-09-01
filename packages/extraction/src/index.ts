import { ClaudeExtractor } from "./claude.js";
import { HeuristicExtractor } from "./heuristic.js";
import type { Extractor } from "./types.js";

export * from "./types.js";
export { ClaudeExtractor } from "./claude.js";
export { HeuristicExtractor } from "./heuristic.js";
export { SYSTEM_PROMPT, PROMPT_VERSION } from "./prompt.js";

let cached: Extractor | undefined;

/**
 * Uten ANTHROPIC_API_KEY faller vi tilbake på den regelbaserte ekstraktoren
 * i stedet for å kræsje. Da kan prosjektet kjøres og demonstreres med én
 * gang - alle bilag havner bare i gjennomgangskøen, som er riktig oppførsel
 * når vi ikke vet bedre.
 */
export function getExtractor(): Extractor {
  if (cached) return cached;
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    cached = new ClaudeExtractor();
  } else {
    console.warn("[extraction] ANTHROPIC_API_KEY mangler - bruker regelbasert fallback");
    cached = new HeuristicExtractor();
  }
  return cached;
}

/** Til tester som vil injisere sin egen. */
export function setExtractor(extractor: Extractor): void {
  cached = extractor;
}
