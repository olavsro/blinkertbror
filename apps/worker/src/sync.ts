/**
 * Kjøring av én kanalsynk.
 *
 * Den eneste koden i systemet som vet at kanaler har en livssyklus: dekrypter
 * konfig, kjør `pull()`, lagre det som kommer, flytt cursoren, skriv logg.
 * Alt kanalspesifikt ligger bak `IngestionChannel` - denne filen kan ikke se
 * forskjell på IMAP og en Dropbox-mappe, og det er meningen.
 *
 * To feiltyper behandles ULIKT, og skillet er hele grunnen til at
 * ChannelAuthError finnes:
 *
 *   ChannelAuthError  - brukeren må gjøre noe (passord, banksamtykke).
 *                       Jobben ANSES SOM FULLFØRT. Å prøve igjen hver time i
 *                       tre uker hjelper ikke, og fyller bare dead letter-køen
 *                       med støy som skjuler ekte feil.
 *   alt annet         - midlertidig. Kastes videre slik at pg-boss retryer
 *                       med backoff.
 */
import {
  and,
  eq,
  getDb,
  ingestionChannels,
  syncRuns,
  users,
  type IngestionChannelRow,
} from "@qbikk/db";
import {
  getBlobStore,
  loadUserContext,
  storeRawDocument,
  upsertBankTransaction,
  type ChannelKind,
} from "@qbikk/core";
import { decryptJson } from "@qbikk/core/crypto";
import { getChannel } from "@qbikk/ingestion";
import {
  ChannelAuthError,
  type ChannelContext,
  type ChannelLogger,
  type Cursor,
  type IngestionItem,
} from "@qbikk/ingestion";
import { JOBS, sendJob, type PgBoss } from "@qbikk/jobs";

/** Ingen kanal får henge lenger enn dette. Signalet gis videre til kanalen. */
const SYNC_TIMEOUT_MS = 10 * 60 * 1000;

/** Så mange feil på rad før kanalen merkes `error` og vises i UI. */
const FAILURES_BEFORE_ERROR = 3;

export interface SyncResult {
  seen: number;
  created: number;
  duplicates: number;
  failed: number;
  status: "success" | "partial" | "failed";
  needsUserAction: boolean;
}

