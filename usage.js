// Your subscription's limits: what a reading means, and what it is honest to
// say about when it resets. Pure — rows already in memory in, plain data out —
// so views.js only draws it and the smoke test can check it against fixed
// times, because a plausible-looking wrong answer is worse here than none.
//
// A `usage_windows` row is `{ window_type, pct, resets_at }`, written by
// whatever runner last saw Anthropic's numbers. It looks simple and it is not:
// the reset time is missing, or already past, a good deal of the time, and the
// two mean different things.
//
//   live     the reset is ahead of us. The only case that can say "resets
//            Thu 3:00 PM, in 2d 19h", and the only one that is still a limit.
//   idle     0% used and no reset time. Anthropic starts a window with your
//            next message, so there is nothing to count down to — and nothing
//            to be afraid of. This used to read "reset time unknown", which is
//            the worst thing to tell someone asking how long they have.
//   stale    the reset has already happened since this was read. The number is
//            the window *before* it, so it must not be drawn as a red "nearly
//            out" — you have a fresh window; the figure is merely not read yet.
//   unknown  some use, but the runner did not say when it clears.
//
// `host/dispatch.mjs` already treats a window past its reset as no longer
// counting when it decides whether a job may start; this is the same rule, so
// the screen and the runner cannot disagree about whether you are capped.

import { dayClock, until, untilPhrase } from './util.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Every window the dashboard knows by name, in the order they are drawn. */
export const WINDOWS = {
  five_hour:                  { label: '5-hour session',        short: '5h',            span: 5 * HOUR },
  seven_day:                  { label: 'Weekly · all models',   short: 'week',          span: 7 * DAY },
  seven_day_opus:             { label: 'Weekly · Opus',         short: 'week · Opus',   span: 7 * DAY },
  seven_day_sonnet:           { label: 'Weekly · Sonnet',       short: 'week · Sonnet', span: 7 * DAY },
  seven_day_overage_included: { label: 'Weekly · incl. overage', short: 'week+',        span: 7 * DAY },
  overage:                    { label: 'Overage',               short: 'overage',       span: null },
};
const ORDER = Object.keys(WINDOWS);

const words = (type) => String(type).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** "5 hours", "7 days": how long a window lasts, for the one that has not started. */
export function spanWords(ms) {
  if (!ms) return '';
  return ms % DAY === 0 ? `${ms / DAY} days` : `${ms / HOUR} hours`;
}

/** The same span as an adjective: "5-hour", "7-day". */
const spanAdjective = (ms) => spanWords(ms).replace(/^(\d+) (\w+?)s$/, '$1-$2');

/**
 * A reset time as epoch milliseconds, from whatever a writer stored: an ISO
 * string (what a timestamptz column hands back), epoch seconds or epoch
 * milliseconds, or either of those as a string. Anything else is no time at
 * all, which is not the same as the epoch.
 */
export function parseTime(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  const n = typeof value === 'number' ? value : /^\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
  // Nothing real is a millisecond count below 1e11 (1973) or a second count
  // above it (year 5138), so the magnitude says which one this is. A zero is
  // what an unset bigint column holds, not the first of January 1970.
  if (Number.isFinite(n)) return n <= 0 ? null : n < 1e11 ? n * 1000 : n;
  const t = Date.parse(text);
  return Number.isFinite(t) ? t : null;
}

/** The severity of a ratio: a class for the colour and the word that rides with it. */
export const level = (pct) => (pct >= 100
  ? { tone: 'full', word: 'limit reached' }
  : pct >= 85 ? { tone: 'full', word: 'nearly out' }
    : pct >= 60 ? { tone: 'warn', word: 'watch' } : { tone: '', word: 'healthy' });

