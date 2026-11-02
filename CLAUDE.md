# CLAUDE.md

Multi-tenant RAG platform: upload documents, chat with them, get answers with citations.
**Read `PROJECT_HANDOFF.md` first** for goals, working style and the roadmap. This file holds the current
milestone's scope plus decisions already settled. On the current step, this file wins.

## Current milestone: 1 — Monorepo scaffold + Drizzle schema + pgvector

Scope:

- npm-workspaces monorepo: `apps/api` (Express 5 + TS), `apps/web` (bare Next.js, untouched until M5), `packages/db`
- Drizzle schema for `documents`, `chunks`, `conversations`, `messages`, with RLS policies
- Migrations: enable pgvector → tables/indexes/policies → `updated_at` triggers + least-privilege grants
- `withUserContext` helper (run queries as a Supabase user so RLS applies)
- API: env validation, `GET /health` (liveness), `GET /health/ready` (DB ping); nothing else

Done when: migrations applied to Supabase, `npm run db:smoke` passes, `npm run typecheck` passes,
API starts and `/health/ready` returns 200. Then stop for review. Do not start M2.

**Status (2026-11-02):** all done criteria met; awaiting Ahmad's review before M2.

## Settled decisions (don't re-litigate without a new reason)

| Topic            | Decision                                                                                              | Why                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Package manager  | npm workspaces                                                                                        | Already installed, nothing extra; fine at this repo size                                               |
| `user_id`        | FK straight to `auth.users(id)`, `on delete cascade`                                                  | Simplest; add a separate per-user table later only if needed (plan/quotas)                             |
| Tenant isolation | RLS on every table **and** Express runs user requests as the user via `withUserContext`               | Postgres enforces isolation; a forgotten `where` fails closed                                          |
| Ownership model  | Every table has `user_id`; children use composite FKs `(parent_id, user_id)` → parent `(id, user_id)` | DB guarantees owners line up, so every policy is one line: `user_id = (select auth.uid())`             |
| Embeddings       | Supabase `gte-small`, `vector(384)`, cosine distance, HNSW index                                      | Free, no extra key. English-only, 512-token input cap                                                  |
| Storage paths    | `documents.storage_path` must match `^<user_id>/<safe-name>$` (CHECK constraint)                      | n8n downloads by path with privileged creds; stops cross-tenant file reads                             |
| Citations        | `messages.cited_chunk_ids uuid[]` (no FK)                                                             | Simple; RLS on `chunks` stops IDs resolving to other users' data                                       |
| DB connection    | Supabase **transaction pooler** (port 6543), `prepare: false`, `ssl: 'require'` (set in `createDb`)   | Port 5432 (session pooler) is blocked on Ahmad's network; all per-request state is transaction-local   |
| Migrations       | `npm run db:migrate` → `scripts/migrate.ts` (Drizzle migrator), not `drizzle-kit migrate`             | Same SSL/pooler settings as the app; all pending migrations apply in one transaction                   |
| DB driver        | `postgres` (postgres.js) **3.x**, not 4.x                                                             | Drizzle 0.45's driver is written against v3 internals; v4 changed parameter typing and transactions    |
| TypeScript       | **5.x** in every workspace                                                                            | TS 7 (Go port) lacks the JS API that Next.js and typescript-eslint use; one compiler version repo-wide |

## Layout & commands

```
apps/api        Express API. Dev: tsx watch. Build: tsup (bundles @ttyd/* workspace source)
apps/web        Next.js (App Router, Tailwind)
packages/db     Drizzle schema, client, withUserContext, migrations, smoke test
```

From the repo root:

- `npm run dev:api` / `npm run dev:web`
- `npm run typecheck` — all workspaces
- `npm run db:generate` — create a migration from schema changes
- `npm run db:migrate` — apply pending migrations to Supabase
- `npm run db:smoke` — end-to-end check of pgvector, constraints, RLS

## Rules for working in this repo

- **Anything done on behalf of a user goes through `withUserContext(db, userId, fn)`.** The raw `db` connection
  is `postgres`, which bypasses RLS. `userId` comes only from a verified JWT, never from request input.
- **New table checklist:** `user_id` column + RLS policies in the schema, and add explicit `grant`s in a custom
  migration. Supabase grants `anon`/`authenticated` everything on new `public` tables by default; we revoke
  that and grant only what users need.
- Grants decide _which actions_ a role may attempt; RLS policies decide _which rows_.
- Migrations: never edit an applied migration. Extensions, triggers, functions and grants go in custom migrations
  (`npx drizzle-kit generate --custom --name=<name>` inside `packages/db`).
- Secrets live only in the repo-root `.env` (git-ignored). Keep `.env.example` current. Validate env with zod at startup.
- ESM everywhere, strict TypeScript, Prettier formatting. Match existing comment style: explain _why_, not _what_.

## Notes for later milestones

- **M3 chunking:** gte-small truncates input beyond 512 tokens _of its own tokenizer_. Target ~300–400 tokens per
  chunk (not 500) so nothing is silently dropped from the embedding.
- **M3/M4 embeddings:** gte-small only runs inside a Supabase Edge Function (`Supabase.ai.Session`). Build one
  `embed` function used by both n8n (chunks) and Express (questions). Use `mean_pool: true, normalize: true`.
- **M3 n8n access:** give n8n a dedicated least-privilege Postgres role (read `documents`, write `chunks`, update
  status) rather than the `postgres` superuser.
- **M4 retrieval:** with RLS/user filtering, HNSW can return fewer than k rows. The project has pgvector 0.8.x,
  so use `set local hnsw.iterative_scan = relaxed_order` inside the search transaction.
- **M6 hardening:** upgrade DB SSL from `require` (encrypted) to certificate verification with Supabase's CA cert.
  Supabase also has an `ensure_rls` event trigger that auto-enables RLS on new `public` tables (safety net, not a substitute).
- **M5 frontend:** follow `apps/web/AGENTS.md`. This Next.js version (16.x) has breaking changes; read the docs
  bundled in `node_modules/next/dist/docs/` before writing Next code.
