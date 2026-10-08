// Everything that talks to Supabase, plus the in-memory mirror the views
// read from. The views never query; they render `state` and are re-run
// whenever a change lands.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

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

export const projectOf = (slug) => state.projects.find((p) => p.name === slug) ?? null;

/**
 * A chat whose project the host no longer sees anywhere — repo deleted on
 * GitHub and no folder left on the PC. Its history is still readable, but
 * there is nothing left to work on, so it is flagged rather than offered.
 */
export const projectGone = (slug) =>
  Boolean(slug) && state.projects.length > 0 && !state.projects.some((p) => p.name === slug);

// ── change notification ───────────────────────────────────────────────

const listeners = { change: [], event: [], finish: [] };

export const on = (name, fn) => { listeners[name].push(fn); };
const emit = (name, arg) => { for (const fn of listeners[name]) fn(arg); };
export const changed = () => emit('change');

// ── loading ───────────────────────────────────────────────────────────

/**
 * One round trip per table. Events are fetched only for what we might draw:
 * anything still open, plus the whole thread that is on screen.
 */
export async function loadAll(openSlug = null) {
  const [jobRes, projRes, useRes] = await Promise.all([
    sb.from('jobs').select('*').order('created_at', { ascending: false }).limit(200),
    sb.from('projects').select('name,full_name,is_local,private,pushed_at')
      .order('pushed_at', { ascending: false, nullsFirst: false }),
    sb.from('usage_windows').select('*'),
  ]);

  if (jobRes.error) console.error(jobRes.error);

  state.jobs.clear();
  for (const j of jobRes.data ?? []) state.jobs.set(j.id, j);
  state.projects = projRes.data ?? [];
  takeUsage(useRes);

  const ids = (jobRes.data ?? [])
    .filter((j) => isActive(j) || j.project_slug === openSlug)
    .map((j) => j.id);

  state.events.clear();
  if (ids.length) {
    const { data } = await sb.from('job_events').select('*').in('job_id', ids).order('id');
    for (const e of data ?? []) pushEvent(e);
  }

  state.loading = false;
  changed();
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
  );
}

export function unsubscribe() {
  for (const c of channels) sb.removeChannel(c);
  channels = [];
  state.realtime = 'connecting';
}

// ── host presence ─────────────────────────────────────────────────────

export async function pollHost() {
  const { data } = await sb.from('hosts').select('*')
    .order('last_seen', { ascending: false }).limit(1);
  state.host = data?.[0] ?? null;
  state.hostFresh = Boolean(state.host && Date.now() - new Date(state.host.last_seen) < 30_000);
  changed();
}

// ── mutations ─────────────────────────────────────────────────────────

export async function createJob({ prompt, slug, visibility, effort, cap }) {
  const { data: { user } } = await sb.auth.getUser();
  const res = await sb.from('jobs').insert({
    owner: user.id,
    prompt,
    mode: slug ? 'existing' : 'new',
    project_slug: slug ?? null,
    repo_visibility: slug ? 'none' : visibility,
    effort,
    usage_cap_pct: Number(cap),
  }).select('*').single();

  // Show it immediately rather than waiting for the realtime echo.
  if (res.data?.id) {
    state.jobs.set(res.data.id, res.data);
    changed();
  }
  return res;
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