/** One row, read: what it is, how much of it is used, and what state it is in. */
export function read(row, now = Date.now()) {
  const type = row.window_type;
  const meta = WINDOWS[type] ?? {};
  const pct = Math.max(0, Number(row.pct));
  const resetAt = parseTime(row.resets_at);

  const state = resetAt == null ? (pct === 0 ? 'idle' : 'unknown')
    : resetAt > now ? 'live' : 'stale';
  // Only a window that still binds you has a severity. One that has already
  // reset, or never started, is not "nearly out" whatever its old number says.
  const { tone, word } = state === 'live' || state === 'unknown'
    ? level(pct)
    : { tone: '', word: state === 'idle' ? 'not started' : 'reset' };

  return {
    type,
    label: meta.label ?? words(type),
    short: meta.short ?? String(type).replace(/_/g, ' '),
    span: meta.span ?? null,
    state,
    pct,
    /** Clamped for a bar; `pct` stays honest for the text. */
    fill: state === 'stale' ? 0 : Math.min(100, pct),
    left: state === 'stale' ? null : Math.max(0, 100 - Math.round(pct)),
    tone,
    word,
    resetAt,
    resetISO: resetAt == null ? null : new Date(resetAt).toISOString(),
  };
}

/** Every reading worth drawing, in the order the windows are drawn. */
export function readings(rows, now = Date.now()) {
  const rank = (type) => { const i = ORDER.indexOf(type); return i < 0 ? ORDER.length : i; };
  return (rows ?? [])
    .filter((r) => r && r.window_type && r.pct != null && Number.isFinite(Number(r.pct)))
    .map((r) => read(r, now))
    .sort((a, b) => rank(a.type) - rank(b.type) || String(a.type).localeCompare(String(b.type)));
}

/**
 * The window that will actually stop you: the most used of those that still
 * bind, and when two are level, the one that clears first. A window that has
 * already reset, or never started, is not what is in your way.
 */
export function tightest(list) {
  return list
    .filter((r) => r.state === 'live' || r.state === 'unknown')
    .reduce((worst, r) => {
      if (!worst || r.pct > worst.pct) return r;
      if (r.pct < worst.pct) return worst;
      return (r.resetAt ?? Infinity) < (worst.resetAt ?? Infinity) ? r : worst;
    }, null);
}

/**
 * The one reading the topbar shows. The tightest window when something binds
 * you; failing that, whatever is left, so the chip never goes blank while
 * there are readings to show.
 */
export const headline = (list) => tightest(list)
  ?? list.find((r) => r.state === 'idle') ?? list[0] ?? null;

/** The pieces of "when does it reset", for one reading. */
export function resetWords(r, now = Date.now()) {
  if (r.state === 'live') {
    return {
      clock: dayClock(r.resetAt, now),
      in: until(r.resetAt, now),
      phrase: untilPhrase(r.resetAt, now),
    };
  }
  if (r.state === 'stale') {
    const ago = until(now + (now - r.resetAt), now);   // the same span, read forwards
    return { clock: dayClock(r.resetAt, now), ago: ago === 'any moment' ? 'just now' : `${ago} ago` };
  }
  return {};
}

/** What the topbar chip says: a figure, and how long until it resets. */
export function chip(list, now = Date.now()) {
  const r = headline(list);
  if (!r) return null;
  const sub = r.state === 'live' ? resetWords(r, now).in : '';
  return {
    reading: r,
    text: r.state === 'stale' ? 'reset' : `${Math.round(r.pct)}%`,
    sub: sub === 'any moment' ? 'resetting' : sub,
    fill: r.fill,
  };
}

/**
 * One sentence a person can act on — the chip's label and the top of the
 * sheet. It says when, and it says how long, because those are the two things
 * you open this to find out.
 */
export function sentence(list, now = Date.now()) {
  if (!list.length) return 'No usage readings yet — your desktop reports these when it starts up.';
  const r = headline(list);
  if (r.state === 'live') {
    const w = resetWords(r, now);
    const when = `It resets ${w.clock}, ${w.phrase}.`;
    return r.pct >= 100
      ? `${r.label} is at its limit. ${when}`
      : `${r.label} is your tightest window: ${r.left}% left. ${when}`;
  }
  if (r.state === 'unknown') {
    return `${r.label} is at ${Math.round(r.pct)}% (${r.left}% left), but the runner did not say when it resets.`;
  }
  if (r.state === 'idle') {
    const window = r.span ? `a fresh ${spanAdjective(r.span)} window` : 'a fresh window';
    return `Nothing is counting against you — ${window} opens with your next message.`;
  }
  const w = resetWords(r, now);
  return `${r.label} reset ${w.clock} (${w.ago}). The reading is older than that, so it is not `
    + 'counting against you — it updates the next time a job runs.';
}
