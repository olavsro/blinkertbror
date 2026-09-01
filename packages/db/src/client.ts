import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDb>["db"];

export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL mangler");
  // max: 1 i worker-prosessen holder connection-bruken forutsigbar under jobbkjøring.
  const sql = postgres(url, { max: Number(process.env.PG_POOL_MAX ?? 10) });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

let cached: ReturnType<typeof createDb> | undefined;

/** Delt instans. Next.js hot reload gjenbruker den via globalThis. */
export function getDb(): Database {
  const g = globalThis as unknown as { __qbikkDb?: ReturnType<typeof createDb> };
  if (!g.__qbikkDb) g.__qbikkDb = cached ?? createDb();
  cached = g.__qbikkDb;
  return g.__qbikkDb.db;
}

export { schema };
