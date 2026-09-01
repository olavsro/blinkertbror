/**
 * Laster `.env` fra ROTEN av monorepoet.
 *
 * Problemet: `dotenv/config` leser fra `process.cwd()`. Workeren starter i
 * `apps/worker` og Next i `apps/web`, så begge ville lett etter en `.env` som
 * ikke finnes der - og feilet på «DATABASE_URL mangler» selv om fila ligger
 * to nivåer opp. Én `.env` i roten er riktig for et monorepo; da må vi finne
 * den selv.
 *
 * Egen parser i stedet for dotenv: `core` har i dag bare `@qbikk/db` og `zod`
 * som avhengigheter, og en 40-liners parser er billigere enn å utvide den
 * lista for noe så lite.
 *
 * MERK: eksporteres bevisst IKKE fra `index.ts`. Den leser filsystemet og har
 * ingenting i en klientbundle å gjøre.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Setter variabler fra nærmeste `.env` oppover i katalogtreet.
 *
 * Variabler som ALLEREDE finnes i miljøet vinner. Det er regelen som gjør at
 * `DATABASE_URL=... pnpm dev` og en ekte produksjonskonfig overstyrer fila,
 * i stedet for at en glemt `.env` stille overkjører dem.
 */
export function loadRootEnv(startDir = process.cwd()): string | null {
  const file = findEnvFile(startDir);
  if (!file) return null;

  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return file;
}

/**
 * Roten av monorepoet - katalogen som inneholder `pnpm-workspace.yaml`.
 *
 * Trengs fordi prosessene starter i hver sin katalog: web i `apps/web`,
 * worker i `apps/worker`, scripts i roten. Alt som er konfigurert med en
 * RELATIV sti må resolves mot det samme punktet, ellers peker den samme
 * konfigurasjonsverdien på tre ulike steder. Se `storage.ts`.
 */
export function findRepoRoot(startDir = process.cwd()): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findEnvFile(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    // Roten av monorepoet kjenner vi igjen på workspace-fila. Stopper vi ikke
    // der, kan vi ende med å plukke opp en fremmed .env utenfor prosjektet.
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!key) continue;

    let value = line.slice(eq + 1).trim();

    // Sitater beholder mellomrom og #; uten sitater er alt etter en # en
    // kommentar. Det er den samme regelen dotenv bruker, og den folk forventer.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
      if (rawLine.includes('"')) value = value.replace(/\\n/g, "\n");
    } else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }

  return out;
}
