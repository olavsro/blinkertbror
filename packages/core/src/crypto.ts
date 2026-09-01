/**
 * Kryptering av alt som er hemmelig i ro: IMAP-passord, OAuth-tokens,
 * GoCardless-nøkler, eventuelle portal-innlogginger.
 *
 * AES-256-GCM med tilfeldig IV per hemmelighet. Autentisert kryptering,
 * så en manipulert chiffertekst feiler ved dekryptering i stedet for å gi
 * søppel. Nøkkelen kommer fra ENCRYPTION_KEY og skal aldri ligge i repoet.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw.startsWith("CHANGE_ME")) {
    throw new Error(
      "ENCRYPTION_KEY mangler. Generer med: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("ENCRYPTION_KEY må være 32 bytes base64-kodet");
  return buf;
}

/** Returnerer "v1:<base64(iv|tag|ciphertext)>". Versjonsprefikset gjør nøkkelrotasjon mulig senere. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${Buffer.concat([iv, tag, enc]).toString("base64")}`;
}

export function decryptSecret(payload: string): string {
  const [version, data] = payload.split(":", 2);
  if (version !== "v1" || !data) throw new Error("Ukjent chiffertekst-format");
  const buf = Buffer.from(data, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const enc = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

/** JSON-konfig inn og ut. Kanalene lagrer hele config-objektet sitt slik. */
export function encryptJson(value: unknown): string {
  return encryptSecret(JSON.stringify(value));
}

export function decryptJson<T>(payload: string): T {
  return JSON.parse(decryptSecret(payload)) as T;
}

/** Til logging og UI: "abc***xyz". Aldri logg hele hemmeligheter. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}
