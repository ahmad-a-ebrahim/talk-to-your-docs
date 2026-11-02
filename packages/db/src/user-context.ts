import { sql } from 'drizzle-orm';
import type { Database } from './client';

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Runs `fn` in a transaction AS the given Supabase user, so Postgres enforces Row Level Security.
 *
 * Our connection logs in as `postgres`, which bypasses RLS. Here we switch to the `authenticated` role and set
 * the JWT claims that `auth.uid()` reads. That's the same thing Supabase's own Data API does on every request.
 * A forgotten `WHERE user_id = ...` therefore returns nothing instead of another user's data.
 *
 * Both settings use `is_local = true`: they end with this transaction, so they can't leak into the next request
 * that reuses the pooled connection. Values go in as bind parameters, never string-concatenated into SQL.
 *
 * `userId` must come from a verified JWT, never from request input.
 */
export async function withUserContext<T>(
  db: Database,
  userId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const claims = JSON.stringify({ sub: userId, role: 'authenticated' });

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('request.jwt.claims', ${claims}, true),
        set_config('role', 'authenticated', true)
    `);
    return fn(tx);
  });
}
