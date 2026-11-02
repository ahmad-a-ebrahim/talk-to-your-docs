-- updated_at is maintained by the database, so it stays correct no matter who writes the row
-- (Express, the n8n pipeline, or someone in the SQL editor). `search_path = ''` is Supabase's
-- recommended hardening for functions; now() lives in pg_catalog, which is always searched.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
--> statement-breakpoint
create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();
--> statement-breakpoint
create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();
--> statement-breakpoint

-- Grants decide WHICH ACTIONS a role may attempt; RLS policies decide WHICH ROWS.
-- Supabase gives `anon` and `authenticated` every privilege on new public tables by default
-- (including TRUNCATE, which RLS does not cover). Start from zero and grant only what users need.
-- Writes by the ingestion pipeline use a privileged role and are unaffected.
revoke all on public.documents, public.chunks, public.conversations, public.messages from anon, authenticated;
--> statement-breakpoint
grant select, insert, delete on public.documents to authenticated;
--> statement-breakpoint
grant select on public.chunks to authenticated;
--> statement-breakpoint
grant select, insert, update, delete on public.conversations to authenticated;
--> statement-breakpoint
grant select, insert on public.messages to authenticated;
