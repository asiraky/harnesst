/**
 * Server-only Drizzle client. The `.server.ts` suffix guarantees Vite never bundles the
 * Postgres driver into the browser build.
 *
 * We standardize on Postgres (D7): the same engine backs the Workflow World,
 * so the control plane reuses it. A single lazily-initialized connection pool is cached on
 * `globalThis` to survive dev HMR without leaking connections.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Add it to .env.local (e.g. postgres://user:pass@localhost:5432/eden).",
    );
  }
  return url;
}

type DbClient = ReturnType<typeof createClient>;

function createClient() {
  const client = postgres(getDatabaseUrl(), { max: 10 });
  return drizzle(client, { schema });
}

const globalForDb = globalThis as unknown as { __harnesstDb?: DbClient };

export const db: DbClient = globalForDb.__harnesstDb ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForDb.__harnesstDb = db;
}

export { schema };
