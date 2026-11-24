// Everything that talks to Supabase, plus the in-memory mirror the views
// read from. The views never query; they render `state` and are re-run
// whenever a change lands.
//
// Since the offline work, two more things live here: the outbox, which
// every write that matters now goes through (see outbox.js), and the saved
// copy — what the screens last read, kept on the phone so the app opens
// with something true to show when there is no signal.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { fleet, clampSlots, DEFAULT_SLOTS } from './fleet.js';
import { conversations, presence, isPending, pendingQueue } from './assistant.js';
import {
  hubPresence, hubState, rooms as houseRooms, summary as houseSummary,
  pendingBy, isQueued, recent as recentCommands, litLights,
} from './house.js';
import { createOutbox, newId, isNetworkError } from './outbox.js';
import * as idb from './idb.js';
import {
  fieldSites, tally as fieldTally, timeline as fieldTimeline, reportId, cleanSite, cleanReport,
} from './field.js';

const cfg = window.CONFIG ?? {};

export const configured = Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey);

// The session lives in localStorage and refreshes in the background, so you
// sign in once per device. On iOS a home-screen install has its own storage,
// separate from Safari — the first sign-in has to happen inside the app.
export const sb = configured
  ? createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: 'claude-remote-auth',
      },
    })
  : null;

export const state = {
  /** jobId -> job row */   jobs: new Map(),
  /** jobId -> event rows */ events: new Map(),
  projects: [],
  usage: [],
  /** When the last usage read landed, and when its numbers last moved. */
  usageAt: null,
  usageMovedAt: null,
  usageError: null,
  host: null,
  hostFresh: false,
  /** How many agents may run at once, and whether the runner can see it. */
  maxParallel: DEFAULT_SLOTS,
  /** Whether the settings table is readable, and whether it has our row. */
  slotsSynced: false,
  slotsPublished: false,
  slotsError: null,
  /** Your own assistant: its conversations, their messages, and the bridge. */
  chats: [],
  chatMessages: [],
  assistant: null,
  /** Whether the chat tables are there at all, and why not if they aren't. */
  askReady: false,
  askError: null,
  /** Your house: every device the hub reports, the relays, and taps in flight. */
  devices: [],
  hubs: [],
  commands: [],
  houseReady: false,
  houseError: null,
  /**
   * Whether this deployment has the cloud runner (api/runner.js): null until
   * it has been asked, then true or false. When true, nothing being online
   * means "asleep, and starting as soon as there is work", not "offline".
   */
  cloud: null,
  /** Why the cloud runner refused the last wake, if it did. */
  cloudRefused: null,
  /** jobId -> why the cloud runner left that job waiting ('cap', 'pc-only', 'pc'). */
  cloudWhy: new Map(),
  /** Field reports: your sites, their recent reports, and whether the tables exist. */
  fieldSites: [],
  fieldReports: [],
  fieldReady: false,
  fieldError: null,
  /** Who is signed in — whose outbox and saved copy these are. */
  owner: null,
  /** What this phone is still waiting to send, oldest first (see outbox.js). */
  outbox: [],
  /**
   * The network as this page has actually found it. `online` is corrected by
   * every request, because navigator.onLine is a hint that lies on captive
   * portals; `savedAt` is when what is on screen was last read live, and
   * `fromSaved` whether it came off this phone rather than from Supabase.
   */
  sync: {
    online: typeof navigator === 'undefined' || navigator.onLine !== false,
    sending: false,
    savedAt: null,
    fromSaved: false,
  },
  realtime: 'connecting',
  loading: true,
};

const ACTIVE = new Set(['queued', 'running', 'paused']);
export const isActive = (j) => ACTIVE.has(j.status);
export const jobList = () => [...state.jobs.values()];
export const newest = (a, b) => new Date(b.created_at) - new Date(a.created_at);
export const oldest = (a, b) => new Date(a.created_at) - new Date(b.created_at);

/** Jobs of one project, oldest first — the reading order of a thread. */
export const threadOf = (slug) => jobList()
  .filter((j) => j.project_slug === slug)
  .sort(oldest);

export const latestOf = (slug) => threadOf(slug).at(-1);

/** The fleet as it stands: slots, what holds them, what the queue waits on. */
export const fleetNow = () => fleet({
  jobs: jobList(),
  maxParallel: state.maxParallel,
  hostFresh: state.hostFresh,
  wakes: state.cloud === true,
});

export const projectOf = (slug) => state.projects.find((p) => p.name === slug) ?? null;

/**
 * A chat whose project the host no longer sees anywhere — repo deleted on
 * GitHub and no folder left on the PC. Its history is still readable, but
 * there is nothing left to work on, so it is flagged rather than offered.
 */
export const projectGone = (slug) =>
  Boolean(slug) && state.projects.length > 0 && !state.projects.some((p) => p.name === slug);

// ── change notification ───────────────────────────────────────────────

const listeners = { change: [], event: [], finish: [], reply: [], houseFail: [], sent: [] };

export const on = (name, fn) => { listeners[name].push(fn); };
const emit = (name, arg) => { for (const fn of listeners[name]) fn(arg); };
export const changed = () => { emit('change'); scheduleSave(); };

/**
 * Every answer says something about the network, so every read passes
 * through here on its way in. A failed fetch means offline whatever the
 * browser claims; anything else means a server answered. Coming back is
 * the moment to send what has been waiting.
 */
/**
 * An answer that says nothing about whether a table exists: no network, or
 * an access token that lapsed while there was none. Neither may put a setup
 * card up over data that is sitting right here.
 */
const unreadable = (res) => isNetworkError(res)
  || res?.status === 401 || /jwt/i.test(String(res?.error?.message ?? ''));

function heard(res) {
  if (!res) return res;
  const off = isNetworkError(res);
  if (off && state.sync.online) {
    state.sync.online = false;
  } else if (!off && !state.sync.online) {
    state.sync.online = true;
    queueMicrotask(() => { flushOutbox(); });
  }
  return res;
}

// ── loading ───────────────────────────────────────────────────────────

/**
 * One round trip per table. Events are fetched only for what we might draw:
 * anything still open, plus the whole thread that is on screen.
 *
 * A read that fails keeps what is already on screen — the last live read,
 * or the copy saved on this phone. It used to clear the jobs first and fill
 * them second, so a phone that woke up with no signal showed an empty
 * account, which is a lie that looks exactly like data loss.
 */
