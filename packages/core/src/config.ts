import { z } from "zod";

/**
 * Én validert kilde til konfigurasjon. Kaster ved oppstart hvis noe mangler,
 * i stedet for å feile halvveis inne i en jobb tre timer senere.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  ENCRYPTION_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().optional(),
  EXTRACTION_MODEL: z.string().default("claude-opus-5"),
  INBOUND_EMAIL_DOMAIN: z.string().default("bilag.minapp.no"),
  INBOUND_WEBHOOK_SECRET: z.string().default("dev-secret"),
  INBOUND_PROVIDER: z.enum(["mailgun", "postmark", "mailhog"]).default("mailhog"),
  MAILHOG_API_URL: z.string().default("http://localhost:8025"),
  BLOB_DRIVER: z.enum(["local", "s3"]).default("local"),
  BLOB_LOCAL_PATH: z.string().default("./storage/blobs"),
  GOCARDLESS_SECRET_ID: z.string().optional(),
  GOCARDLESS_SECRET_KEY: z.string().optional(),
  GOCARDLESS_BASE_URL: z.string().default("https://bankaccountdata.gocardless.com/api/v2"),
  APP_URL: z.string().default("http://localhost:3000"),
  DEFAULT_PROFILE: z.string().default("generic"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function config(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Ugyldig konfigurasjon. Sjekk .env - problem med: ${missing}`);
  }
  cached = parsed.data;
  return cached;
}

/** Videresendingsadressen til en bruker. */
export function inboundAddress(slug: string): string {
  return `${slug}@${config().INBOUND_EMAIL_DOMAIN}`;
}

/** Lager en slug som er lett å lese høyt, men ikke gjettbar. */
export function generateInboundSlug(name: string): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[æ]/g, "ae")
      .replace(/[ø]/g, "o")
      .replace(/[å]/g, "a")
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 12) || "bilag";
  const suffix = Math.random().toString(16).slice(2, 6);
  return `${base}-${suffix}`;
}
