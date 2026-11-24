-- Everything the dashboard can use beyond jobs: your own assistant, the
-- agent ceiling, your house, field reports, and sending with no signal.
--
-- Paste this into the Supabase SQL editor; it is safe to run again whenever
-- it grows. It adds tables to the project the dashboard already uses, and
-- the one change to anything already there is a nullable `client_id`
-- column on `jobs` and `chat_messages` (see "sending later").
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
  -- 'hub' or 'pc'. Not a check constraint: a value this table has not heard
  -- of should cost a relay a label on the screen, not its whole heartbeat,
  -- and house.js already reads anything that is not 'hub' as 'pc'.
  host      text not null default 'pc',
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

-- ── sending later ─────────────────────────────────────────────────────
-- The dashboard keeps what you send on the phone until Supabase has it, and
-- sends it again when the signal comes back. A retry whose first try got
-- through — but whose answer was lost on the way back — would otherwise land
-- twice, so each row carries the id the phone gave it and a second copy is
-- refused. Nullable: rows the runner, the bridge or an older dashboard write
-- have none, and that is fine. Without these two columns the dashboard
-- still sends; a lost answer can just mean a job or a message twice.

alter table jobs add column if not exists client_id text;
create unique index if not exists jobs_client_id on jobs (client_id);

alter table chat_messages add column if not exists client_id text;
create unique index if not exists chat_messages_client_id on chat_messages (client_id);

-- ── field reports ─────────────────────────────────────────────────────
-- Sites to visit and what was found at each — Field Reports
-- (offline-sync-pwa), moved into this account. A report is written on the
-- phone first, so it can be filed where there is no signal; its id is made
-- there too, and is the primary key, so sending it twice keeps one.

create table if not exists field_sites (
  id             uuid primary key default gen_random_uuid(),
  owner          uuid not null references auth.users on delete cascade,
  name           text not null check (char_length(name) between 1 and 200),
  address        text not null default '',
  region         text not null default '',
  asset_tag      text not null default '',
  priority       int  not null default 2 check (priority between 1 and 3),
  access_notes   text not null default '',
  contact_name   text not null default '',
  contact_phone  text not null default '',
  status         text not null default 'unvisited'
                 check (status in ('ok', 'needs_work', 'blocked', 'unvisited')),
  last_report_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists field_sites_owner on field_sites (owner, priority, name);

alter table field_sites enable row level security;

drop policy if exists "own sites" on field_sites;
create policy "own sites" on field_sites
  for all using (auth.uid() = owner) with check (auth.uid() = owner);

create table if not exists field_reports (
  id          text primary key check (id ~ '^[A-Za-z0-9_-]{8,64}$'),
  owner       uuid not null references auth.users on delete cascade,
  site_id     uuid not null references field_sites on delete cascade,
  status      text not null check (status in ('ok', 'needs_work', 'blocked')),
  note        text not null default '' check (char_length(note) <= 2000),
  author      text not null default '' check (char_length(author) <= 120),
  recorded_at timestamptz not null default now(),
  received_at timestamptz not null default now()
);

create index if not exists field_reports_site on field_reports (site_id, recorded_at desc);

alter table field_reports enable row level security;

-- Your own reports, on your own sites: a report cannot be pinned to a site
-- that belongs to someone else.
drop policy if exists "own reports" on field_reports;
create policy "own reports" on field_reports
  for all using (auth.uid() = owner)
  with check (auth.uid() = owner and exists (
    select 1 from field_sites s where s.id = site_id and s.owner = auth.uid()));

-- The phone's clock is trusted within reason: a report queued this morning
-- should say this morning, but not next year. `received_at` is the server's.
create or replace function field_report_stamp() returns trigger
language plpgsql as $$
begin
  if new.recorded_at is null or new.recorded_at > now() + interval '10 minutes' then
    new.recorded_at := now();
  end if;
  new.received_at := now();
  return new;
end $$;

drop trigger if exists field_report_stamp on field_reports;
create trigger field_report_stamp before insert on field_reports
  for each row execute function field_report_stamp();

-- A site's status is its newest report's — newest by when it was recorded,
-- not when it arrived — so a report that sat all day on a phone with no
-- signal cannot overwrite what someone has seen since. Removing a report
-- works the status out again from the ones left.
create or replace function field_site_status() returns trigger
language plpgsql as $$
declare
  sid       uuid;
  latest    text;
  latest_at timestamptz;
begin
  if tg_op = 'INSERT' then
    update field_sites
       set status = new.status, last_report_at = new.recorded_at, updated_at = now()
     where id = new.site_id
       and (last_report_at is null or last_report_at <= new.recorded_at);
    return null;
  end if;

  sid := old.site_id;
  select r.status, r.recorded_at into latest, latest_at
    from field_reports r
   where r.site_id = sid
   order by r.recorded_at desc, r.received_at desc
   limit 1;
  update field_sites
     set status = coalesce(latest, 'unvisited'), last_report_at = latest_at, updated_at = now()
   where id = sid;
  return null;
end $$;

drop trigger if exists field_site_status on field_reports;
create trigger field_site_status after insert or delete on field_reports
  for each row execute function field_site_status();

do $$
begin
  alter publication supabase_realtime add table field_sites;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table field_reports;
exception when duplicate_object then null;
end $$;