export async function loadAll(openSlug = null) {
  const [jobRes, projRes, useRes, setRes] = (await Promise.all([
    sb.from('jobs').select('*').order('created_at', { ascending: false }).limit(200),
    // Every column, not a list: the catalogue ones (description, live link…)
    // only exist once that migration has run, and `*` works either way.
    projectQuery(),
    sb.from('usage_windows').select('*'),
    settingsQuery(),
  ])).map(heard);

  if (jobRes.error) {
    if (!isNetworkError(jobRes)) console.error(jobRes.error);
    state.loading = false;
    changed();
    return;
  }

  const ids = (jobRes.data ?? [])
    .filter((j) => isActive(j) || j.project_slug === openSlug)
    .map((j) => j.id);
  const events = ids.length
    ? await sb.from('job_events').select('*').in('job_id', ids).order('id')
    : { data: [], error: null };

  state.jobs.clear();
  for (const j of jobRes.data ?? []) state.jobs.set(j.id, j);
  if (!projRes.error) state.projects = projRes.data ?? [];
  if (!isNetworkError(useRes)) takeUsage(useRes);
  if (!isNetworkError(setRes)) takeSettings(setRes);

  if (!events.error) {
    state.events.clear();
    for (const e of events.data ?? []) pushEvent(e);
  }

  state.loading = false;
  markLive();
  changed();
}

const projectQuery = () => sb.from('projects').select('*')
  .order('pushed_at', { ascending: false, nullsFirst: false });

/**
 * Re-read the project list. The host syncs it on its own clock, and a job
 * that just finished has usually changed it — a new repo, a new live link —
 * so a finish is the moment to look again. A failed read keeps what we had.
 */
export async function loadProjects() {
  const { data, error } = await projectQuery();
  if (error) return;
  state.projects = data ?? [];
  changed();
}

// ── how many agents at once ───────────────────────────────────────────
// The ceiling is a setting the runner obeys, so it has to live in the
// database, not in this browser. The table is optional: an account whose
// schema predates it still works, the number is just local to this device
// until the migration runs — and the Agents screen says which it is.

const SLOTS_KEY = 'cr-slots';

const readLocalSlots = () => {
  try { return clampSlots(localStorage.getItem(SLOTS_KEY) ?? DEFAULT_SLOTS); }
  catch { return DEFAULT_SLOTS; }
};

const writeLocalSlots = (n) => {
  try { localStorage.setItem(SLOTS_KEY, String(n)); } catch { /* blocked */ }
};

state.maxParallel = readLocalSlots();

const settingsQuery = () => sb.from('settings').select('*').limit(1);

/**
 * Accept one read of the ceiling. A missing table is not an error worth
 * showing — it means the migration hasn't run — but it does change what the
 * screen may claim, so it is recorded either way.
 */
function takeSettings({ data, error }) {
  if (error) {
    state.slotsSynced = false;
    state.slotsPublished = false;
    state.slotsError = error.message ?? String(error);
    return;
  }
  state.slotsSynced = true;
  state.slotsError = null;
  const row = (data ?? [])[0];
  state.slotsPublished = row?.max_parallel != null;
  if (row?.max_parallel != null) {
    state.maxParallel = clampSlots(row.max_parallel);
    writeLocalSlots(state.maxParallel);
  }
}

/**
 * Re-read the ceiling. It is one row and it can be changed from another
 * phone, so it rides the same timer as the host and the limits.
 */
export async function pollSettings() {
  takeSettings(await settingsQuery());
  changed();
}

/** Publish the ceiling. Optimistic: the pips move now, the row follows. */
export async function saveMaxParallel(n) {
  const value = clampSlots(n);
  state.maxParallel = value;
  writeLocalSlots(value);
  changed();

  const { error } = await sb.from('settings').upsert({
    owner: await ownerId(),
    max_parallel: value,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'owner' });

  state.slotsSynced = !error;
  state.slotsPublished = !error;
  state.slotsError = error?.message ?? null;
  changed();
  return { error };
}

// ── usage ─────────────────────────────────────────────────────────────
// The one table nothing in this app writes to: the runner posts a reading
// when it starts and again as each job burns through a window. Realtime on
// it is a bonus, not a guarantee — the table has to be in the publication
// for that — so it is polled as well. It used to be, and when the poll was
// dropped the meters silently froze on whatever the first load happened to
// see, which looks exactly like a broken feature.

const fingerprint = (rows) => rows
  .map((r) => `${r.window_type}:${r.pct}:${r.resets_at}`)
  .sort()
  .join('|');

/**
 * Accept one usage read. A failed read keeps the last good rows rather than
 * blanking the block — an empty meter list and a query that errored mean very
 * different things, and only one of them is "no readings yet".
 */
function takeUsage({ data, error }) {
  if (error) {
    state.usageError = error.message ?? String(error);
    return;
  }
  const rows = data ?? [];
  // Only a change we actually watched happen counts. The first read tells us
  // nothing about when the numbers last moved, so it claims nothing.
  const moved = state.usageAt && fingerprint(rows) !== fingerprint(state.usage);
  state.usage = rows;
  state.usageAt = new Date().toISOString();
  state.usageError = null;
  if (moved) state.usageMovedAt = state.usageAt;
}

/** Re-read the limits. Cheap — one small table — so it runs on a timer. */
export async function pollUsage() {
  takeUsage(await sb.from('usage_windows').select('*'));
  changed();
}

/** Fill in a thread's log the first time it is opened. */
export async function loadThreadEvents(slug) {
  const ids = threadOf(slug).filter((j) => !state.events.has(j.id)).map((j) => j.id);
  if (!ids.length) return;
  const { data } = await sb.from('job_events').select('*').in('job_id', ids).order('id');
  for (const e of data ?? []) pushEvent(e);
  changed();
}

function pushEvent(e) {
  const list = state.events.get(e.job_id);
  if (list) list.push(e);
  else state.events.set(e.job_id, [e]);
}

export const eventsOf = (id) => state.events.get(id) ?? [];

export const lastActivity = (id) => {
  const log = eventsOf(id);
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].kind === 'tool' || log[i].kind === 'status') return log[i];
  }
  return null;
};

