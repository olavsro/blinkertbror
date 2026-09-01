import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://qbikk:qbikk@localhost:5433/qbikk",
  },
  strict: false,
  verbose: true,
} satisfies Config;
