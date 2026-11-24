// What to start, decided once per wake.
//
// api/runner.js calls `dispatch` whenever something might have changed: you
// queued a job or sent a message (the dashboard pings it), a sandbox
// finished (it rings back), or the daily cron. Each call reads the queue,
// claims what may run under the same rules fleet.js describes on the
// Agents screen — a ceiling, one agent per project, your usage cap — and
// starts a sandbox for each. Claims are made on the row's status, so two
// wakes at once, or the PC runner waking up too, can never run a job twice.
//
// Your PC comes first. If the PC runner has checked in within the last 30
// seconds, new jobs are left for it, exactly as before there was a cloud;
// the cloud only takes them when the PC is off or asleep. Jobs the cloud has
// already started (one paused for usage, say) still finish in the cloud,
// because their Claude session lives in that sandbox.
//
// `plan` is the decision and is pure; `dispatch` is the I/O around it.

import { slugify } from './memory.mjs';

export const DEFAULT_MAX = 3;
const time = (iso) => Date.parse(iso ?? '') || 0;
const oldest = (a, b) => time(a.created_at) - time(b.created_at);
const enc = encodeURIComponent;

/** A heartbeat this recent means that thing is up. */
export const FRESH_MS = 25_000;

/** The dashboard's own rule for "the desktop is online". */
export const PC_FRESH_MS = 30_000;

/**
 * The PC runner, if it is awake: any runner other than this one that has
 * checked in within 30 seconds. The cloud's own heartbeat never counts.
 */
export function awakePc(hosts = [], me = 'cloud', now = Date.now()) {
  return hosts
    .filter((h) => h.name && h.name !== me && now - time(h.last_seen) < PC_FRESH_MS)
    .sort((a, b) => time(b.last_seen) - time(a.last_seen))[0] ?? null;
}

/** Which sandbox holds a project, and which one answers the Ask tab. */
export const sandboxName = (slug) => `cr-job-${slug}`.slice(0, 60).replace(/-+$/, '');
export const ASK_SANDBOX = 'cr-ask';

/**
 * Whether the usage windows say a job with this cap should wait. Only a
 * window that has not reset yet counts: an old reading of a window that has
 * since rolled over says nothing.
 */
export function overCap(cap, usage = [], now = Date.now()) {
  const limit = Number(cap ?? 100);
  if (!(limit < 100)) return null;
  const live = usage.filter((u) => time(u.resets_at) > now && Number(u.pct) >= limit);
  return live.sort((a, b) => b.pct - a.pct)[0] ?? null;
}

/**
 * Projects the cloud cannot reach: listed only as folders on the PC. Those
 * are left in the queue for the PC runner rather than failed here.
 */
export function localOnly(projects = []) {
  const byName = new Map();
  for (const p of projects) {
    const list = byName.get(p.name) ?? [];
    list.push(p);
    byName.set(p.name, list);
  }
  const out = new Set();
  for (const [name, rows] of byName) {
    if (rows.every((r) => r.is_local && !r.full_name)) out.add(name);
  }
  return out;
}

/**
 * The decision.
 *
 * @param jobs      every running, paused and queued job of this account
 * @param me        this runner's name, as it writes `claimed_by`
 * @param max       the published ceiling
 * @param projects  rows of `projects`, to spot PC-only folders
 * @param usage     rows of `usage_windows`
 * @param waiting   queued Ask-tab replies
 * @param assistant the `assistants` heartbeat row
 * @param pcAwake   whether the PC runner is up, in which case it gets the jobs
 */