export const resultOf = (id) => {
  const log = eventsOf(id);
  for (let i = log.length - 1; i >= 0; i--) if (log[i].kind === 'result') return log[i];
  return null;
};

// ── realtime ──────────────────────────────────────────────────────────

let channels = [];

export function subscribe() {
  const track = (status) => {
    state.realtime = status === 'SUBSCRIBED' ? 'live'
      : status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' ? 'error'
      : 'connecting';
    changed();
  };

  channels.push(
    sb.channel('jobs-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' },
        ({ new: row, old, eventType }) => {
          if (eventType === 'DELETE' || (!row?.id && old?.id)) {
            state.jobs.delete(old?.id);
            changed();
            return;
          }
          if (!row?.id) return;
          const before = state.jobs.get(row.id);
          state.jobs.set(row.id, row);
          if (before && before.status !== row.status && !isActive(row)) emit('finish', row);
          changed();
        })
      .subscribe(track),

    sb.channel('events-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'job_events' },
        ({ new: row }) => {
          if (!row) return;
          pushEvent(row);
          emit('event', row);
        })
      .subscribe(),

    // A reading can change without a row event reaching us, so this is the
    // fast path and `pollUsage` on a timer is the one that has to be right.
    sb.channel('usage-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'usage_windows' },
        () => { pollUsage(); })
      .subscribe(),

    // Your assistant's half. A reply streams in as repeated UPDATEs to one
    // row, so this channel is what makes it read like typing — and
    // `pollReplies` on a short timer is the net under it, because an UPDATE
    // only reaches us if `chat_messages` is in the publication.
    sb.channel('chat-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_messages' },
        ({ new: row, old, eventType }) => {
          if (eventType === 'DELETE' || (!row?.id && old?.id)) {
            state.chatMessages = state.chatMessages.filter((m) => m.id !== old?.id);
            changed();
            return;
          }
          if (row?.id) { takeMessage(row); changed(); }
        })
      .subscribe(),

    // Your house. A device changing is an UPDATE to one row, so this is what
    // makes a light you switched somewhere else in the flat show up here
    // without a refresh; `pollHouse` covers the publication not having it.
    sb.channel('house-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'house_devices' },
        ({ new: row, old, eventType }) => {
          if (eventType === 'DELETE' || (!row?.entity_id && old?.entity_id)) {
            state.devices = state.devices.filter((d) => d.entity_id !== old?.entity_id);
          } else {
            takeDevice(row);
          }
          changed();
        })
      .subscribe(),

    sb.channel('house-commands-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'house_commands' },
        ({ new: row, old, eventType }) => {
          if (eventType === 'DELETE' || (!row?.id && old?.id)) {
            state.commands = state.commands.filter((c) => String(c.id) !== String(old?.id));
          } else {
            takeCommand(row);
          }
          changed();
        })
      .subscribe(),

    // Field reports: a report filed from another phone — or a site's status
    // moving because of one — shows up here without a refresh.
    sb.channel('field-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'field_sites' },
        ({ new: row, old, eventType }) => {
          if (eventType === 'DELETE' || (!row?.id && old?.id)) {
            state.fieldSites = state.fieldSites.filter((s) => s.id !== old?.id);
          } else {
            takeSite(row);
          }
          changed();
        })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'field_reports' },
        ({ new: row, old, eventType }) => {
          if (eventType === 'DELETE' || (!row?.id && old?.id)) {
            state.fieldReports = state.fieldReports.filter((r) => r.id !== old?.id);
          } else if (row?.id) {
            takeReports([row]);
          }
          changed();
        })
      .subscribe(),

    sb.channel('chats-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chats' },
        ({ new: row, old, eventType }) => {
          if (eventType === 'DELETE' || (!row?.id && old?.id)) {
            state.chats = state.chats.filter((c) => c.id !== old?.id);
          } else if (row?.id) {
            const i = state.chats.findIndex((c) => c.id === row.id);
            if (i < 0) state.chats = [row, ...state.chats];
            else state.chats[i] = row;
          }
          changed();
        })
      .subscribe(),
  );
}

export function unsubscribe() {
  for (const c of channels) sb.removeChannel(c);
  channels = [];
  state.realtime = 'connecting';
}

// ── host presence ─────────────────────────────────────────────────────

export async function pollHost() {
  const res = heard(await sb.from('hosts').select('*')
    .order('last_seen', { ascending: false }).limit(1));
  // No answer is not "no desktop": keep the last one we saw, and let its
  // heartbeat go stale on its own.
  if (!res.error) state.host = res.data?.[0] ?? null;
  state.hostFresh = Boolean(state.host && Date.now() - new Date(state.host.last_seen) < 30_000);
  changed();
}

// ── the cloud runner ──────────────────────────────────────────────────
// api/runner.js starts Vercel Sandboxes for whatever is waiting, so nothing
// here needs your PC. It holds no queue of its own — Supabase is the queue —
// so all it needs is a nudge: when you send something, when the app opens,
// and now and then while something is waiting with nothing running it.

let cloudAbsent = false;
let lastWake = 0;

/** Is anything waiting that a sleeping runner would need to be woken for? */
export function wantsCloud(now = Date.now()) {
  const due = (j) => j.status === 'queued'
    || (j.status === 'paused' && (Date.parse(j.resume_at ?? '') || 0) <= now);
  if (!state.hostFresh && jobList().some(due)) return true;
  return askPending().length > 0 && !askPresence().online;
}

/**
 * Ask the cloud runner to start whatever is waiting. Signed in as you, so
 * nobody else can spend your sandboxes. Throttled unless `force`, and a
 * deployment without the function (a local `npm run serve`) is asked once.
 */
export async function wakeCloud({ force = false } = {}) {
  if (!sb || cloudAbsent) return null;
  if (!force && (Date.now() - lastWake < 20_000 || (state.cloud !== null && !wantsCloud()))) return null;
  lastWake = Date.now();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return null;
  try {
    const res = await fetch('api/runner', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ action: 'wake' }),
    });
    const body = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
    if (!body) cloudAbsent = true;           // a static host: no function here
    // Only a wake that was let in makes "starting in the cloud" true. A
    // refused one is a setup problem, and the screen says so instead.
    state.cloud = Boolean(res.ok && body?.configured);
    state.cloudRefused = res.status === 401 ? (body?.refused || 'the cloud runner refused this account') : null;
    state.cloudWhy = new Map((body?.skipped ?? [])
      .filter((x) => ['cap', 'pc-only', 'pc'].includes(x.why))
      .map((x) => [String(x.id), x.why]));
    changed();
    return body;
  } catch {
    return null;                             // offline: the next nudge will do
  }
}

