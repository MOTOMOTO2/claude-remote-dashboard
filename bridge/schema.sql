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

-- ── your house ────────────────────────────────────────────────────────
-- The smart home hub on your Pi is on your LAN and your phone is not, so
-- the house takes the same road as everything else here: the bridge on your
-- PC mirrors what the hub can see into `house_devices`, and claims the taps
-- you make from `house_commands`. Nothing is exposed to the internet, no
-- port is opened, and the hub's token never leaves the PC.

-- One row per device the hub reports, rewritten only when it changes.
create table if not exists house_devices (
  owner      uuid not null references auth.users on delete cascade,
  entity_id  text not null,
  name       text not null default '',
  area       text,
  kind       text not null default 'other',
  state      text not null default '',
  is_on      boolean not null default false,
  attrs      jsonb  not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (owner, entity_id)
);

create index if not exists house_devices_room on house_devices (owner, area, kind);

alter table house_devices enable row level security;

drop policy if exists "own devices" on house_devices;
create policy "own devices" on house_devices
  for all using (auth.uid() = owner) with check (auth.uid() = owner);

-- What is relaying, and whether the hub behind it answered. Two different
-- failures — your PC asleep, or the Pi off — and the screen says which.
--
-- One row per *relay*, not per account, because the useful setup has two:
-- one on the hub itself, which is on all the time, and one on your PC, which
-- is not. `host` says which of those a row is, `priority` which to believe
-- when both answer, and `mirroring` which one is currently writing devices.
create table if not exists house_hubs (
  owner     uuid not null references auth.users on delete cascade,
  relay     text not null default 'pc',
  host      text not null default 'pc' check (host in ('hub', 'pc')),
  priority  int  not null default 0,
  mirroring boolean not null default false,
  name      text not null,
  kind      text,
  devices   int  not null default 0,
  reachable boolean not null default false,
  error     text,
  last_seen timestamptz not null default now(),
  primary key (owner, relay)
);

-- Already had this table from an earlier paste? These four lines bring it
-- up to date, and the block after them widens the key from one relay per
-- account to one row per relay. Both are safe to run again.
alter table house_hubs add column if not exists relay     text not null default 'pc';
alter table house_hubs add column if not exists host      text not null default 'pc';
alter table house_hubs add column if not exists priority  int  not null default 0;
alter table house_hubs add column if not exists mirroring boolean not null default false;

do $$
declare one_key text;
begin
  -- A primary key over a single column is the old shape: owner alone.
  select c.conname into one_key
    from pg_constraint c
   where c.conrelid = 'house_hubs'::regclass
     and c.contype = 'p'
     and array_length(c.conkey, 1) = 1;
  if one_key is not null then
    execute format('alter table house_hubs drop constraint %I', one_key);
    alter table house_hubs add primary key (owner, relay);
  end if;
end $$;

alter table house_hubs enable row level security;

drop policy if exists "own hub" on house_hubs;
create policy "own hub" on house_hubs
  for all using (auth.uid() = owner) with check (auth.uid() = owner);

-- A tap, written `queued` and claimed by the relay. The same table is the
-- activity list, which is why a finished command is kept rather than
-- deleted — and why `source` says whether you or your assistant did it.
create table if not exists house_commands (
  id         bigserial primary key,
  owner      uuid not null references auth.users on delete cascade,
  entity_id  text not null,
  name       text,
  action     text not null,
  value      numeric,
  source     text not null default 'dashboard',
  status     text not null default 'queued'
             check (status in ('queued', 'running', 'done', 'error')),
  error      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The one query the relay runs on a loop, and the one the dashboard draws.
create index if not exists house_commands_waiting on house_commands (status, created_at)
  where status in ('queued', 'running');
create index if not exists house_commands_recent on house_commands (owner, created_at desc);

alter table house_commands enable row level security;

drop policy if exists "own commands" on house_commands;
create policy "own commands" on house_commands
  for all using (auth.uid() = owner) with check (auth.uid() = owner);

do $$
begin
  alter publication supabase_realtime add table house_devices;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table house_commands;
exception when duplicate_object then null;
end $$;

-- A device changing is an UPDATE, and the dashboard needs the whole row.
alter table house_devices replica identity full;
alter table house_commands replica identity full;
