/**
 * Worker - jobbkonsumenten.
 *
 * Egen prosess fra web, av én grunn: en ekstraksjon tar sekunder til minutter,
 * og en backfill over fem år tar timer. Ingenting av det hører hjemme i en
 * HTTP-request. Web tar imot og svarer 200; her skjer arbeidet.
 *
 * Denne prosessen er også den ENESTE som kjører pg-boss sitt vedlikehold og
 * cron (`supervise`/`schedule`). Kjørte web det samme, ville de to
 * konkurrert om de samme radene.
 */
// Først av alt - resten av importene forventer at miljøet er lastet.
import "./env.js";
import { config } from "@qbikk/core/config";
import { createQueue, JOBS, sendJob } from "@qbikk/jobs";
import { registerHandlers } from "./handlers.js";
import { countUsers } from "./sync.js";

/**
 * Hvert kvarter. Kanalene har sine egne grenser på hvor ofte de FAKTISK
 * henter (browserkanalen minst én gang i døgnet), så dette er bare hvor ofte
 * vi ser etter noe å gjøre.
 */
const SYNC_CRON = process.env.SYNC_CRON ?? "*/15 * * * *";

async function main(): Promise<void> {
  // Validerer hele miljøet før vi kobler til noe. En manglende ENCRYPTION_KEY
  // skal stoppe oppstarten, ikke dukke opp midt i en dekryptering om tre timer.
  const cfg = config();

  const boss = await createQueue({ supervise: true, schedule: true });
  await registerHandlers(boss);

  await boss.schedule(JOBS.scheduleSyncs, SYNC_CRON, {}, { tz: "Europe/Oslo" });

  // Én runde med en gang, så en nystartet worker ikke står stille i 15 minutter.
  await sendJob(boss, JOBS.scheduleSyncs, {});

  const users = await countUsers();
  console.log("");
  console.log(`  qbikk worker kjører`);
  console.log(`  database   ${redact(cfg.DATABASE_URL)}`);
  console.log(`  ekstraktor ${cfg.ANTHROPIC_API_KEY ? cfg.EXTRACTION_MODEL : "regelbasert fallback (ingen API-nøkkel)"}`);
  console.log(`  timeplan   ${SYNC_CRON} (Europe/Oslo)`);
  console.log(`  brukere    ${users}`);
  console.log("");

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n  ${signal} mottatt - lar jobber som kjører bli ferdige...`);
    // `graceful` lar aktive jobber fullføre. Å drepe en ekstraksjon midtveis
    // koster både penger og en halvskrevet rad.
    await boss.stop({ graceful: true, timeout: 30_000 }).catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function redact(url: string): string {
  return url.replace(/\/\/([^:]+):[^@]+@/, "//$1:***@");
}

main().catch((err: unknown) => {
  console.error("Workeren klarte ikke å starte:", err);
  process.exit(1);
});