// ── mutations ─────────────────────────────────────────────────────────

/**
 * Whose rows these are. Known since sign-in, so it costs nothing — where
 * `auth.getUser()` asks the server, which is a round trip at best and, with
 * no signal, a write that fails before it has even started.
 */
async function ownerId() {
  if (state.owner) return state.owner;
  const { data } = await sb.auth.getSession();
  return data?.session?.user?.id ?? null;
}

/**
 * Queue a job. It goes into the outbox first and is then sent at once, so
 * with a signal this is the insert it always was — and without one the job
 * is still safe, and goes the moment the phone is back.
 */
export async function createJob({ prompt, slug, visibility, effort, cap }) {
  const r = await enqueue({
    kind: 'job',
    title: prompt,
    payload: { prompt, slug: slug ?? null, visibility, effort, cap },
  });
  return { ...r, data: r.serverId ? state.jobs.get(r.serverId) ?? null : null };
}

export const cancelJob = (id) =>
  sb.from('jobs').update({ cancel_requested: true }).eq('id', id);

export async function deleteChat(slug) {
  const res = await sb.from('jobs').delete().eq('project_slug', slug);
  if (!res.error) {
    for (const [id, j] of state.jobs) if (j.project_slug === slug) state.jobs.delete(id);
    changed();
  }
  return res;
}

// ── your own assistant ────────────────────────────────────────────────
// The same relay, a different payload. A message goes into `chat_messages`
// with an empty reply row behind it; the bridge on your PC claims that row,
// streams the answer into it, and marks it done. Which is why the thread can
// be honest while you wait: the row exists whether or not the PC is awake.
//
// All three tables are optional. An account whose schema predates them keeps
// working — the Assistant screen says the migration hasn't run instead of
// throwing — exactly like the agent ceiling.

const MESSAGE_LIMIT = 600;

const chatsQuery = () => sb.from('chats').select('*')
  .order('updated_at', { ascending: false }).limit(60);

const messagesQuery = (n = MESSAGE_LIMIT) => sb.from('chat_messages').select('*')
  .order('id', { ascending: false }).limit(n);

const bridgeQuery = () => sb.from('assistants').select('*')
  .order('last_seen', { ascending: false }).limit(1);

const byId = (a, b) => (Date.parse(a.created_at ?? '') || 0) - (Date.parse(b.created_at ?? '') || 0)
  || String(a.id).localeCompare(String(b.id), undefined, { numeric: true });

/**
 * Accept one message row, from a load, a realtime event or a poll. A reply
 * that has just stopped being pending is announced, so a finished answer can
 * raise a toast and a notification from wherever you were.
 */
function takeMessage(row) {
  if (!row?.id) return;
  const i = state.chatMessages.findIndex((m) => String(m.id) === String(row.id));
  const before = i < 0 ? null : state.chatMessages[i];
  if (i < 0) state.chatMessages.push(row);
  else state.chatMessages[i] = { ...before, ...row };
  state.chatMessages.sort(byId);
  if (before && isPending(before) && !isPending(row)) emit('reply', row);
}

/** Read the assistant half. Three small tables, all of them optional. */
export async function loadAsk() {
  const [chatRes, msgRes, bridgeRes] = (await Promise.all([
    chatsQuery(), messagesQuery(), bridgeQuery(),
  ])).map(heard);

  // No signal says nothing about whether the tables exist, so it must not
  // put the setup card up over a conversation that is saved right here.
  if (unreadable(chatRes) || unreadable(msgRes)) { changed(); return; }

  if (chatRes.error || msgRes.error) {
    state.askReady = false;
    state.askError = (chatRes.error ?? msgRes.error).message ?? 'unavailable';
  } else {
    state.askReady = true;
    state.askError = null;
    state.chats = chatRes.data ?? [];
    state.chatMessages = [...(msgRes.data ?? [])].sort(byId);
  }
  // The bridge table standing alone is not worth an error: no row simply
  // means nothing has ever checked in, which the screen already says.
  state.assistant = bridgeRes.error ? null : (bridgeRes.data?.[0] ?? null);
  changed();
}

/** Is the bridge there? One row, so it rides the same ten-second timer. */
export async function pollAssistant() {
  const { data, error } = await bridgeQuery();
  if (!error) state.assistant = data?.[0] ?? null;
  changed();
}

/**
 * Re-read the newest messages. Only runs while a reply is actually pending —
 * the app starts and stops this one itself — because it exists for the case
 * where realtime UPDATEs never arrive and a reply would otherwise sit at
 * "typing…" forever.
 */
export async function pollReplies() {
  const { data, error } = await messagesQuery(60);
  if (error) return;
  for (const row of data ?? []) takeMessage(row);
  changed();
}

export const messageOf = (id) =>
  state.chatMessages.find((m) => String(m.id) === String(id)) ?? null;

/**
 * Conversations that exist only on this phone so far: one started with no
 * signal, and any whose first message is still in the outbox. Listed with
 * the rest, so the thread you are typing into does not vanish on a reload.
 */
const drafts = new Map();
function localChats() {
  const known = new Set(state.chats.map((c) => c.id));
  const out = new Map();
  for (const d of drafts.values()) if (!known.has(d.id)) out.set(d.id, d);
  for (const e of state.outbox) {
    if (e.kind !== 'ask' || known.has(e.payload.chatId) || out.has(e.payload.chatId)) continue;
    const at = new Date(e.createdAt).toISOString();
    out.set(e.payload.chatId, { id: e.payload.chatId, owner: e.owner, title: null, created_at: at, updated_at: at, local: true });
  }
  return [...out.values()];
}

export const askChats = () => conversations({
  chats: [...state.chats, ...localChats()],
  messages: state.chatMessages,
});
export const askPresence = () => presence(state.assistant);
export const askPending = () => pendingQueue(state.chatMessages);
const now = () => new Date().toISOString();

