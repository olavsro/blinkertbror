/**
 * Jobbkø på pg-boss.
 *
 * Hvorfor pg-boss og ikke n8n eller en egen broker: køen ligger i den samme
 * PostgreSQL-databasen som bilagene. Det gir oss én ting å drifte, jobber som
 * kan sendes i samme transaksjon som dataene de gjelder, typede payloads i
 * git, og ordentlige stacktraces. Brukeren skal aldri se en flow, så det
 * visuelle en orkestrator gir oss er verdiløst her.
 *
 * Retry-policy settes PER KØ i `QUEUE_DEFS` og kan overstyres per jobb.
 * Kø-definisjonene er sannheten - `createQueue()` kjører `createQueue` for
 * hver av dem ved oppstart, som er idempotent.
 */
import PgBoss from "pg-boss";
import { JOBS, type JobPayloads } from "./names.js";

/**
 * Køene og hvor hardt de skal prøve igjen.
 *
 * Tallene er valgt etter hva som faktisk feiler:
 *  - databaseskriving feiler sjelden og kortvarig  -> mange, raske forsøk
 *  - LLM-kall feiler på rate limit                 -> få forsøk, lange pauser
 *  - kanalsynk feiler på nettverk og tokens        -> middels
 *  - browserkanaler feiler fordi nettsider endrer seg, og det fikser seg
 *    ikke av å prøve igjen -> ett forsøk, lang pause, egen kø
 */
export const QUEUE_DEFS: PgBoss.Queue[] = [
  {
    name: JOBS.ingestDocument,
    retryLimit: 5,
    retryDelay: 5,
    retryBackoff: true,
    expireInMinutes: 5,
    deadLetter: JOBS.deadLetter,
  },
  {
    name: JOBS.extractDocument,
    // Ekstraksjon koster penger. Fire forsøk med backoff fra 30 s dekker en
    // rate limit-topp uten å brenne budsjettet på et dokument som uansett
    // ikke lar seg lese.
    retryLimit: 4,
    retryDelay: 30,
    retryBackoff: true,
    expireInMinutes: 10,
    deadLetter: JOBS.deadLetter,
  },
  {
    name: JOBS.syncChannel,
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInMinutes: 30,
    deadLetter: JOBS.deadLetter,
  },
  {
    name: JOBS.syncChannelFragile,
    // `singleton` = én aktiv jobb om gangen i denne køen. En browserkanal som
    // henger skal ikke få selskap av tre til.
    policy: "singleton",
    retryLimit: 1,
    retryDelay: 900,
    retryBackoff: false,
    expireInMinutes: 10,
    deadLetter: JOBS.deadLetter,
  },
  {
    name: JOBS.matchVouchers,
    retryLimit: 3,
    retryDelay: 10,
    retryBackoff: true,
    expireInMinutes: 10,
    deadLetter: JOBS.deadLetter,
  },
  {
    name: JOBS.fetchFxRate,
    retryLimit: 5,
    retryDelay: 60,
    retryBackoff: true,
    expireInMinutes: 5,
    deadLetter: JOBS.deadLetter,
  },
  {
    name: JOBS.scheduleSyncs,
    // Fordelingsjobben skal aldri hope seg opp: er den forrige ikke ferdig,
    // er det ingen vits i å starte en til.
    policy: "singleton",
    retryLimit: 2,
    retryDelay: 60,
    expireInMinutes: 5,
  },
  {
    // Endestasjonen. Ingen retry - det er hit ting kommer NÅR retry er brukt opp.
    // Beholdes lenge slik at «krever handling» kan vise hva som gikk galt.
    name: JOBS.deadLetter,
    retryLimit: 0,
    retentionDays: 30,
  },
];

export interface QueueOptions {
  connectionString?: string;
  /** Skru av jobbhenting - web-prosessen sender jobber, den utfører dem ikke. */
  supervise?: boolean;
  schedule?: boolean;
}

/**
 * Starter pg-boss mot samme database som resten av systemet og sørger for at
 * alle køene finnes. Idempotent: trygt å kalle fra både web og worker.
 */
export async function createQueue(options: QueueOptions = {}): Promise<PgBoss> {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL mangler - jobbkøen kan ikke starte");

  const boss = new PgBoss({
    connectionString,
    // Vedlikehold og planlegging hører hjemme i worker-prosessen. Kjører web
    // og worker begge med dette på, konkurrerer de om de samme radene.
    supervise: options.supervise ?? false,
    schedule: options.schedule ?? false,
    // pg-boss lager sitt eget skjema. Holder køen unna våre 15 tabeller.
    schema: "pgboss",
  });

  // Uten en lytter kaster EventEmitter ved feil og river ned prosessen.
  boss.on("error", (err) => console.error("[jobs] pg-boss-feil:", err));

  await boss.start();

  // Rekkefølgen er ikke likegyldig: pg-boss har en fremmednøkkel fra
  // `queue.dead_letter` til `queue.name`, så en kø kan ikke peke på en
  // dead letter-kø som ikke finnes ennå. Vi oppretter derfor alle køer som
  // brukes SOM dead letter først.
  const deadLetterTargets = new Set(QUEUE_DEFS.map((q) => q.deadLetter).filter((n): n is string => Boolean(n)));
  const ordered = [
    ...QUEUE_DEFS.filter((q) => deadLetterTargets.has(q.name)),
    ...QUEUE_DEFS.filter((q) => !deadLetterTargets.has(q.name)),
  ];

  for (const queue of ordered) {
    await boss.createQueue(queue.name, queue);
  }
  return boss;
}

/** Typet send. Feil payload for et jobbnavn blir en kompileringsfeil. */
export async function sendJob<N extends keyof JobPayloads>(
  boss: PgBoss,
  name: N,
  data: JobPayloads[N],
  options?: PgBoss.SendOptions,
): Promise<string | null> {
  return boss.send(name, data as object, options ?? {});
}

/** Typet work. Handleren får ÉN jobb om gangen; batching skjuler feil. */
export async function workJob<N extends keyof JobPayloads>(
  boss: PgBoss,
  name: N,
  handler: (data: JobPayloads[N], job: PgBoss.Job<JobPayloads[N]>) => Promise<void>,
  options?: PgBoss.WorkOptions,
): Promise<string> {
  return boss.work<JobPayloads[N]>(name, options ?? {}, async (jobs) => {
    for (const job of jobs) {
      await handler(job.data, job);
    }
  });
}

/**
 * Sender en jobb som ikke skal dupliseres innenfor et tidsvindu.
 *
 * Brukes til ting som ellers ville tordnet: fem bilag i samme valuta og dato
 * skal utløse ÉN kursjobb, ikke fem.
 */
export async function sendUnique<N extends keyof JobPayloads>(
  boss: PgBoss,
  name: N,
  data: JobPayloads[N],
  singletonKey: string,
  seconds = 60,
): Promise<string | null> {
  return sendJob(boss, name, data, { singletonKey, singletonSeconds: seconds });
}

export { PgBoss };
export type { Job, WorkOptions, SendOptions } from "pg-boss";
