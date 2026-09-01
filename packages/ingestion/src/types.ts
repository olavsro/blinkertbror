/**
 * Grensesnittet ALLE inntakskanaler implementerer.
 *
 * Dette er systemets viktigste abstraksjon. Alt bak dette punktet - rålagring,
 * ekstraksjon, normalisering, dedup, matching, dashboard - vet ingenting om
 * hvor et bilag kom fra. Konsekvensene:
 *
 *  - Å legge til en kanal er å skrive én fil. Ingen andre filer endres.
 *  - Browserautomatisering (kanal 5) er skjør, men skjørheten stopper her.
 *    Den kan feile, timeoute og bli utdatert uten at noe annet påvirkes.
 *  - En DJ og en frisør bruker de samme kanalene med de samme kodeveiene.
 *
 * En kanal gjør nøyaktig én ting: den produserer `IngestionItem`. Den lagrer
 * ingenting, kaller ingen LLM og vet ikke hva et bilag er.
 */
import type { z } from "zod";

export type ChannelType =
  | "email_forward"
  | "inbox_scan"
  | "bank"
  | "file_upload"
  | "folder_watch"
  | "browser";

/* -------------------------------------------------------------- resultater */

export interface IncomingAttachment {
  filename: string | null;
  mime: string;
  data: Buffer;
  /** Content-ID for innebygde bilder - de er som regel logoer, ikke bilag. */
  contentId?: string | null;
  inline?: boolean;
}

/** Et dokument: e-post, PDF, bilde, nedlastet fil. Går til ekstraksjon. */
export interface DocumentItem {
  kind: "document";
  /** Kanalens egen id. Brukes til inkrementell synk og som dedup-signal. */
  externalRef: string | null;
  receivedAt: Date;
  subject: string | null;
  sender: string | null;
  recipient: string | null;
  text: string | null;
  html: string | null;
  /** Hele den rå byte-strømmen slik den kom inn. Lagres uendret. */
  raw: Buffer | null;
  rawMime: string;
  attachments: IncomingAttachment[];
  /** Alt kanalen fikk med seg: hoder, webhook-body, API-respons. */
  rawPayload: Record<string, unknown>;
}

/** En banktransaksjon. Blir et bilag uten dokumentasjon, og matches senere. */
export interface TransactionItem {
  kind: "transaction";
  externalId: string;
  accountId: string;
  bookingDate: string;
  valueDate: string | null;
  /** I minste enhet, med fortegn: negativ = utgående betaling. */
  amount: number;
  currency: string;
  counterpartyName: string | null;
  counterpartyAccount: string | null;
  remittanceInfo: string | null;
  rawPayload: Record<string, unknown>;
}

export type IngestionItem = DocumentItem | TransactionItem;

/* ------------------------------------------------------------- kjørekontekst */

export type Cursor = Record<string, unknown>;

export interface ChannelLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface ChannelContext<C = unknown> {
  userId: string;
  channelId: string;
  /** Dekryptert konfigurasjon. Kanalen ser aldri chifferteksten. */
  config: C;
  /** Hvor forrige kjøring stoppet. Null ved første kjøring eller full backfill. */
  cursor: Cursor | null;
  logger: ChannelLogger;
  /** Avbrytes ved timeout eller nedstenging. Kanaler SKAL respektere den. */
  signal: AbortSignal;
}

export interface ChannelCapabilities {
  /** Kanalen mottar data uoppfordret (webhook). */
  push: boolean;
  /** Kanalen kan spørres på timeplan. */
  pull: boolean;
  /** Kanalen kan hente historikk bakover i tid. */
  backfill: boolean;
  producesDocuments: boolean;
  producesTransactions: boolean;
  requiresCredentials: boolean;
  /**
   * Sann for kanaler som kan brekke uten forvarsel (browserautomatisering).
   * Orkestratoren gir disse egen retry-policy og lar dem aldri blokkere
   * de robuste kanalene.
   */
  fragile: boolean;
}

export interface ChannelHealth {
  ok: boolean;
  message: string;
  /** Sann når brukeren må gjøre noe: logge inn på nytt, godkjenne banken igjen. */
  needsUserAction?: boolean;
  checkedAt: Date;
}

/** Det brukeren må gjøre for å ta kanalen i bruk. Skal alltid være få klikk. */
export interface SetupInstruction {
  title: string;
  body: string;
  /** Verdi brukeren skal kopiere, f.eks. videresendingsadressen sin. */
  copyValue?: string;
  /** Lenke brukeren skal følge, f.eks. bankens samtykkeside. */
  actionUrl?: string;
}

export interface SetupResult {
  /** Konfigurasjon som skal krypteres og lagres. */
  config: Record<string, unknown>;
  /** Ikke-hemmelig konfig som trygt kan vises i UI. */
  meta?: Record<string, unknown>;
  instructions: SetupInstruction[];
  /** Sann når oppsettet må fullføres av brukeren (OAuth-redirect e.l.). */
  pending?: boolean;
}

/* ------------------------------------------------------------ grensesnittet */

export interface IngestionChannel<TConfig = unknown, TWebhook = unknown> {
  readonly type: ChannelType;
  /** Navn i UI. */
  readonly label: string;
  readonly capabilities: ChannelCapabilities;
  /** Validerer og typer konfigurasjonen. Én kilde til sannhet for kanalens felter. */
  readonly configSchema: z.ZodType<TConfig>;

  /**
   * Kobler til. Returnerer konfigurasjon som skal lagres kryptert, og
   * instruksjonene brukeren skal se. Kravet er få klikk - brukeren skal
   * aldri bygge en flow.
   */
  setup(input: { userId: string; params: Record<string, unknown> }): Promise<SetupResult>;

  healthCheck(ctx: ChannelContext<TConfig>): Promise<ChannelHealth>;

  /**
   * Henter nye elementer. Implementeres av kanaler med `pull: true`.
   * Async iterator, ikke array: en IMAP-backfill over fem år skal ikke
   * bygge alt i minne før noe lagres.
   */
  pull?(ctx: ChannelContext<TConfig>, options?: { since?: Date; full?: boolean }): AsyncIterable<IngestionItem>;

  /** Tar imot push. Implementeres av kanaler med `push: true`. */
  receive?(ctx: Omit<ChannelContext<TConfig>, "cursor">, payload: TWebhook): Promise<IngestionItem[]>;

  /** Posisjonen neste kjøring skal starte fra. */
  nextCursor?(items: IngestionItem[], previous: Cursor | null): Cursor;

  /** Rydder opp: lukker forbindelser, tilbakekaller tokens. */
  teardown?(ctx: ChannelContext<TConfig>): Promise<void>;
}

/** Kastes når kanalen trenger at brukeren gjør noe - skal ikke retryes blindt. */
export class ChannelAuthError extends Error {
  readonly needsUserAction = true;
  constructor(message: string) {
    super(message);
    this.name = "ChannelAuthError";
  }
}

/** Midlertidig feil. Orkestratoren prøver igjen med backoff. */
export class ChannelTemporaryError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ChannelTemporaryError";
  }
}