/**
 * A fresh conversation. Optimistic: it is on screen before the row lands.
 * With no signal it is a draft on this phone, written when its first
 * message goes — an empty row was never worth waiting for a network.
 */
export async function startConversation(title = null) {
  const owner = await ownerId();
  const res = heard(await sb.from('chats')
    .insert({ owner, title, created_at: now(), updated_at: now() })
    .select('*').single());
  if (isNetworkError(res)) {
    const draft = { id: newId(), owner, title, created_at: now(), updated_at: now(), local: true };
    drafts.set(draft.id, draft);
    changed();
    return { data: draft, error: null };
  }
  if (res.data?.id) {
    state.chats = [res.data, ...state.chats.filter((c) => c.id !== res.data.id)];
    changed();
  }
  return res;
}

/** Keep a conversation's place in the list without waiting for the write. */
function touchConversation(id) {
  const at = now();
  const chat = state.chats.find((c) => c.id === id);
  if (chat) chat.updated_at = at;
  sb.from('chats').update({ updated_at: at }).eq('id', id).then(() => {}, () => {});
}

/**
 * Say something. Your message and the empty reply it is owed go in as one
 * write, so the thread shows an answer on its way even with the PC off — and
 * the bridge has one row to claim rather than inventing one. Through the
 * outbox like a job: with no signal it waits on the phone and goes later,
 * creating its conversation then if that is new too.
 */
export async function askAssistant({ chatId, text }) {
  const id = chatId ?? newId();
  const r = await enqueue({
    kind: 'ask',
    title: text,
    payload: { chatId: id, newChat: !state.chats.some((c) => c.id === id), text },
  });
  drafts.delete(id);
  return { ...r, chatId: id, error: null };
}

/** Stop a reply mid-sentence. The bridge watches this flag as it streams. */
export const stopReply = (id) =>
  sb.from('chat_messages').update({ cancel_requested: true }).eq('id', id);

/** Ask the same question again, into the same row — the chat's "run again". */
export async function askAgain(id) {
  const patch = { status: 'queued', text: '', error: null, cancel_requested: false };
  const res = await sb.from('chat_messages').update(patch).eq('id', id);
  if (!res.error) {
    const row = state.chatMessages.find((m) => String(m.id) === String(id));
    if (row) Object.assign(row, patch);
    changed();
    wakeCloud({ force: true });
  }
  return res;
}

export async function deleteConversation(id) {
  const res = await sb.from('chats').delete().eq('id', id);
  if (!res.error) {
    state.chats = state.chats.filter((c) => c.id !== id);
    state.chatMessages = state.chatMessages.filter((m) => m.chat_id !== id);
    changed();
  }
  return res;
}

// ── your house ────────────────────────────────────────────────────────
// The third thing this app relays, and the one with the shortest round
// trip: a tap writes a row into `house_commands`, the bridge on your PC
// claims it, calls the hub on your own network, and the device it changed
// comes back in `house_devices` a second later.
//
// Optional like the rest. An account whose schema predates these tables
// still works — the House screen says the migration hasn't run.

const DEVICE_LIMIT = 400;
const RELAY_LIMIT = 8;

const devicesQuery = () => sb.from('house_devices').select('*').limit(DEVICE_LIMIT);
// Every relay, not the newest one: a PC that went to sleep hours ago must
// not make a Pi that is relaying right now look like a dead house.
const hubQuery = () => sb.from('house_hubs').select('*')
  .order('last_seen', { ascending: false }).limit(RELAY_LIMIT);
const commandsQuery = (n = 60) => sb.from('house_commands').select('*')
  .order('id', { ascending: false }).limit(n);

/** Read the house. Three small tables, all of them optional. */
export async function loadHouse() {
  const [devRes, hubRes, cmdRes] = (await Promise.all([
    devicesQuery(), hubQuery(), commandsQuery(),
  ])).map(heard);

  if (unreadable(devRes)) { changed(); return; }

  if (devRes.error) {
    state.houseReady = false;
    state.houseError = devRes.error.message ?? 'unavailable';
  } else {
    state.houseReady = true;
    state.houseError = null;
    state.devices = devRes.data ?? [];
    state.commands = cmdRes.error ? [] : (cmdRes.data ?? []);
  }
  // No hub row simply means nothing has checked in, which the screen says
  // for itself — it is not an error worth colouring the page over.
  state.hubs = hubRes.error ? [] : (hubRes.data ?? []);
  changed();
}

/** Is a relay there? A handful of rows, so it rides the ten-second timer. */
export async function pollHub() {
  const { data, error } = await hubQuery();
  if (!error) state.hubs = data ?? [];
  changed();
}

/**
 * Re-read devices and taps. Only runs while something is actually in flight
 * — the app starts and stops it — because it is the net under realtime for
 * the same reason the reply poll is: an UPDATE only reaches us if the table
 * is in the Supabase publication.
 */
export async function pollHouse() {
  const [devRes, cmdRes] = await Promise.all([devicesQuery(), commandsQuery(30)]);
  if (!devRes.error) state.devices = devRes.data ?? [];
  if (!cmdRes.error) for (const row of cmdRes.data ?? []) takeCommand(row);
  changed();
}

function takeDevice(row) {
  if (!row?.entity_id) return;
  const i = state.devices.findIndex((d) => d.entity_id === row.entity_id);
  if (i < 0) state.devices.push(row);
  else state.devices[i] = { ...state.devices[i], ...row };
}

function takeCommand(row) {
  if (!row?.id) return;
  const i = state.commands.findIndex((c) => String(c.id) === String(row.id));
  const before = i < 0 ? null : state.commands[i];
  if (i < 0) state.commands.unshift(row);
  else state.commands[i] = { ...before, ...row };
  // A tap that did not land has to say so: the device simply staying as it
  // was looks exactly like a tap that never registered.
  if (row.status === 'error' && before?.status !== 'error') emit('houseFail', row);
}

export const houseDevices = () => state.devices;
export const houseRoomList = () => houseRooms(state.devices);
export const houseSummaryNow = () => houseSummary(state.devices);
export const housePresence = () => hubPresence(state.hubs);
export const houseState = () => hubState(housePresence());
export const housePending = () => pendingBy(state.commands);
export const houseBusy = () => state.commands.filter(isQueued);
export const houseRecent = (n) => recentCommands(state.commands, n);
export const litLightsNow = () => litLights(state.devices);
export const deviceOf = (entityId) =>
  state.devices.find((d) => d.entity_id === entityId) ?? null;