export function plan({
  jobs = [], me = 'cloud', max = DEFAULT_MAX, projects = [], usage = [],
  waiting = 0, assistant = null, assistantName = 'Claude', pcAwake = false, now = Date.now(),
} = {}) {
  const ceiling = Math.min(6, Math.max(1, Number(max) || DEFAULT_MAX));
  const held = jobs.filter((j) => j.status === 'running' || j.status === 'paused');
  const busy = new Set(held.map((j) => j.project_slug).filter(Boolean));
  let used = held.length;

  // Paused here and due again: they already hold their slot.
  const resume = held
    .filter((j) => j.status === 'paused' && j.claimed_by === me && time(j.resume_at) <= now)
    .sort((a, b) => time(a.resume_at) - time(b.resume_at));

  const pcOnly = localOnly(projects);
  const start = [];
  const skipped = [];
  for (const job of jobs.filter((j) => j.status === 'queued').sort(oldest)) {
    const slug = job.project_slug;
    if (pcAwake) { skipped.push({ job, why: 'pc' }); continue; }
    if (slug && busy.has(slug)) { skipped.push({ job, why: 'project' }); continue; }
    if (used >= ceiling) { skipped.push({ job, why: 'slot' }); continue; }
    if (slug && pcOnly.has(slug)) { skipped.push({ job, why: 'pc-only' }); continue; }
    const capped = overCap(job.usage_cap_pct, usage, now);
    if (capped) { skipped.push({ job, why: 'cap', window: capped }); continue; }
    start.push(job);
    used += 1;
    if (slug) busy.add(slug);
  }

  const askUp = Boolean(assistant && assistant.name === assistantName
    && now - time(assistant.last_seen) < FRESH_MS);
  return { resume, start, skipped, chat: waiting > 0 && !askUp, used, max: ceiling };
}