export async function runChannelSync(
  boss: PgBoss,
  input: { userId: string; channelId: string; full?: boolean; trigger?: "schedule" | "manual" | "webhook" | "backfill" },
): Promise<SyncResult> {
  const db = getDb();

  const [row] = await db
    .select()
    .from(ingestionChannels)
    .where(and(eq(ingestionChannels.id, input.channelId), eq(ingestionChannels.userId, input.userId)))
    .limit(1);
  if (!row) throw new Error(`Ukjent kanal: ${input.channelId}`);

  const channel = getChannel(row.type as Exclude<typeof row.type, "manual">);
  if (!channel.pull) {
    // Push-kanaler har ingenting å hente. Det er ikke en feil.
    return { seen: 0, created: 0, duplicates: 0, failed: 0, status: "success", needsUserAction: false };
  }

  const [runRow] = await db
    .insert(syncRuns)
    .values({
      userId: input.userId,
      channelId: row.id,
      trigger: input.trigger ?? "schedule",
      status: "running",
      cursorBefore: row.cursor ?? null,
    })
    .returning({ id: syncRuns.id });
  const runId = runRow?.id;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);

  const logger = prefixedLogger(`${row.type}:${row.name}`);
  const counts = { seen: 0, created: 0, duplicates: 0, failed: 0 };
  const collected: IngestionItem[] = [];

  try {
    const config = channel.configSchema.parse(row.configEncrypted ? decryptJson(row.configEncrypted) : {});

    const ctx: ChannelContext<never> = {
      userId: input.userId,
      channelId: row.id,
      config: config as never,
      cursor: (row.cursor ?? null) as Cursor | null,
      logger,
      signal: controller.signal,
    };

    const { profile, rules } = await loadUserContext(db, input.userId);

    for await (const item of channel.pull(ctx, { full: input.full === true })) {
      counts.seen++;
      collected.push(item);
      try {
        if (item.kind === "document") {
          const stored = await storeRawDocument(db, getBlobStore(), {
            userId: input.userId,
            channelId: row.id,
            channelType: row.type as ChannelKind,
            item,
          });
          if (stored.isDuplicate) {
            counts.duplicates++;
          } else {
            counts.created++;
            // Tung tolkning skjer i sin egen jobb. En backfill over fem år
            // skal ikke bli sittende og vente på LLM-kall for hvert dokument.
            await sendJob(boss, JOBS.extractDocument, {
              userId: input.userId,
              rawDocumentId: stored.rawDocumentId,
            });
          }
        } else {
          const result = await upsertBankTransaction(db, {
            userId: input.userId,
            channelId: row.id,
            profile,
            rules,
            tx: {
              externalId: item.externalId,
              accountId: item.accountId,
              bookingDate: item.bookingDate,
              valueDate: item.valueDate,
              amount: item.amount,
              currency: item.currency,
              counterpartyName: item.counterpartyName,
              counterpartyAccount: item.counterpartyAccount,
              remittanceInfo: item.remittanceInfo,
              rawPayload: item.rawPayload,
            },
          });
          if (result.isDuplicate) {
            counts.duplicates++;
          } else {
            counts.created++;
            // Et ferskt bankbilag skal lete etter kvitteringen sin med en gang.
            await sendJob(boss, JOBS.matchVouchers, {
              userId: input.userId,
              voucherId: result.voucherId,
            });
          }
        }
      } catch (err) {
        // Ett råttent element skal ikke velte hele synken. Vi teller det,
        // logger det og går videre - resten av backfillen er fortsatt verdt å ta.
        counts.failed++;
        logger.error("Klarte ikke å lagre element", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const nextCursor = channel.nextCursor ? channel.nextCursor(collected, (row.cursor ?? null) as Cursor | null) : row.cursor;

    await db
      .update(ingestionChannels)
      .set({
        cursor: nextCursor ?? null,
        lastSyncAt: new Date(),
        lastError: null,
        consecutiveFailures: 0,
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(ingestionChannels.id, row.id));

    const status = counts.failed > 0 ? "partial" : "success";
    await finishRun(db, runId, status, counts, nextCursor ?? null, null);
    logger.info("Synk ferdig", counts);

    return { ...counts, status, needsUserAction: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const needsUserAction = err instanceof ChannelAuthError;

    await markFailure(db, row, message, needsUserAction);
    await finishRun(db, runId, "failed", counts, null, message);

    if (needsUserAction) {
      // Bevisst IKKE kastet videre: brukeren må inn, og jobbkøen kan ikke
      // hjelpe. Kanalen står nå som `needs_auth` og dukker opp i UI.
      logger.warn("Kanalen krever handling fra brukeren", { message });
      return { ...counts, status: "failed", needsUserAction: true };
    }

    logger.error("Synk feilet", { message });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function finishRun(
  db: ReturnType<typeof getDb>,
  runId: string | undefined,
  status: "success" | "partial" | "failed",
  counts: { seen: number; created: number; duplicates: number; failed: number },
  cursorAfter: unknown,
  error: string | null,
): Promise<void> {
  if (!runId) return;
  await db
    .update(syncRuns)
    .set({
      status,
      finishedAt: new Date(),
      itemsSeen: counts.seen,
      itemsNew: counts.created,
      itemsDuplicate: counts.duplicates,
      itemsFailed: counts.failed,
      cursorAfter: cursorAfter as never,
      error,
    })
    .where(eq(syncRuns.id, runId));
}

async function markFailure(
  db: ReturnType<typeof getDb>,
  row: IngestionChannelRow,
  message: string,
  needsUserAction: boolean,
): Promise<void> {
  const failures = row.consecutiveFailures + 1;
  await db
    .update(ingestionChannels)
    .set({
      lastError: message,
      consecutiveFailures: failures,
      // `needs_auth` med en gang - det er en tilstand, ikke en flaks-feil.
      // `error` først etter noen forsøk, så en enkelt nettverksglipp ikke
      // farger kanalen rød i UI.
      status: needsUserAction ? "needs_auth" : failures >= FAILURES_BEFORE_ERROR ? "error" : row.status,
      updatedAt: new Date(),
    })
    .where(eq(ingestionChannels.id, row.id));
}

/**
 * Fordeler synkjobber til alle aktive kanaler som kan hentes fra.
 *
 * `singletonKey` per kanal gjør at en kanal som allerede står i kø ikke får
 * en til hver gang cronen fyrer. Uten det ville en treg backfill bygget opp
 * en haug identiske jobber.
 */
export async function scheduleChannelSyncs(boss: PgBoss, userId?: string): Promise<number> {
  const db = getDb();

  const rows = await db
    .select({
      id: ingestionChannels.id,
      userId: ingestionChannels.userId,
      type: ingestionChannels.type,
      status: ingestionChannels.status,
    })
    .from(ingestionChannels)
    .where(
      userId
        ? and(eq(ingestionChannels.status, "active"), eq(ingestionChannels.userId, userId))
        : eq(ingestionChannels.status, "active"),
    );

  let sent = 0;
  for (const row of rows) {
    const channel = getChannel(row.type as Exclude<typeof row.type, "manual">);
    if (!channel.capabilities.pull) continue;

    // Skjøre kanaler får sin egen kø. Se JOBS.syncChannelFragile.
    const queue = channel.capabilities.fragile ? JOBS.syncChannelFragile : JOBS.syncChannel;
    await sendJob(
      boss,
      queue,
      { userId: row.userId, channelId: row.id, trigger: "schedule" },
      { singletonKey: row.id, singletonSeconds: 300 },
    );
    sent++;
  }

  return sent;
}

/** Har brukeren i det hele tatt en kanal? Brukes bare til oppstartslogging. */
export async function countUsers(): Promise<number> {
  const db = getDb();
  const rows = await db.select({ id: users.id }).from(users);
  return rows.length;
}

function prefixedLogger(prefix: string): ChannelLogger {
  const line = (level: string, msg: string, meta?: Record<string, unknown>) => {
    const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
    console.log(`[${level}] [${prefix}] ${msg}${suffix}`);
  };
  return {
    debug: (m, meta) => (process.env.LOG_LEVEL === "debug" ? line("debug", m, meta) : undefined),
    info: (m, meta) => line("info", m, meta),
    warn: (m, meta) => line("warn", m, meta),
    error: (m, meta) => line("error", m, meta),
  };
}