/**
 * Tap something. The row is the instruction *and* the receipt: it shows up
 * on the screen as "turning off…" the moment it is written, and the relay
 * fills in what became of it. Several devices at once (a room, or "all
 * lights off") is one row each, so each can fail on its own.
 */
export async function sendCommand(commands) {
  const list = (Array.isArray(commands) ? commands : [commands]).filter(Boolean);
  if (!list.length) return { error: null, rows: [] };

  const owner = await ownerId();
  const at = now();
  const res = heard(await sb.from('house_commands').insert(list.map((c) => ({
    owner,
    entity_id: c.entity_id,
    name: c.name ?? deviceOf(c.entity_id)?.name ?? null,
    action: c.action,
    value: c.value ?? null,
    source: 'dashboard',
    status: 'queued',
    created_at: at,
    updated_at: at,
  }))).select('*'));

  // Show it immediately rather than waiting for the realtime echo.
  for (const row of res.data ?? []) takeCommand(row);
  changed();
  return { error: res.error ?? null, rows: res.data ?? [], offline: isNetworkError(res) };
}

// ── field reports ─────────────────────────────────────────────────────
// Field Reports (offline-sync-pwa), moved in: sites, and what was found at
// each. Built for the place with no signal, so both writes — a report, and
// a new site — go through the outbox, and the screens read the sites with
// anything still on this phone laid over them (see field.js).

const SITE_LIMIT = 500;
const REPORT_LIMIT = 600;

const sitesQuery = () => sb.from('field_sites').select('*').limit(SITE_LIMIT);
const reportsQuery = () => sb.from('field_reports').select('*')
  .order('recorded_at', { ascending: false }).limit(REPORT_LIMIT);

function takeReports(rows, { replace = false } = {}) {
  const byId = new Map(replace ? [] : state.fieldReports.map((r) => [r.id, r]));
  for (const r of rows) if (r?.id) byId.set(r.id, { ...byId.get(r.id), ...r });
  state.fieldReports = [...byId.values()];
}

function takeSite(row) {
  if (!row?.id) return;
  const i = state.fieldSites.findIndex((s) => s.id === row.id);
  if (i < 0) state.fieldSites.push(row);
  else state.fieldSites[i] = { ...state.fieldSites[i], ...row };
}

/** Read the sites and their recent reports. Optional like the house. */
export async function loadField() {
  const [siteRes, repRes] = (await Promise.all([sitesQuery(), reportsQuery()])).map(heard);
  if (unreadable(siteRes)) { changed(); return; }
  if (siteRes.error) {
    // A table that isn't there has no rows, whatever an old copy said.
    state.fieldReady = false;
    state.fieldError = siteRes.error.message ?? 'unavailable';
    state.fieldSites = [];
    state.fieldReports = [];
  } else {
    state.fieldReady = true;
    state.fieldError = null;
    state.fieldSites = siteRes.data ?? [];
    if (!repRes.error) takeReports(repRes.data ?? [], { replace: true });
  }
  changed();
}

/** One site's whole history, for when it goes back further than the list read. */
export async function loadSiteReports(siteId) {
  if (!siteId || !state.fieldReady) return;
  const res = heard(await sb.from('field_reports').select('*').eq('site_id', siteId)
    .order('recorded_at', { ascending: false }).limit(100));
  if (res.error) return;
  takeReports(res.data ?? []);
  changed();
}

export const fieldSiteList = () => fieldSites({ sites: state.fieldSites, outbox: state.outbox });
export const fieldTallyNow = () => fieldTally(fieldSiteList());
export const fieldSiteOf = (id) => fieldSiteList().find((s) => String(s.id) === String(id)) ?? null;
export const fieldTimelineOf = (id) =>
  fieldTimeline(id, { reports: state.fieldReports, outbox: state.outbox });

/** A new site. Its id is made here, so a report can be filed on it before it has gone. */
export async function addSite(input) {
  const { site, error } = cleanSite(input);
  if (error) return { outcome: 'invalid', error };
  return enqueue({ kind: 'site', title: site.name, payload: site });
}

/**
 * File a report. Stamped with this phone's clock now, not with whenever it
 * manages to send — the server keeps that time (within reason), and a site
 * takes its status from the newest report *recorded*, so a report that
 * waited all afternoon cannot overwrite one made after it.
 */
export async function fileReport({ siteId, status, note, author }) {
  const site = fieldSiteOf(siteId);
  const { report, error } = cleanReport({ status, note, author });
  if (error) return { outcome: 'invalid', error };
  return enqueue({
    id: reportId(newId()),
    kind: 'report',
    title: site?.name ?? 'a site',
    payload: {
      siteId,
      siteName: site?.name ?? '',
      ...report,
      author: report.author || 'Field tech',
      recordedAt: new Date().toISOString(),
    },
    // A site added with no signal has to reach Supabase before its reports can.
    after: site?.unsent?.id ?? null,
  });
}

/** Field Reports' own demo sites, for trying the tab. Needs a signal. */
export async function loadDemoSites() {
  const owner = await ownerId();
  const { demoRows } = await import('./field-demo.js');
  const { sites, reports } = demoRows(owner, newId);
  let res = heard(await sb.from('field_sites').insert(sites).select('*'));
  if (!res.error) res = heard(await sb.from('field_reports').insert(reports).select('*'));
  await loadField();
  return { error: res.error ?? null, offline: isNetworkError(res), count: sites.length };
}

// ── the outbox ────────────────────────────────────────────────────────
// Jobs, messages, reports and new sites all go here first and are sent from
// here, so every one of them survives a dead network and a killed app. The
// mechanics are outbox.js; what each kind of entry *is*, on the wire, is
// below — one sender per kind.

const outbox = createOutbox();

/** The id this phone gave a job → the id Supabase gave it, once it has one. */
const sentAs = new Map();

/**
 * Tables found not to have the `client_id` column yet (bridge/schema.sql
 * adds it). Writes to them go without it rather than fail: the only thing
 * lost is the guard against a lost answer landing a row twice.
 */
const noClientId = new Set();
const withoutKey = ({ client_id: _drop, ...row }) => row;