/** A name for a new project that nothing else is using yet. */
export async function uniqueSlug(prompt, { taken = async () => false } = {}) {
  const base = slugify(prompt);
  for (let n = 1; n < 20; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!(await taken(slug))) return slug;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Read the queue, claim what may run, start it. Returns what it did, for the
 * dashboard and the logs.
 *
 * @param api       PostgREST, as the service role
 * @param owner     whose dashboard this is
 * @param sandboxes { startJob, startChat, status } — see host/sandboxes.mjs
 * @param github    { exists(owner, name) } or null
 * @param pcFirst   leave new jobs to the PC runner while it is awake (default)
 */
export async function dispatch({
  api, owner, sandboxes, github = null, ghOwner = '', me = 'cloud',
  assistantName = 'Claude', pcFirst = true, log = () => {}, now = () => Date.now(),
}) {
  const mine = `owner=eq.${enc(owner)}`;
  const rows = async (path) => {
    const r = await api(path).catch((e) => { log(`read ${path.split('?')[0]}: ${e.message}`); return []; });
    return Array.isArray(r) ? r : [];
  };
  const stamp = () => new Date(now()).toISOString();
  const note = (jobId, kind, text) => api('/job_events', {
    method: 'POST', prefer: 'return=minimal', body: [{ job_id: jobId, kind, text }],
  }).catch(() => {});

  let jobs = await rows(`/jobs?${mine}&status=in.(running,paused,queued)&select=*&order=created_at.asc&limit=100`);
  const did = { started: [], resumed: [], recovered: [], chat: false, skipped: [], pc: null, leftForPc: [] };

  // A sandbox that died mid-job leaves the row saying "running" for ever.
  // Find those first, so the slot they hold comes back this same pass.
  for (const job of jobs) {
    if (job.status !== 'running' || job.claimed_by !== me || !job.project_slug) continue;
    if (now() - time(job.claimed_at) < 3 * 60_000) continue;
    const state = await sandboxes.status(sandboxName(job.project_slug)).catch(() => 'unknown');
    if (!['stopped', 'failed', 'aborted', 'missing'].includes(state)) continue;
    const patch = job.session_id
      ? { status: 'paused', resume_at: stamp() }
      : { status: 'queued', claimed_by: null, claimed_at: null };
    const back = await api(`/jobs?id=eq.${enc(job.id)}&status=eq.running`, {
      method: 'PATCH', prefer: 'return=representation', body: patch,
    }).catch(() => null);
    if (back?.length) {
      Object.assign(job, back[0]);
      did.recovered.push(job.id);
      await note(job.id, 'status', job.session_id
        ? 'The cloud sandbox stopped unexpectedly; picking up where it left off'
        : 'The cloud sandbox stopped before it began; queued again');
    }
  }

  const [settings, projects, usage, waiting, assistants, hosts] = await Promise.all([
    rows(`/settings?${mine}&select=max_parallel&limit=1`),
    rows('/projects?select=name,full_name,is_local'),
    rows('/usage_windows?select=window_type,pct,resets_at'),
    rows(`/chat_messages?${mine}&role=eq.assistant&status=eq.queued&select=id&limit=5`),
    rows(`/assistants?${mine}&select=name,last_seen&limit=1`),
    rows('/hosts?select=name,last_seen'),
  ]);

  const pc = pcFirst ? awakePc(hosts, me, now()) : null;
  const p = plan({
    jobs, me, max: settings[0]?.max_parallel ?? DEFAULT_MAX, projects, usage,
    waiting: waiting.length, assistant: assistants[0] ?? null, assistantName,
    pcAwake: Boolean(pc), now: now(),
  });
  did.pc = pc?.name ?? null;
  did.skipped = p.skipped.map((s) => ({ id: s.job.id, why: s.why }));
  did.leftForPc = p.skipped.filter((s) => s.why === 'pc').map((s) => s.job.id);

  for (const job of p.resume) {
    const taken = await api(`/jobs?id=eq.${enc(job.id)}&status=eq.paused`, {
      method: 'PATCH', prefer: 'return=representation',
      body: { status: 'running', resume_at: null, claimed_at: stamp() },
    }).catch(() => null);
    if (!taken?.length) continue;
    try {
      await sandboxes.startJob({ slug: job.project_slug, jobId: job.id, continuing: true });
      did.resumed.push(job.id);
    } catch (e) {
      log(`resume ${job.id}: ${e.message}`);
      await api(`/jobs?id=eq.${enc(job.id)}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { status: 'paused', resume_at: new Date(now() + 10 * 60_000).toISOString() },
      }).catch(() => {});
      await note(job.id, 'error', `The cloud runner could not start a sandbox: ${e.message}`);
      return did;
    }
  }

  for (const job of p.start) {
    let slug = job.project_slug;
    if (!slug) {
      const names = new Set(projects.map((r) => r.name));
      slug = await uniqueSlug(job.prompt, {
        taken: async (s) => names.has(s)
          || (await rows(`/jobs?${mine}&project_slug=eq.${enc(s)}&select=id&limit=1`)).length > 0
          || Boolean(github && ghOwner && await github.exists(ghOwner, s).catch(() => false)),
      });
    }
    const claim = await api(`/jobs?id=eq.${enc(job.id)}&status=eq.queued`, {
      method: 'PATCH', prefer: 'return=representation',
      body: { status: 'running', claimed_by: me, claimed_at: stamp(), project_slug: slug, error: null },
    }).catch(() => null);
    if (!claim?.length) continue;               // the PC runner, or another wake, got it
    try {
      await sandboxes.startJob({ slug, jobId: job.id, continuing: false });
      did.started.push({ id: job.id, slug });
    } catch (e) {
      // Out of sandbox quota, or Vercel is down: put it back where it was
      // and say why, rather than leaving a job "running" on nothing.
      log(`start ${job.id}: ${e.message}`);
      await api(`/jobs?id=eq.${enc(job.id)}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { status: 'queued', claimed_by: null, claimed_at: null, project_slug: job.project_slug ?? null },
      }).catch(() => {});
      await note(job.id, 'error', `The cloud runner could not start a sandbox: ${e.message}`);
      return did;
    }
  }

  if (p.chat) {
    try {
      await sandboxes.startChat();
      did.chat = true;
    } catch (e) {
      log(`start chat: ${e.message}`);
    }
  }
  return did;
}
