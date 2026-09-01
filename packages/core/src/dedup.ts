/**
 * Deduplisering i tre lag.
 *
 *  Lag 1 - RÅBYTES: sha256 over dokumentets bytes. Samme e-post videresendt to
 *          ganger blir ett `raw_documents`-rad. Håndheves av unique index.
 *  Lag 2 - BILAGSIDENTITET: en forretningsnøkkel per bilag. Samme kvittering
 *          som kommer inn både fra videresending og fra IMAP-backfill blir
 *          ett bilag. Håndheves av unique index på (user_id, dedup_hash).
 *  Lag 3 - MATCHING: bank og dokument har med vilje ULIKE dedup-hasher, fordi
 *          de skal eksistere samtidig og kobles av matcheren. Se matching.ts.
 *
 * Poenget med lag 3: hadde de fått samme hash, ville den andre importen blitt
 * stille avvist av unique-indeksen, og vi hadde mistet enten bankfasiten eller
 * dokumentasjonen.
 */
import { createHash } from "node:crypto";
import { normalizeCounterparty } from "./text.js";

export type VoucherOrigin = "bank" | "document";

export interface DedupInput {
  userId: string;
  /** "bank" eller "document" - holder bankbilag og dokumentbilag fra hverandre. */
  origin: VoucherOrigin;
  date: string;
  direction: "income" | "expense";
  /** I øre, alltid positivt. */
  amountNok: number;
  currency: string;
  counterpartyName: string | null | undefined;
  /** Fakturanummer/ordre-id/bank-transaksjonsid hvis den finnes - sterkeste signalet. */
  externalRef?: string | null;
}

export function sha256(input: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Forretningsnøkkel for et bilag.
 *
 * Med `externalRef` er nøkkelen leverandørens egen id, som er den mest
 * pålitelige identiteten vi kan få. Uten den faller vi tilbake på
 * (dato, retning, beløp, valuta, normalisert motpart), som er nok til å fange
 * den samme kvitteringen importert fra to kanaler.
 */
export function dedupHash(input: DedupInput): string {
  const parts = input.externalRef
    ? [input.userId, input.origin, "ref", normalizeCounterparty(input.counterpartyName), input.externalRef.trim().toLowerCase()]
    : [
        input.userId,
        input.origin,
        "key",
        input.date,
        input.direction,
        String(Math.abs(input.amountNok)),
        input.currency.toUpperCase(),
        normalizeCounterparty(input.counterpartyName),
      ];
  return sha256(parts.join("|"));
}

/**
 * Myk dublett-mistanke: to bilag med samme opprinnelse, samme beløp og
 * nesten samme dato, men uten sammenfallende nøkkel. Havner i
 * "krever handling" som *mulig* duplikat - aldri slettet automatisk.
 */
export function isProbableDuplicate(
  a: { date: string; amountNok: number; direction: string; counterpartyName: string | null },
  b: { date: string; amountNok: number; direction: string; counterpartyName: string | null },
  windowDays = 2,
): boolean {
  if (a.direction !== b.direction) return false;
  if (a.amountNok !== b.amountNok) return false;
  if (Math.abs(daysBetween(a.date, b.date)) > windowDays) return false;
  return normalizeCounterparty(a.counterpartyName) === normalizeCounterparty(b.counterpartyName);
}

export function daysBetween(a: string, b: string): number {
  const da = Date.parse(a.length === 10 ? `${a}T00:00:00Z` : a);
  const db = Date.parse(b.length === 10 ? `${b}T00:00:00Z` : b);
  return Math.round((da - db) / 86_400_000);
}
