// Small shared helpers: escaping, time, numbers. No DOM, no state.

export const $ = (id) => document.getElementById(id);

/** Escape for HTML text and double-quoted attributes. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/** Tagged template that escapes every interpolation. Use `html.raw(s)` to opt out. */
export function html(strings, ...values) {
  return strings.reduce((out, chunk, i) => {
    if (i === 0) return chunk;
    const v = values[i - 1];
    const safe = v && v.__raw ? v.value : Array.isArray(v) ? v.join('') : esc(v);
    return out + safe + chunk;
  }, '');
}
html.raw = (value) => ({ __raw: true, value: value ?? '' });

// ── time ──────────────────────────────────────────────────────────────

const MIN = 60, HOUR = 3600, DAY = 86400;

/** Compact "how long ago": now · 4m · 2h · 3d · 5w. */
export function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 45) return 'now';
  if (s < HOUR) return `${Math.round(s / MIN)}m`;
  if (s < DAY) return `${Math.floor(s / HOUR)}h`;
  if (s < 7 * DAY) return `${Math.floor(s / DAY)}d`;
  return `${Math.floor(s / (7 * DAY))}w`;
}

/** A running stopwatch: 42s · 3m07s · 1h12m. */
export function elapsed(from) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(from).getTime()) / 1000));
  if (!Number.isFinite(s)) return '';
  if (s < MIN) return `${s}s`;
  if (s < HOUR) return `${Math.floor(s / MIN)}m${String(s % MIN).padStart(2, '0')}s`;
  return `${Math.floor(s / HOUR)}h${String(Math.floor((s % HOUR) / MIN)).padStart(2, '0')}m`;
}

export const clock = (iso) => iso
  ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  : '';

/** Today → a time; this year → "Oct 3, 4:12 PM"; older → with the year. */
export function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return clock(iso);
  const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleString([], opts);
}

/** Full timestamp for a `title=` tooltip. */
export const stamp = (iso) => (iso ? new Date(iso).toLocaleString() : '');

const midnight = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

/** Whole days between two instants, counted by calendar day: 0 today, 1 tomorrow. */
export function dayDelta(iso, now = Date.now()) {
  if (!iso) return NaN;
  return Math.round((midnight(new Date(iso)) - midnight(new Date(now))) / (DAY * 1000));
}

export const weekday = (iso) => (iso
  ? new Date(iso).toLocaleDateString([], { weekday: 'short' })
  : '');

/**
 * A clock time that says which day it is as soon as that isn't obvious:
 * "3:42 PM" today, "tomorrow 3:42 PM", "Thu 3:42 PM" inside the week,
 * "Oct 21, 3:42 PM" beyond it. A weekly limit resetting on Thursday must not
 * read like it resets this afternoon.
 */
export function dayClock(iso, now = Date.now()) {
  if (!iso) return '';
  const d = dayDelta(iso, now);
  if (!Number.isFinite(d)) return '';
  const t = clock(iso);
  if (d === 0) return t;
  if (d === 1) return `tomorrow ${t}`;
  if (d === -1) return `yesterday ${t}`;
  if (d > 1 && d < 7) return `${weekday(iso)} ${t}`;
  const date = new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${date}, ${t}`;
}

/** How long until something: "2d 4h" · "3h 10m" · "6m" · "any moment". */
export function until(iso, now = Date.now()) {
  if (!iso) return '';
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s <= 60) return 'any moment';
  if (s < HOUR) return `${Math.round(s / MIN)}m`;
  if (s < DAY) {
    const h = Math.floor(s / HOUR);
    const m = Math.round((s % HOUR) / MIN);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(s / DAY);
  const h = Math.round((s % DAY) / HOUR);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** A finished run's wall-clock duration, or '' if we can't know it. */
export function span(from, to) {
  if (!from || !to) return '';
  const s = Math.max(0, Math.round((new Date(to) - new Date(from)) / 1000));
  if (!Number.isFinite(s)) return '';
  if (s < MIN) return `${s}s`;
  if (s < HOUR) return `${Math.round(s / MIN)}m`;
  const h = Math.floor(s / HOUR);
  const m = Math.round((s % HOUR) / MIN);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Calendar day key in local time, for grouping by day. */
export const dayKey = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${
    String(d.getDate()).padStart(2, '0')}`;
};

// ── text ──────────────────────────────────────────────────────────────

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function clip(s, n = 120) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** First line of a prompt — a decent stand-in for a title. */
export const firstLine = (s) => clip(String(s ?? '').split('\n')[0], 90);
