# Project Handoff: RAG Document Chat Platform

Read this first. It's the full picture of what we're building, why, and how we work. It sits alongside `CLAUDE.md` (which holds the current step's scope). If the two ever disagree on the current step, `CLAUDE.md` wins; for everything else, this file wins.

---

## 1. Who this is for

Ahmad, a frontend engineer (React, Next.js, TypeScript) with 2+ years of professional experience. He also has solid backend and database knowledge: Node, Express, Supabase, Postgres, MySQL, MongoDB, Prisma, Drizzle.

He finished a short training course with three simple n8n + RAG projects, so he knows the basic idea of RAG but hasn't built one at production level.

## 2. Why this project exists

Two goals, equally important:

1. **Learn.** Ahmad wants to understand everything that gets built and how it gets built. Not just working code, the reasoning behind it.
2. **Ship.** He wants a production-grade project for his portfolio that he can launch publicly and promote on his business page and LinkedIn.

Context behind the goals:
- He's shifting his career toward AI and plans to relocate to Germany, so this needs to hold up as evidence of real AI/RAG engineering skill.
- He's building a freelance career and lists **AI automation** and **RAG systems** as services. The finished project doubles as a demo and a reusable template for client work.

**Quality bar:** production-grade, not tutorial-grade. Error handling, input validation, auth on every route, no hardcoded secrets, sensible logging, code that would survive a real code review.

## 3. How we work (important)

All the building and learning happens in Claude Code sessions. There is no separate teaching chat to lean on, so **you (Claude Code) are also the teacher.**

- **Explain before you build.** For each meaningful decision, give the why and the tradeoffs first, in plain language, then implement.
- **Teach the concepts as they come up:** embeddings, vector similarity (cosine distance), chunking tradeoffs, why pgvector, retrieval vs generation, citations, prompt construction, and so on.
- **One milestone at a time.** Finish it, make sure it works, then pause for Ahmad's review before moving on. Don't build ahead.
- **Ask before assuming** on anything architectural. Ahmad would rather answer a question than undo a wrong guess.
- **After each milestone**, give a short recap he could use to explain it in an interview or to a client: what was built, why, and what the alternatives were.
- Keep explanations concise and natural. Skip heavy jargon and long lectures.

## 4. What we're building

A multi-tenant RAG platform. Users upload documents (PDF, DOCX, TXT). The system extracts text, chunks it, embeds the chunks, and stores them in Postgres with pgvector. Users then chat with an AI that answers using only their documents, and every answer shows **citations** back to the source chunks.

### Flow

1. User uploads a file in the Next.js app.
2. Express API validates it, stores it in Supabase Storage, creates a `documents` row, and triggers an n8n webhook.
3. n8n workflow: extract text, chunk (fixed-size), embed each chunk, insert into `chunks`, update document status.
4. User asks a question in the chat UI.
5. Express API: embed the question, similarity search in pgvector (scoped to the user's documents), build a prompt with the top chunks, call Groq, return the answer plus cited chunk IDs.
6. Frontend shows the answer with expandable source citations.

## 5. Tech stack and decisions

| Area | Choice | Notes |
|---|---|---|
| Repo | Monorepo, npm/pnpm workspaces | No Turborepo/Nx yet. Keep it simple. |
| API | Node.js + Express + TypeScript | |
| Frontend | Next.js (App Router) + TypeScript + Tailwind | Minimal UI from the start |
| DB / Auth / Storage | Supabase | Postgres + pgvector, Supabase Auth, Supabase Storage |
| ORM | Drizzle | Chosen because Ahmad had no preference: lightweight, strong TS inference, handles pgvector types |
| Embeddings | Supabase `gte-small` | Free, no extra API key. Groq has no embeddings API. |
| LLM | Groq (e.g. Llama 3.3) | Free tier, fast. Fine for a training/portfolio project. |
| Ingestion | n8n | Webhook-triggered pipeline. Shows automation skills, not just scripts. |
| Chunking (v1) | Fixed-size, ~500 tokens, ~50 overlap | Semantic chunking is a planned v2 upgrade. |
| File types (v1) | PDF, DOCX, TXT | |

Ahmad already has a Supabase project and an n8n instance set up.

### Draft data model (confirm before migrating)

- `documents`: id, user_id, filename, file_type, storage_path, status, created_at
- `chunks`: id, document_id, content, embedding (vector), chunk_index, created_at
- `conversations`: id, user_id, document_id (nullable, for cross-document chat), created_at
- `messages`: id, conversation_id, role, content, cited_chunk_ids, created_at

### Open questions to settle early

- **Vector dimension for `gte-small`.** I believe it's 384, but verify against the Supabase docs before creating the column. A mismatch breaks everything.
- **`user_id` relationship.** FK straight to Supabase's `auth.users`, or a separate `profiles` table? Explain the tradeoff to Ahmad and let him decide.
- **Row Level Security.** Multi-tenant means users must never see each other's chunks. Decide how RLS and the Express service-role key interact, and explain it clearly. This is a security-critical topic worth teaching properly.

## 6. Milestone roadmap

1. **Monorepo scaffold + Drizzle schema + pgvector setup** (current, see `CLAUDE.md`)
2. Express upload endpoint (validation, Storage, n8n webhook trigger)
3. n8n ingestion workflow (extract, chunk, embed, insert)
4. RAG query endpoint (embed question, similarity search, Groq completion, citations)
5. Next.js upload UI + chat UI with citations
6. Hardening pass: auth, rate limiting, error handling, logging, tests
7. Deployment and launch prep

## 7. Production-grade checklist (target by milestone 6-7)

- Auth required on every route, ownership checks on every document/chunk/conversation access
- Input validation (zod) on all requests; file type, size, and content checks on uploads
- Secrets only in env vars, validated at startup, `.env.example` kept current
- Rate limiting on upload and chat endpoints
- Graceful error handling and clear error responses, no stack traces leaking out
- Structured logging
- Tests for the critical paths (chunking, retrieval, auth/ownership)
- Prompt design that keeps answers grounded in retrieved context, with a sensible "I couldn't find that in your documents" fallback
- A good README with architecture diagram, setup steps, and screenshots (this is a portfolio piece)
- Deployed demo with a short walkthrough Ahmad can share on LinkedIn

## 8. Suggested Claude Code plugins

Worth installing for this project:
- `security-guidance`, since uploads, auth, and multi-tenancy make this security-sensitive
- `code-review`, to review each milestone before moving on
- `frontend-design`, to keep the Next.js UI from looking generic
- Supabase MCP plugin, for database, auth, and storage operations
- GitHub MCP plugin, for repo and PR management

Install with `/plugin install <name>@claude-plugins-official`, or browse via `/plugin`.

## 9. Later improvements (portfolio talking points)

- Semantic or recursive chunking and a comparison against fixed-size
- Hybrid search (vector plus keyword) and reranking
- Streaming responses in the chat UI
- Evaluation set for retrieval quality
- Usage limits per user, which turns this into a sellable template
- Swappable LLM/embedding providers behind a clean interface

## 10. Current status

Planning is done. Nothing is built yet. Next action: start **Milestone 1** from `CLAUDE.md`.
