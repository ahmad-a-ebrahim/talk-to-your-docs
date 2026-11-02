import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';

// npm runs this package's scripts from packages/db, and secrets live in the repo-root .env.
// In CI/production the variables come from the environment instead, so a missing file is fine.
const rootEnv = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  // Only for drizzle-kit tools that connect (e.g. `studio`). `generate` never connects, and migrations
  // are applied by scripts/migrate.ts so they use the app's connection settings (SSL, pooler-safe).
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  // Supabase owns the auth/storage/realtime schemas and its built-in roles; never let drizzle-kit touch them.
  schemaFilter: ['public'],
  entities: { roles: { provider: 'supabase' } },
  strict: true,
  verbose: true,
});
