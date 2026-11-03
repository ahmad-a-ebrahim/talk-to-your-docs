-- (1) A new message makes its conversation "recently active".
-- conversations.updated_at normally moves only when the conversation row itself is updated, so the
-- "recent chats" sort would never change. SECURITY DEFINER because users may only update conversations.title
-- (see the grants below); the function only touches the conversation the new message already belongs to,
-- and the composite foreign key guarantees that conversation has the same owner.
create or replace function public.touch_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations set updated_at = now() where id = new.conversation_id;
  return null;
end;
$$;
--> statement-breakpoint
create trigger messages_touch_conversation
  after insert on public.messages
  for each row execute function public.touch_conversation();
--> statement-breakpoint
revoke execute on function public.touch_conversation() from public, anon, authenticated;
--> statement-breakpoint

-- (2) Server-managed columns can't be set by users.
-- Table-wide grants plus RLS only check the owner, so a user calling Supabase's Data API could still write
-- error_message, created_at and so on. Column-level INSERT grants would block that, but Drizzle lists every
-- column in an INSERT (using DEFAULT for the ones you omit), and Postgres demands a grant on every listed
-- column. So instead this trigger quietly overwrites those columns whenever the writer is `authenticated`.
-- Privileged writers (the n8n pipeline, migrations, the smoke test's admin inserts) are trusted and untouched.
-- Not SECURITY DEFINER on purpose: it must see the real session role in current_user.
create or replace function public.guard_user_writes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;

  if tg_table_name = 'documents' then
    new.error_message := null;
    new.created_at := now();
    new.updated_at := now();
  elsif tg_table_name = 'conversations' then
    new.created_at := now();
    new.updated_at := now();
  elsif tg_table_name = 'messages' then
    new.created_at := clock_timestamp();
    new.cited_chunk_ids := '{}';
  end if;

  return new;
end;
$$;
--> statement-breakpoint
create trigger documents_guard_user_writes
  before insert on public.documents
  for each row execute function public.guard_user_writes();
--> statement-breakpoint
create trigger conversations_guard_user_writes
  before insert on public.conversations
  for each row execute function public.guard_user_writes();
--> statement-breakpoint
create trigger messages_guard_user_writes
  before insert on public.messages
  for each row execute function public.guard_user_writes();
--> statement-breakpoint
revoke execute on function public.guard_user_writes() from public, anon, authenticated;
--> statement-breakpoint

-- On UPDATE, Drizzle only lists the columns you set, so column-level grants work: the one thing a user
-- may change on a conversation is its title (rename). Everything else is fixed after creation.
revoke update on public.conversations from authenticated;
--> statement-breakpoint
grant update (title) on public.conversations to authenticated;
