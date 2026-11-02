/**
 * Applies pending migrations from ./migrations. Drizzle runs them all in ONE transaction:
 * either every pending migration lands, or none do.
 *
 * We use this instead of `drizzle-kit migrate` so migrations connect exactly like the app does
 * (SSL required, safe for Supabase's transaction pooler).
 *
 * Run from the repo root: npm run db:migrate
 */
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from '../src';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    'DATABASE_URL is not set. Copy .env.example to .env at the repo root and fill it in.',
  );
  process.exit(1);
}

const { db, close } = createDb(databaseUrl, { maxConnections: 1 });
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

try {
  await migrate(db, { migrationsFolder });
  console.log('Migrations applied (or already up to date).');
} catch (err) {
  console.error(
    'Migration failed; the transaction was rolled back, so nothing was applied.\n',
    err,
  );
  process.exitCode = 1;
} finally {
  await close();
}
