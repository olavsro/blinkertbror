/**
 * Jobbkøen sett fra webprosessen.
 *
 * Web SENDER jobber, den utfører dem ikke: `supervise: false` og
 * `schedule: false`. Kjørte web også vedlikehold og cron, ville de to
 * prosessene konkurrert om de samme radene og dratt hverandre ned.
 *
 * Instansen caches på globalThis, ikke i en modulvariabel, fordi Next sin hot
 * reload laster modulen på nytt ved hver endring. Uten cachen ville vi åpnet
 * en ny pg-boss-tilkobling per lagring i utvikling til databasen sa nei.
 */
import { createQueue, type PgBoss } from "@qbikk/jobs";

const globalRef = globalThis as unknown as { __qbikkBoss?: Promise<PgBoss> };

export function getQueue(): Promise<PgBoss> {
  if (!globalRef.__qbikkBoss) {
    globalRef.__qbikkBoss = createQueue({ supervise: false, schedule: false });
  }
  return globalRef.__qbikkBoss;
}
