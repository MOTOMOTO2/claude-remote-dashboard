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

// ── text ──────────────────────────────────────────────────────────────

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function clip(s, n = 120) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** First line of a prompt — a decent stand-in for a title. */
export const firstLine = (s) => clip(String(s ?? '').split('\n')[0], 90);
