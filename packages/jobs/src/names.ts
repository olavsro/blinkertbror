/**
 * Jobbnavn og payloads - ett sted.
 *
 * Navnene er strenger i databasen (pg-boss lagrer dem i `pgboss.job`), så de
 * er en del av datamodellen: endrer du en streng, mister du jobbene som
 * allerede ligger i køen. Legg heller til et nytt navn og la det gamle dø ut.
 *
 * `JobPayloads` binder navn til payload-type. Alle send/work går gjennom de
 * typede innpakningene i `queue.ts`, så en jobb med feil payload er en
 * kompileringsfeil og ikke en 03:00-feil i produksjon.
 */

export const JOBS = {
  /** Lagre et allerede mottatt dokument og sette i gang ekstraksjon. */
  ingestDocument: "ingest.document",
  /** Kjør (eller kjør om) ekstraksjon for ett rådokument. */
  extractDocument: "extract.document",
  /** Hent nye elementer fra en robust kanal (e-post, IMAP, bank, mappe). */
  syncChannel: "channel.sync",
  /**
   * Samme jobb for skjøre kanaler (browserautomatisering).
   *
   * Egen kø med vilje: en browserkanal som henger i ti minutter skal ikke
   * legge seg foran bank- og e-postsynken. Skjørheten stopper i sin egen kø,
   * på samme måte som den stopper bak `IngestionChannel`-grensesnittet.
   */
  syncChannelFragile: "channel.sync.fragile",
  /** Foreslå (og evt. utføre) matcher mellom bankbilag og dokumentbilag. */
  matchVouchers: "match.run",
  /** Hent og cache en valutakurs fra Norges Bank. */
  fetchFxRate: "fx.fetch",
  /**
   * Cron-jobben som fordeler arbeidet.
   *
   * pg-boss sin innebygde cron kan bare sende ÉN fast payload, og en synk
   * trenger en channelId. Derfor fyrer cronen denne jobben, som slår opp
   * aktive kanaler og sender én synkjobb per kanal. Da slipper vi å skrive
   * om timeplanen hver gang en bruker kobler til en ny konto.
   */
  scheduleSyncs: "channel.schedule",
  /** Jobber som har brukt opp retryene sine. Vises i «krever handling». */
  deadLetter: "dead-letter",
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

export interface SyncChannelPayload {
  userId: string;
  channelId: string;
  /** Full backfill i stedet for inkrementell synk fra cursor. */
  full?: boolean;
  trigger?: "schedule" | "manual" | "webhook" | "backfill";
}

/**
 * Payload per jobbnavn. Nøklene er skrevet ut som literaler og ikke som
 * `[JOBS.x]`, fordi TypeScript ikke tillater computed keys i en interface.
 * `assertNamesMatchPayloads` under fanger opp hvis de to kommer i utakt.
 */
export interface JobPayloads {
  "ingest.document": { userId: string; rawDocumentId: string };
  "extract.document": { userId: string; rawDocumentId: string; force?: boolean };
  "channel.sync": SyncChannelPayload;
  "channel.sync.fragile": SyncChannelPayload;
  "match.run": { userId: string; voucherId?: string };
  "fx.fetch": { currency: string; date: string };
  "channel.schedule": { userId?: string };
  "dead-letter": Record<string, unknown>;
}

/** Kompileringsfeil hvis JOBS og JobPayloads ikke dekker nøyaktig samme navn. */
type AssertSameKeys<A extends B, B> = A;
export type _NamesMatchPayloads = AssertSameKeys<JobName, keyof JobPayloads> &
  AssertSameKeys<keyof JobPayloads, JobName>;

/** Kø-navnet en kanal skal synkes på. Skjøre kanaler holdes for seg selv. */
export function syncQueueFor(fragile: boolean): typeof JOBS.syncChannel | typeof JOBS.syncChannelFragile {
  return fragile ? JOBS.syncChannelFragile : JOBS.syncChannel;
}
