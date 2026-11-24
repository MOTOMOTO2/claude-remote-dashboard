// Field reports: sites to visit, what was found at each, and the reports
// still on this phone. Pure — the store hands in rows and the outbox, and
// this works out what the screens show.
//
// The model is Field Reports' (offline-sync-pwa): a site carries a status,
// a report is one of three findings, and the site's status is its newest
// report's — newest by when it was *recorded*, not when it reached the
// server, so a report written in a dead zone this morning and sent this
// afternoon cannot overwrite what someone saw at lunch.

export const FINDINGS = ['ok', 'needs_work', 'blocked'];

export const STATUS_WORD = {
  ok: 'OK', needs_work: 'Needs work', blocked: 'Blocked', unvisited: 'Not visited',
};

/** The ramp the rest of the app already speaks: green, amber, red, grey. */
export const STATUS_TONE = {
  ok: 'done', needs_work: 'paused', blocked: 'error', unvisited: 'queued',
};

export const FILTERS = [
  ['all', 'All'], ['needs_work', 'Needs work'], ['blocked', 'Blocked'],
  ['unvisited', 'Not visited'], ['ok', 'OK'],
];

export const LIMITS = { name: 200, note: 2000, author: 120, text: 300 };

const time = (v) => {
  const t = typeof v === 'number' ? v : Date.parse(v ?? '');
  return Number.isFinite(t) ? t : 0;
};

/** A report's id: the table's primary key and the retry's idempotency key at once. */
export const reportId = (uuid) => `rep-${String(uuid).replace(/-/g, '')}`;

/** A phone number a `tel:` link can dial. */
export const dialable = (phone) => String(phone ?? '').replace(/[^+\d]/g, '');

const byPriority = (a, b) => (a.priority - b.priority)
  || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/**
 * The sites as this phone should show them: what Supabase has, plus any
 * added here with no signal, each with the reports still waiting to go.
 *
 * A queued report already happened on the ground, so it sets the status
 * shown — unless something recorded later is already on the server.
 */
export function fieldSites({ sites = [], outbox = [] } = {}) {
  const queued = new Map();
  for (const e of outbox) {
    if (e.kind !== 'report') continue;
    const id = e.payload?.siteId;
    if (!queued.has(id)) queued.set(id, []);
    queued.get(id).push(e);
  }

  const known = new Set(sites.map((s) => s.id));
  const local = outbox
    .filter((e) => e.kind === 'site' && !known.has(e.id))
    .map((e) => ({ ...e.payload, id: e.id, status: 'unvisited', last_report_at: null, unsent: e }));

  return [...sites, ...local].map((site) => {
    const mine = (queued.get(site.id) ?? [])
      .sort((a, b) => time(a.payload.recordedAt) - time(b.payload.recordedAt));
    let status = site.status ?? 'unvisited';
    let at = time(site.last_report_at);
    for (const q of mine) {
      const t = time(q.payload.recordedAt);
      if (t >= at) { status = q.payload.status; at = t; }
    }
    return {
      id: site.id,
      name: String(site.name ?? '').trim() || 'Unnamed site',
      address: site.address ?? '',
      region: site.region ?? '',
      asset_tag: site.asset_tag ?? '',
      priority: Math.min(3, Math.max(1, Number(site.priority) || 2)),
      access_notes: site.access_notes ?? '',
      contact_name: site.contact_name ?? '',
      contact_phone: site.contact_phone ?? '',
      /** What to show: the newest finding, queued or not. */
      status,
      /** What Supabase says, before anything on this phone is counted. */
      saved: site.status ?? 'unvisited',
      lastAt: at || null,
      queued: mine,
      /** The outbox entry, when the site itself has not reached Supabase. */
      unsent: site.unsent ?? null,
    };
  }).sort(byPriority);
}

/** How many sites are in each state, and how many need someone. */
export function tally(list = []) {
  const n = { all: list.length, ok: 0, needs_work: 0, blocked: 0, unvisited: 0, queued: 0 };
  for (const s of list) {
    n[s.status] = (n[s.status] ?? 0) + 1;
    n.queued += s.queued.length;
  }
  n.attention = n.needs_work + n.blocked;
  return n;
}

export const filtered = (list, key) => (key === 'all' || !key ? list : list.filter((s) => s.status === key));

/**
 * One site's history, newest first: the reports still on this phone on
 * top, because they are the newest thing you know, then what Supabase has.
 */
export function timeline(siteId, { reports = [], outbox = [] } = {}) {
  const queued = outbox
    .filter((e) => e.kind === 'report' && e.payload?.siteId === siteId)
    .sort((a, b) => time(b.payload.recordedAt) - time(a.payload.recordedAt));
  const saved = reports
    .filter((r) => r.site_id === siteId && !queued.some((q) => q.id === r.id))
    .sort((a, b) => time(b.recorded_at) - time(a.recorded_at) || time(b.received_at) - time(a.received_at));
  return { queued, saved };
}

/** The fields of a new site, trimmed and bounded; `error` when it can't be saved. */
export function cleanSite(input = {}) {
  const text = (v, max = LIMITS.text) => String(v ?? '').trim().slice(0, max);
  const site = {
    name: text(input.name, LIMITS.name),
    address: text(input.address),
    region: text(input.region),
    asset_tag: text(input.asset_tag),
    priority: [1, 2, 3].includes(Number(input.priority)) ? Number(input.priority) : 2,
    access_notes: text(input.access_notes, LIMITS.note),
    contact_name: text(input.contact_name),
    contact_phone: text(input.contact_phone),
  };
  return { site, error: site.name ? null : 'A site needs a name' };
}

/** A report's fields, trimmed and bounded. */
export function cleanReport(input = {}) {
  const status = FINDINGS.includes(input.status) ? input.status : null;
  return {
    report: {
      status: status ?? 'ok',
      note: String(input.note ?? '').trim().slice(0, LIMITS.note),
      author: String(input.author ?? '').trim().slice(0, LIMITS.author),
    },
    error: status ? null : 'Pick what you found',
  };
}
