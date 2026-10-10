// How many agents may run at once, which ones are running, and what every
// waiting job is actually waiting for. Pure — rows already in memory in,
// plain data out — so views.js only has to draw it and the smoke test can
// check it against fixed inputs.
//
// The ceiling lives in Supabase (`settings.max_parallel`) because the desktop
// runner is the half that honours it: it claims up to that many queued jobs
// at a time. Two rules shape the queue, and both are the runner's:
//   · a slot is one agent, and a paused agent keeps its slot — it resumes
//     where it left off rather than starting again;
//   · one agent per project, because two agents in one folder would fight
//     over the same working copy.
// Everything below is that arithmetic, so the dashboard can say "waiting for
// a free slot, 2 ahead" instead of a bare "queued".

export const DEFAULT_SLOTS = 3;
export const MIN_SLOTS = 1;
export const MAX_SLOTS = 6;

export const clampSlots = (n) => {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_SLOTS;
  return Math.min(MAX_SLOTS, Math.max(MIN_SLOTS, v));
};

const oldest = (a, b) => (Date.parse(a.created_at ?? '') || 0) - (Date.parse(b.created_at ?? '') || 0);

/** Why a queued job hasn't started, in the order the reasons actually bite. */
export const WAIT_REASON = {
  project: 'waiting for its own project',
  slot: 'waiting for a free slot',
  host: 'waiting for your desktop',
  next: 'next up',
};

/**
 * The fleet as it stands.
 *
 * @param jobs        every job row (any status)
 * @param maxParallel the published ceiling
 * @param hostFresh   whether a desktop checked in recently
 */
export function fleet({ jobs = [], maxParallel = DEFAULT_SLOTS, hostFresh = false } = {}) {
  const max = clampSlots(maxParallel);
  const running = jobs.filter((j) => j.status === 'running').sort(oldest);
  const paused = jobs.filter((j) => j.status === 'paused').sort(oldest);
  const queued = jobs.filter((j) => j.status === 'queued').sort(oldest);

  // A running or paused agent holds a slot and holds its project.
  const held = [...running, ...paused];
  const busy = new Set(held.map((j) => j.project_slug).filter(Boolean));
  let taken = held.length;

  const used = held.length;

  // Walk the queue in the order the runner would claim it, so each job's
  // reason accounts for everything in front of it.
  const waiting = queued.map((job, i) => {
    const mine = job.project_slug;
    let reason;
    if (mine && busy.has(mine)) reason = 'project';
    else if (taken >= max) reason = 'slot';
    else reason = hostFresh ? 'next' : 'host';

    // Only a job that would start now takes a slot from the ones behind it.
    if (reason === 'next' || reason === 'host') {
      taken += 1;
      if (mine) busy.add(mine);
    }
    return { job, reason, label: WAIT_REASON[reason], ahead: i };
  });

  return {
    max,
    running,
    paused,
    queued,
    waiting,
    active: [...running, ...paused, ...queued],
    used,
    free: Math.max(0, max - used),
    /** More agents in flight than the ceiling — a ceiling lowered mid-run. */
    over: Math.max(0, used - max),
    /** One pip per slot, in the words that ride with the colour. */
    pips: Array.from({ length: Math.max(max, used) }, (_, i) => (i < running.length ? 'running'
      : i < used ? 'paused' : 'free')),
    /** Queued jobs that only a free slot will release. */
    blocked: waiting.filter((w) => w.reason === 'slot').length,
  };
}
