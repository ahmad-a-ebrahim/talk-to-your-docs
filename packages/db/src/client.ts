import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type DbOptions = {
  /** Max pooled connections. Supabase's free-tier pooler allows few, so keep this modest. */
  maxConnections?: number;
  /**
   * TLS mode. Default: `'require'` unless the URL carries its own `?sslmode=...`, which wins.
   * Pass `false` only for a local or CI Postgres without TLS (e.g. `postgresql://localhost/test`).
   */
  ssl?: 'require' | false;
};

/** An explicit option wins, then the URL's own `sslmode`, then the secure default. */
function sslOption(databaseUrl: string, ssl: DbOptions['ssl']): { ssl?: 'require' | false } {
  if (ssl !== undefined) return { ssl };
  if (new URL(databaseUrl).searchParams.has('sslmode')) return {};
  return { ssl: 'require' };
}

/**
 * Creates a Drizzle client. Nothing connects at import time: the caller (API, scripts) owns the URL,
 * the lifecycle, and calls `close()` on shutdown.
 *
 * This connection logs in as `postgres`, which BYPASSES Row Level Security. Run anything done on behalf
 * of a user through `withUserContext` so RLS applies.
 */
export function createDb(databaseUrl: string, options: DbOptions = {}) {
  const client = postgres(databaseUrl, {
    max: options.maxConnections ?? 10,
    // Supabase's transaction pooler hands each transaction to whichever server connection is free, so a
    // statement prepared on one connection may be missing on the next. Per-request state is already
    // transaction-local (see withUserContext), so this is the only change the pooler needs.
    prepare: false,
    // Fail fast instead of hanging for postgres.js's 30s default when the pooler accepts TCP but stalls.
    connect_timeout: 10,
    // Never send credentials or documents over the internet unencrypted. 'require' encrypts but doesn't
    // verify the server certificate; pinning Supabase's CA is on the hardening list.
    ...sslOption(databaseUrl, options.ssl),
  });
  const db = drizzle(client, { schema });
  return {
    db,
    close: () => client.end({ timeout: 5 }),
  };
}

export type Database = ReturnType<typeof createDb>['db'];

/** Cheap round-trip used by readiness checks. Throws if the database is unreachable. */
export async function pingDatabase(db: Database): Promise<void> {
  await db.execute(sql`select 1`);
}