async function insertKeyed(table, rows) {
  const keyed = !noClientId.has(table);
  let res = await sb.from(table).insert(keyed ? rows : rows.map(withoutKey)).select('*');
  if (keyed && res.error?.code === 'PGRST204' && /client_id/.test(res.error.message ?? '')) {
    noClientId.add(table);
    res = await sb.from(table).insert(rows.map(withoutKey)).select('*');
  }
  return res;
}

const SENDERS = {
  async job(e) {
    const p = e.payload;
    const res = await insertKeyed('jobs', [{
      owner: e.owner,
      prompt: p.prompt,
      mode: p.slug ? 'existing' : 'new',
      project_slug: p.slug ?? null,
      repo_visibility: p.slug ? 'none' : p.visibility,
      effort: p.effort,
      usage_cap_pct: Number(p.cap),
      client_id: e.id,
    }]);
    // Show it immediately rather than waiting for the realtime echo.
    const row = res.data?.[0];
    if (row?.id) {
      state.jobs.set(row.id, row);
      sentAs.set(e.id, row.id);
    }
    return res;
  },

  async ask(e) {
    const p = e.payload;
    if (p.newChat) {
      const at = now();
      const made = await sb.from('chats')
        .insert({ id: p.chatId, owner: e.owner, title: null, created_at: at, updated_at: at })
        .select('*').single();
      // Already there is fine: an earlier message, or an earlier try, made it.
      if (made.error && made.error.code !== '23505') return made;
      if (made.data) state.chats = [made.data, ...state.chats.filter((c) => c.id !== made.data.id)];
    }
    const at = now();
    const res = await insertKeyed('chat_messages', [
      { chat_id: p.chatId, owner: e.owner, role: 'user', text: p.text, status: 'done',
        created_at: at, client_id: `${e.id}:q` },
      { chat_id: p.chatId, owner: e.owner, role: 'assistant', text: '', status: 'queued',
        created_at: at, client_id: `${e.id}:a` },
    ]);
    for (const row of res.data ?? []) takeMessage(row);
    if (!res.error) touchConversation(p.chatId);
    return res;
  },

  async report(e) {
    const p = e.payload;
    const res = await sb.from('field_reports').insert({
      id: e.id,
      owner: e.owner,
      site_id: p.siteId,
      status: p.status,
      note: p.note,
      author: p.author,
      recorded_at: p.recordedAt,
    }).select('*').single();
    if (res.data) takeReports([res.data]);
    return res;
  },

  async site(e) {
    const res = await sb.from('field_sites')
      .insert({ ...e.payload, id: e.id, owner: e.owner })
      .select('*').single();
    if (res.data) takeSite(res.data);
    return res;
  },
};

/** Re-read this account's outbox into `state`, for the screens. */
export async function refreshOutbox() {
  state.outbox = state.owner ? await outbox.list(state.owner) : [];
  changed();
}

let flushing = null;
let flushAgain = false;

/**
 * Send whatever is due. Coalesced: a call while one is running asks for one
 * more pass when it ends, so an entry added mid-flush still goes now rather
 * than at the next tick.
 */
export function flushOutbox() {
  if (flushing) { flushAgain = true; return flushing; }
  flushing = (async () => {
    let res;
    do { flushAgain = false; res = await runFlush(); } while (flushAgain);
    return res;
  })().finally(() => { flushing = null; });
  return flushing;
}

async function runFlush() {
  if (!sb || !state.owner) return null;
  // With no session there is no one to send as: an access token that
  // expired while the phone was offline, most likely. The next nudge will do.
  const { data } = await sb.auth.getSession().catch(() => ({ data: null }));
  const session = data?.session;
  if (!session || session.user?.id !== state.owner) return null;

  const due = state.outbox.some((e) => e.state === 'waiting');
  if (!due) return null;

  state.sync.sending = true;
  changed();
  const res = await outbox.flush({
    owner: state.owner,
    send: (e) => (SENDERS[e.kind] ?? (async () => ({
      error: { message: `this version cannot send a "${e.kind}"`, code: 'unknown' }, status: 400,
    })))(e),
  });
  state.sync.sending = false;
  if (res.offline) state.sync.online = false;
  else if (res.sent.length || res.duplicates.length) state.sync.online = true;
  await refreshOutbox();

  const landed = [...res.sent, ...res.duplicates].map((x) => x.entry);
  const kinds = new Set(landed.map((e) => e.kind));
  // A duplicate means the row is there but this phone never saw it: read it.
  const dupKinds = new Set(res.duplicates.map((x) => x.entry.kind));
  if (dupKinds.has('job')) loadAll();
  if (dupKinds.has('ask')) loadAsk();
  if (kinds.has('report') || kinds.has('site')) loadField();
  if (kinds.has('job') || kinds.has('ask')) wakeCloud({ force: true });
  if (landed.length) emit('sent', { landed, failed: res.failed });
  return res;
}

/** Send now if anything is due — the retry tick. Quiet when nothing is. */
export function flushDue() {
  const t = Date.now();
  if (!state.sync.online) return null;
  if (!state.outbox.some((e) => e.state === 'waiting' && e.nextAttemptAt <= t)) return null;
  return flushOutbox();
}

/**
 * Keep something to send, then try to send it. Resolves once it is safe on
 * this phone *and* the first try has had up to `wait` ms: `sent` if it
 * reached Supabase in that time, `waiting` if it will go later, `failed` if
 * Supabase refused it — with the reason.
 */
async function enqueue(spec, wait = 8_000) {
  const owner = await ownerId();
  if (!owner) return { outcome: 'failed', error: 'Not signed in', entry: null, serverId: null };
  const entry = await outbox.add({ ...spec, owner });
  await refreshOutbox();
  let timer;
  await Promise.race([
    flushOutbox(),
    new Promise((r) => { timer = setTimeout(r, wait); }),
  ]);
  clearTimeout(timer);
  const left = state.outbox.find((x) => x.id === entry.id)
    ?? (await outbox.list(owner)).find((x) => x.id === entry.id);
  return {
    entry,
    outcome: !left ? 'sent' : left.state === 'failed' ? 'failed' : 'waiting',
    error: left?.lastError ?? null,
    serverId: sentAs.get(entry.id) ?? null,
  };
}

