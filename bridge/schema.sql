-- Talking to your own assistant, relayed through Supabase.
--
-- Paste this into the Supabase SQL editor once. It adds three tables to the
-- project the dashboard already uses — it changes nothing that is there.
--
-- Every policy is scoped to auth.uid(), so the publishable key in config.js
-- can only ever reach your own rows, exactly like jobs and job_events.

-- ── conversations ─────────────────────────────────────────────────────

create table if not exists chats (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users on delete cascade,
  title      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chats_owner_updated on chats (owner, updated_at desc);

alter table chats enable row level security;

drop policy if exists "own chats" on chats;
create policy "own chats" on chats
  for all using (auth.uid() = owner) with check (auth.uid() = owner);

-- ── the messages in them ──────────────────────────────────────────────
-- One row per turn. Your message is written `done`; the reply is written
-- `queued` and empty at the same moment, so the thread can say an answer is
-- on its way even while the PC is off. The bridge claims that row, streams
-- into `text`, and marks it `done`.

create table if not exists chat_messages (
  id               bigserial primary key,
  chat_id          uuid not null references chats on delete cascade,
  owner            uuid not null references auth.users on delete cascade,
  role             text not null check (role in ('user', 'assistant')),
  text             text not null default '',
  status           text not null default 'done'
                   check (status in ('queued', 'streaming', 'done', 'error')),
  error            text,
  model            text,
  cancel_requested boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists chat_messages_chat on chat_messages (chat_id, created_at);
-- The one query the bridge runs on a loop.
create index if not exists chat_messages_waiting on chat_messages (status, created_at)
  where role = 'assistant';

alter table chat_messages enable row level security;

drop policy if exists "own messages" on chat_messages;
create policy "own messages" on chat_messages
  for all using (auth.uid() = owner) with check (auth.uid() = owner);

-- ── what is listening on your PC ──────────────────────────────────────
-- One row, rewritten every ten seconds. A heartbeat under 30 seconds old is
-- what the dashboard calls "online", the same rule the desktop runner gets.

create table if not exists assistants (
  owner     uuid primary key references auth.users on delete cascade,
  name      text not null,
  model     text,
  last_seen timestamptz not null default now()
);

alter table assistants enable row level security;

drop policy if exists "own assistant" on assistants;
create policy "own assistant" on assistants
  for all using (auth.uid() = owner) with check (auth.uid() = owner);

-- ── realtime ──────────────────────────────────────────────────────────
-- A reply streams in as repeated UPDATEs to one row, and the dashboard only
-- sees those if the table is in the publication. The app polls as well while
-- a reply is pending, so forgetting this makes replies arrive in lumps
-- rather than not at all — but add it, and it reads like typing.

do $$
begin
  alter publication supabase_realtime add table chat_messages;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table chats;
exception when duplicate_object then null;
end $$;

-- Needed for an UPDATE payload to carry the whole row rather than the key.
alter table chat_messages replica identity full;

-- ── how many agents at once ───────────────────────────────────────────
-- Not the assistant's table, but the other one the dashboard asks for and
-- keeps working without: the ceiling the Agents screen writes, and the
-- desktop runner claims against. Included here so one paste brings an
-- account all the way up to date rather than two.

create table if not exists settings (
  owner        uuid primary key references auth.users on delete cascade,
  max_parallel int  not null default 3 check (max_parallel between 1 and 6),
  updated_at   timestamptz not null default now()
);

alter table settings enable row level security;

drop policy if exists "own settings" on settings;
create policy "own settings" on settings
  for all using (auth.uid() = owner) with check (auth.uid() = owner);
