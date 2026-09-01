import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { extractedDocumentSchema } from "@qbikk/core/contract";
import { truncate } from "@qbikk/core/text";
import type { ExtractionInput, ExtractionResult, Extractor } from "./types.js";
import { ExtractionError } from "./types.js";
import { SYSTEM_PROMPT, PROMPT_VERSION, buildUserPrompt } from "./prompt.js";

/** Claude leser PDF og bilder direkte. Ingen separat OCR-pipeline å drifte. */
const SUPPORTED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const MAX_TEXT_CHARS = 60_000;

export class ClaudeExtractor implements Extractor {
  readonly name = "claude";
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: "low" | "medium" | "high";

  constructor(options?: { apiKey?: string; model?: string; effort?: "low" | "medium" | "high" }) {
    this.client = new Anthropic(options?.apiKey ? { apiKey: options.apiKey } : {});
    this.model = options?.model ?? process.env.EXTRACTION_MODEL ?? "claude-opus-5";
    this.effort = options?.effort ?? "medium";
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const started = Date.now();
    const content = buildContent(input);

    try {
      // messages.parse validerer svaret mot zod-skjemaet vårt. Kontrakten i
      // @qbikk/core/contract er dermed eneste sannhet - både for modellen og
      // for typene resten av systemet ser.
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
        output_config: {
          format: zodOutputFormat(extractedDocumentSchema),
          effort: this.effort,
        },
      });

      if (response.stop_reason === "refusal") {
        throw new ExtractionError(
          `Modellen avviste dokumentet (${response.stop_details?.category ?? "ukjent"})`,
        );
      }
      if (!response.parsed_output) {
        throw new ExtractionError("Modellen returnerte ikke gyldig strukturert output");
      }

      return {
        document: response.parsed_output,
        extractor: this.name,
        model: response.model,
        promptVersion: PROMPT_VERSION,
        tokensIn: response.usage.input_tokens,
        tokensOut: response.usage.output_tokens,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      if (err instanceof ExtractionError) throw err;
      if (err instanceof Anthropic.RateLimitError) {
        // Kastes videre slik at jobbkøen kan prøve igjen med backoff.
        throw new ExtractionError("Rate limit mot Anthropic - prøver igjen senere", err);
      }
      if (err instanceof Anthropic.APIError) {
        throw new ExtractionError(`Anthropic API-feil ${err.status}: ${err.message}`, err);
      }
      throw new ExtractionError("Ukjent feil under ekstraksjon", err);
    }
  }
}

/**
 * Bygger innholdsblokkene. PDF og bilder sendes som egne blokktyper - de
 * plasseres FØR tekstblokken, som er rekkefølgen modellen håndterer best.
 */
function buildContent(input: ExtractionInput): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  const mime = input.mime ?? "text/plain";

  if (input.data && mime === "application/pdf") {
    blocks.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: input.data.toString("base64") },
    });
  } else if (input.data && SUPPORTED_IMAGE_MIME.has(mime)) {
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mime as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
        data: input.data.toString("base64"),
      },
    });
  }

  blocks.push({ type: "text", text: buildUserPrompt(input.hints) });

  if (input.text?.trim()) {
    blocks.push({ type: "text", text: `--- DOKUMENT ---\n${truncate(input.text, MAX_TEXT_CHARS)}` });
  }

  if (blocks.length === 1) {
    throw new ExtractionError("Ingenting å lese: verken tekst, PDF eller bilde ble sendt inn");
  }

  return blocks;
}