export const outboxEntry = (id) => state.outbox.find((e) => String(e.id) === String(id)) ?? null;
export const unsentJobs = (slug) => state.outbox
  .filter((e) => e.kind === 'job' && (slug === undefined || (e.payload.slug ?? null) === slug));
export const unsentAsks = (chatId) => state.outbox
  .filter((e) => e.kind === 'ask' && String(e.payload.chatId) === String(chatId));

/** A job by whichever id you have: Supabase's, or the one this phone gave it. */
export const jobByRef = (id) => {
  if (id == null) return null;
  return state.jobs.get(id)
    ?? state.jobs.get(sentAs.get(id))
    ?? jobList().find((j) => j.client_id != null && String(j.client_id) === String(id))
    ?? null;
};

export async function retryEntry(id) {
  await outbox.retry(id);
  await refreshOutbox();
  return flushOutbox();
}

export async function retryEverything() {
  await outbox.retryAll(state.owner);
  await refreshOutbox();
  return flushOutbox();
}

export async function discardEntry(id) {
  await outbox.discard(id);
  await refreshOutbox();
}

// ── the saved copy ────────────────────────────────────────────────────
// What the screens last read, kept on this phone, so the app opens with
// something true when there is no signal — and says how old it is, rather
// than passing a morning's copy off as now.

const SAVE_EVERY = 3_000;
let saveTimer = null;
/** Nothing is saved until something live has been read: a copy of nothing must not overwrite a copy of something. */
let liveOnce = false;

function markLive() {
  liveOnce = true;
  state.sync.savedAt = Date.now();
  state.sync.fromSaved = false;
}

/** Throttled, not debounced: a log streaming for an hour still gets saved. */
function scheduleSave() {
  if (!state.owner || !liveOnce || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveCopy().catch(() => { /* storage full or blocked: the live app is unaffected */ });
  }, SAVE_EVERY);
}

function snapshot() {
  const jobs = jobList().sort(newest).slice(0, 200);
  const recent = new Set(jobs.slice(0, 40).map((j) => j.id));
  const events = [];
  for (const [id, log] of state.events) {
    if (recent.has(id) || isActive(state.jobs.get(id) ?? {})) events.push([id, log.slice(-60)]);
  }
  return {
    v: 1,
    owner: state.owner,
    savedAt: state.sync.savedAt,
    jobs,
    events,
    projects: state.projects,
    usage: state.usage,
    usageAt: state.usageAt,
    host: state.host,
    chats: state.chats,
    chatMessages: state.chatMessages.slice(-300),
    assistant: state.assistant,
    askReady: state.askReady,
    devices: state.devices,
    hubs: state.hubs,
    commands: state.commands.slice(0, 30),
    houseReady: state.houseReady,
    fieldSites: state.fieldSites,
    fieldReports: state.fieldReports.slice(0, REPORT_LIMIT),
    fieldReady: state.fieldReady,
  };
}

export const saveCopy = () => (state.owner ? idb.put('saved', state.owner, snapshot()) : Promise.resolve());

/** Put the saved copy on screen. False if this phone has none for `owner`. */
export async function restoreCopy(owner) {
  let snap = null;
  try { snap = await idb.get('saved', owner); } catch { snap = null; }
  if (!snap || snap.owner !== owner || snap.v !== 1) return false;

  state.jobs.clear();
  for (const j of snap.jobs ?? []) state.jobs.set(j.id, j);
  state.events.clear();
  for (const [id, log] of snap.events ?? []) state.events.set(id, log);
  state.projects = snap.projects ?? [];
  state.usage = snap.usage ?? [];
  state.usageAt = snap.usageAt ?? null;
  // A heartbeat from the saved copy is old by definition; it reads as off.
  state.host = snap.host ?? null;
  state.hostFresh = false;
  state.chats = snap.chats ?? [];
  state.chatMessages = snap.chatMessages ?? [];
  state.assistant = snap.assistant ?? null;
  state.askReady = Boolean(snap.askReady);
  state.devices = snap.devices ?? [];
  state.hubs = snap.hubs ?? [];
  state.commands = snap.commands ?? [];
  state.houseReady = Boolean(snap.houseReady);
  state.fieldSites = snap.fieldSites ?? [];
  state.fieldReports = snap.fieldReports ?? [];
  state.fieldReady = Boolean(snap.fieldReady);
  state.sync.savedAt = snap.savedAt ?? null;
  state.sync.fromSaved = true;
  state.loading = false;
  changed();
  return true;
}

/**
 * Who is signed in. Puts their saved copy on screen and reads their outbox,
 * before anything has been asked of the network.
 */
export async function setOwner(id) {
  if (state.owner === id) { await refreshOutbox(); return; }
  const switching = state.owner !== null;
  state.owner = id ?? null;
  liveOnce = false;
  clearTimeout(saveTimer);
  saveTimer = null;
  // Someone else's rows must not sit on screen while this account loads.
  const restored = id ? await restoreCopy(id) : false;
  if (!restored && (switching || !id)) clearData();
  await refreshOutbox();
}

/** Forget every row in memory — between two accounts on one phone. */
function clearData() {
  state.jobs.clear();
  state.events.clear();
  Object.assign(state, {
    projects: [], usage: [], usageAt: null, usageMovedAt: null, host: null, hostFresh: false,
    chats: [], chatMessages: [], assistant: null,
    devices: [], hubs: [], commands: [],
    fieldSites: [], fieldReports: [],
    loading: true,
  });
  state.sync.savedAt = null;
  state.sync.fromSaved = false;
  drafts.clear();
  changed();
}

/** Sign out: the saved copy goes; the outbox stays, to send when you are back. */
export async function forgetOwner() {
  const id = state.owner;
  await setOwner(null);
  if (id) await idb.del('saved', id).catch(() => {});
}

/**
 * The account supabase-js keeps in localStorage, read without asking the
 * network. With no signal and an access token that has expired, the client
 * cannot hand out a session — but the phone still knows whose saved copy
 * and outbox to open.
 */
export function storedUser() {
  try {
    const raw = JSON.parse(localStorage.getItem('claude-remote-auth') ?? 'null');
    const user = raw?.user ?? raw?.currentSession?.user ?? null;
    return user?.id ? user : null;
  } catch {
    return null;
  }
}

/** Whether what this phone keeps survives a reload (no: a private window). */
export const keepsAcrossReloads = () => idb.durable();
