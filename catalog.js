// The Projects screen's model: every project you have, what it is, and where
// it is live. Pure — rows already in memory in, plain data out — so views.js
// only has to draw it, and the smoke test can check it against fixed inputs.
//
// The description, language and live link come from the host, which reads
// them off GitHub, the README and the Fly app a fly.toml names (see
// agent-host/catalog.mjs). What this adds is the dashboard's own half: how
// many runs each project has had, and whether one is in flight.

const ACTIVE = new Set(['queued', 'running', 'paused']);
/** Which in-flight job speaks for a project when it has several. */
const URGENCY = { running: 0, paused: 1, queued: 2 };

const time = (iso) => Date.parse(iso ?? '') || 0;

/**
 * Only a web address becomes a link. The host writes these, but a homepage
 * starts life as free text on GitHub, and an href is no place to find out it
 * said `javascript:`.
 */
export const webUrl = (url) => (/^https?:\/\/[^\s"'<>]+$/i.test(String(url ?? '')) ? url : null);

/** Where a live link points, in the words the card prints: host and path. */
export function liveHost(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    return String(url ?? '');
  }
}

function entry(row, mine) {
  const newestFirst = [...mine].sort((a, b) => time(b.created_at) - time(a.created_at));
  const busy = mine.filter((j) => ACTIVE.has(j.status))
    .sort((a, b) => URGENCY[a.status] - URGENCY[b.status])[0] ?? null;
  // A deploy lands on the job before the host's next sync reaches the row.
  const deployed = newestFirst.find((j) => webUrl(j.live_url)) ?? null;
  const listedLive = webUrl(row.live_url);
  const lastRun = newestFirst[0]?.created_at ?? null;

  return {
    name: row.name,
    full_name: row.full_name ?? null,
    description: row.description ?? null,
    language: row.language ?? null,
    topics: row.topics ?? [],
    stars: row.stars ?? 0,
    private: row.private ?? null,
    is_local: Boolean(row.is_local),
    on_github: Boolean(row.full_name),
    is_fork: Boolean(row.is_fork),
    is_archived: Boolean(row.is_archived),
    live_url: listedLive ?? deployed?.live_url ?? null,
    live_kind: listedLive ? (row.live_kind ?? null) : deployed ? 'fly' : null,
    pushed_at: row.pushed_at ?? null,
    runs: mine.length,
    busy,
    // Whichever is later: the last push, or the last run you sent it.
    touched: Math.max(time(row.pushed_at), time(lastRun)),
  };
}

/**
 * One entry per project. That is the host's list, plus any project with a run
 * in flight that the list hasn't caught up with yet — a brand-new build has a
 * chat minutes before the host's next sync names it. A project the host has
 * lost (repo deleted, folder gone) is left out, as everywhere else.
 */
export function catalog({ projects = [], jobs = [] } = {}) {
  const runs = new Map();
  for (const j of jobs) {
    if (!j.project_slug) continue;
    if (!runs.has(j.project_slug)) runs.set(j.project_slug, []);
    runs.get(j.project_slug).push(j);
  }

  const listed = new Set(projects.map((p) => p.name));
  const entries = projects.map((p) => entry(p, runs.get(p.name) ?? []));
  for (const [slug, mine] of runs) {
    if (listed.has(slug)) continue;
    const building = mine.some((j) => ACTIVE.has(j.status));
    if (projects.length && !building) continue;
    entries.push(entry({ name: slug }, mine));
  }
  return entries;
}

/** Languages with how many projects use each, most used first. */
export function languages(entries) {
  const counts = new Map();
  for (const e of entries) if (e.language) counts.set(e.language, (counts.get(e.language) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Narrow the list. `filter` is 'all', 'live', or 'lang:<name>'; `query`
 * matches the name, description, language and topics.
 */
export function narrow(entries, { query = '', filter = 'all' } = {}) {
  const q = query.trim().toLowerCase();
  return entries.filter((e) => {
    if (filter === 'live' && !e.live_url) return false;
    if (filter.startsWith('lang:') && e.language !== filter.slice(5)) return false;
    if (!q) return true;
    return [e.name, e.full_name, e.description, e.language, ...e.topics]
      .some((s) => String(s ?? '').toLowerCase().includes(q));
  });
}

/**
 * 'recent' puts work in flight first, then whatever moved last. 'name' is
 * alphabetical, ignoring case — repo names come in every casing.
 */
export function order(entries, by = 'recent') {
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  if (by === 'name') return [...entries].sort(byName);
  return [...entries].sort((a, b) => (Number(Boolean(b.busy)) - Number(Boolean(a.busy)))
    || (b.touched - a.touched) || byName(a, b));
}

/** The counts the intro sentence is made of. */
export function tally(entries) {
  return {
    total: entries.length,
    live: entries.filter((e) => e.live_url).length,
    onGitHub: entries.filter((e) => e.on_github).length,
    localOnly: entries.filter((e) => e.is_local && !e.on_github).length,
  };
}
