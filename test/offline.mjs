// The outbox and the field-reports model, on their own: no DOM, no
// Supabase, a clock turned by hand. The smoke test walks the same paths
// through the real app; this is where the state machine's corners are
// pinned down — the lease race, the backoff, a lost answer, a report that
// has to wait for its site.

import {
  createOutbox, memoryStore, classify, backoffMs, isNetworkError, describe, MAX_ATTEMPTS, LEASE_MS,
} from '../outbox.js';
import {
  fieldSites, tally, filtered, timeline, cleanSite, cleanReport, reportId, dialable,
} from '../field.js';
import { demoRows } from '../field-demo.js';

let pass = 0;
const fails = [];
function ok(label, cond, detail = '') {
  if (cond) { pass++; return; }
  fails.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

const NO_NETWORK = { data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 };
const sent = { data: [{ id: 1 }], error: null, status: 201 };
const err = (status, code, message = 'nope') => ({ data: null, error: { code, message }, status });

function rig() {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const box = createOutbox({ store: memoryStore(), now: clock.now, random: () => 0.5 });
  return { box, clock };
}

// ── classify: what one answer means ───────────────────────────────────

ok('a clean answer is sent', classify(sent) === 'sent');
ok('a failed fetch is offline', classify(NO_NETWORK) === 'offline');
ok('a fetch failure without a status is still offline',
  classify({ error: { message: 'TypeError: Load failed', code: '' } }) === 'offline');
ok('a unique key refusing a copy means it already landed', classify(err(409, '23505')) === 'duplicate');
ok('a server error is retried', classify(err(503, '')) === 'retry');
ok('a rate limit is retried', classify(err(429, '')) === 'retry');
ok('an expired token is retried, not refused', classify(err(401, 'PGRST301', 'JWT expired')) === 'retry');
ok('row-level security refusing it is for a person', classify(err(403, '42501')) === 'reject');
ok('a missing table is for a person', classify(err(404, 'PGRST205')) === 'reject');
ok('a bad value is for a person', classify(err(400, '22P02')) === 'reject');
ok('isNetworkError ignores a real answer', !isNetworkError(err(500, 'XX000', 'Failed to fetch upstream')));
ok('describe points at the migration for a missing table',
  describe({ code: 'PGRST205', message: 'Could not find the table' }).includes('bridge/schema.sql'));

// ── backoff ───────────────────────────────────────────────────────────

ok('the first retry waits about two seconds', backoffMs(1, () => 0.5) === 2000);
ok('it doubles', backoffMs(3, () => 0.5) === 8000);
ok('and is capped at five minutes', backoffMs(30, () => 0.5) === 300_000);
ok('jitter stays within a quarter either side',
  backoffMs(2, () => 0) === 3000 && backoffMs(2, () => 1) === 5000);

// ── keeping and listing ───────────────────────────────────────────────

{
  const { box, clock } = rig();
  await box.add({ kind: 'job', owner: 'u1', title: 'first', payload: { prompt: 'a' } });
  clock.advance(10);
  await box.add({ kind: 'ask', owner: 'u1', title: 'second', payload: { text: 'b' } });
  await box.add({ kind: 'job', owner: 'u2', title: 'theirs', payload: {} });
  const mine = await box.list('u1');
  ok('the outbox lists one account at a time', mine.length === 2);
  ok('oldest first', mine[0].title === 'first' && mine[1].title === 'second');
  ok('a new entry waits', mine.every((e) => e.state === 'waiting' && e.attempts === 0));
  const c = await box.counts('u1');
  ok('counts what waits', c.waiting === 2 && c.failed === 0);
}

// ── sending ───────────────────────────────────────────────────────────

{
  const { box } = rig();
  await box.add({ id: 'a', kind: 'job', owner: 'u1' });
  await box.add({ id: 'b', kind: 'job', owner: 'u1' });
  const seen = [];
  const r = await box.flush({ owner: 'u1', send: async (e) => { seen.push(e.id); return sent; } });
  ok('a flush sends everything due, oldest first', seen.join() === 'a,b');
  ok('and says so', r.sent.length === 2 && !r.offline);
  ok('what was sent leaves the outbox', (await box.list('u1')).length === 0);
}

{
  const { box } = rig();
  await box.add({ id: 'a', kind: 'job', owner: 'u1' });
  await box.add({ id: 'b', kind: 'job', owner: 'u1' });
  let calls = 0;
  const r = await box.flush({ owner: 'u1', send: async () => { calls++; return NO_NETWORK; } });
  ok('no network stops the flush at the first entry', calls === 1 && r.offline);
  const left = await box.list('u1');
  ok('and keeps everything', left.length === 2);
  ok('with the lease released, so the next flush can take it', left[0].leaseUntil === 0);
  ok('a dead network does not count as a try', left[0].attempts === 0);
}

{
  // The write landed but the answer was lost: the retry is refused by the
  // unique key, which is the proof it is already there.
  const { box } = rig();
  await box.add({ id: 'a', kind: 'job', owner: 'u1' });
  const r = await box.flush({ owner: 'u1', send: async () => err(409, '23505') });
  ok('a duplicate counts as sent', r.duplicates.length === 1 && r.sent.length === 0);
  ok('and leaves the outbox', (await box.list('u1')).length === 0);
}

{
  const { box, clock } = rig();
  await box.add({ id: 'a', kind: 'job', owner: 'u1' });
  let calls = 0;
  const flaky = async () => { calls++; return err(503, ''); };
  let r = await box.flush({ owner: 'u1', send: flaky });
  let [e] = await box.list('u1');
  ok('a server error is retried later', r.later.length === 1 && e.state === 'waiting');
  ok('it counts a try and keeps the reason', e.attempts === 1 && e.lastError === 'nope');
  ok('and backs off', e.nextAttemptAt === clock.now() + 2000);
  r = await box.flush({ owner: 'u1', send: flaky });
  ok('nothing is resent before its time', calls === 1);
  clock.advance(2001);
  await box.flush({ owner: 'u1', send: flaky });
  ok('it goes again once it is due', calls === 2);

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    clock.advance(10 * 60_000);
    await box.flush({ owner: 'u1', send: flaky });
  }
  [e] = await box.list('u1');
  ok('after enough tries it waits for a person', e.state === 'failed');
  ok('and says it gave up', /gave up after \d+ tries/.test(e.lastError), e.lastError);
  const before = calls;
  clock.advance(60 * 60_000);
  await box.flush({ owner: 'u1', send: flaky });
  ok('a parked entry is not retried on its own', calls === before);

  await box.retry('a');
  [e] = await box.list('u1');
  ok('retry puts it back in line, with a clean slate',
    e.state === 'waiting' && e.attempts === 0 && e.lastError === null);
  await box.flush({ owner: 'u1', send: async () => sent });
  ok('and it goes', (await box.list('u1')).length === 0);
}

{
  const { box } = rig();
  await box.add({ id: 'a', kind: 'report', owner: 'u1' });
  await box.add({ id: 'b', kind: 'report', owner: 'u1' });
  const r = await box.flush({ owner: 'u1', send: async (e) => (e.id === 'a' ? err(403, '42501', 'row-level security') : sent) });
  ok('a refusal parks that entry', r.failed.length === 1 && r.failed[0].id === 'a');
  ok('without holding up the rest', r.sent.length === 1 && r.sent[0].entry.id === 'b');
  const [e] = await box.list('u1');
  ok('the parked one says why', e.state === 'failed' && /refused/.test(e.lastError), e.lastError);
  await box.discard('a');
  ok('discard removes it', (await box.list('u1')).length === 0);
}

{
  const { box } = rig();
  await box.add({ id: 'a', kind: 'job', owner: 'u1' });
  const r = await box.flush({ owner: 'u1', send: async () => { throw new Error('boom'); } });
  ok('a sender that throws is retried, not treated as a dead network', r.later.length === 1 && !r.offline);
}

{
  // Two tabs — or a tab and a retry tick — flushing at once.
  const { box } = rig();
  await box.add({ id: 'a', kind: 'job', owner: 'u1' });
  let calls = 0;
  const slow = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return sent; };
  await Promise.all([
    box.flush({ owner: 'u1', send: slow }),
    box.flush({ owner: 'u1', send: slow }),
  ]);
  ok('two flushes racing for one entry send it once', calls === 1, `sent ${calls} times`);
}

{
  // A lease left by a tab that died mid-send expires, and someone else takes it.
  const { box, clock } = rig();
  await box.add({ id: 'a', kind: 'job', owner: 'u1' });
  let calls = 0;
  const hang = () => { calls++; return new Promise(() => {}); };
  box.flush({ owner: 'u1', send: hang });
  await new Promise((r) => setTimeout(r, 5));
  await box.flush({ owner: 'u1', send: async () => { calls++; return sent; } });
  ok('a held entry is left alone', calls === 1);
  clock.advance(LEASE_MS + 1);
  await box.flush({ owner: 'u1', send: async () => { calls++; return sent; } });
  ok('until its lease runs out', calls === 2 && (await box.list('u1')).length === 0);
}

{
  // A report on a site added with no signal waits for the site.
  const { box, clock } = rig();
  await box.add({ id: 'site', kind: 'site', owner: 'u1' });
  clock.advance(5);
  await box.add({ id: 'rep', kind: 'report', owner: 'u1', after: 'site' });
  const order = [];
  let siteOk = false;
  const send = async (e) => { order.push(e.id); return e.id === 'site' && !siteOk ? err(500, '') : sent; };
  let r = await box.flush({ owner: 'u1', send });
  ok('a report does not go before its site', order.join() === 'site' && r.blocked.length === 1);
  siteOk = true;
  clock.advance(60_000);
  r = await box.flush({ owner: 'u1', send });
  ok('and goes in the same pass once the site has', order.join() === 'site,site,rep', order.join());
}

// ── the field model ───────────────────────────────────────────────────

const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const SITES = [
  { id: 's1', name: 'Weir', priority: 1, status: 'ok', last_report_at: iso(60) },
  { id: 's2', name: 'Booster', priority: 2, status: 'blocked', last_report_at: iso(10) },
  { id: 's3', name: 'Alpha pad', priority: 2, status: 'unvisited', last_report_at: null },
];
const queued = (id, siteId, status, minutesAgo, extra = {}) => ({
  id, kind: 'report', state: 'waiting', createdAt: Date.now(),
  payload: { siteId, status, recordedAt: iso(minutesAgo), note: '' }, ...extra,
});

{
  const list = fieldSites({ sites: SITES, outbox: [] });
  ok('sites sort by priority, then name', list.map((s) => s.id).join() === 's1,s3,s2');
  const n = tally(list);
  ok('the tally counts each state', n.ok === 1 && n.blocked === 1 && n.unvisited === 1 && n.all === 3);
  ok('attention is blocked plus needs work', n.attention === 1);
  ok('a filter narrows the list', filtered(list, 'blocked').length === 1 && filtered(list, 'all').length === 3);
}

{
  // Recorded 5 minutes ago, after the site's last report an hour ago.
  const list = fieldSites({ sites: SITES, outbox: [queued('r1', 's1', 'needs_work', 5)] });
  const s1 = list.find((s) => s.id === 's1');
  ok('a queued report shows as the site status', s1.status === 'needs_work' && s1.saved === 'ok');
  ok('and is counted as not sent', s1.queued.length === 1 && tally(list).queued === 1);
}

{
  // Recorded 30 minutes ago — before the 10-minutes-ago report already saved.
  const list = fieldSites({ sites: SITES, outbox: [queued('r1', 's2', 'ok', 30)] });
  const s2 = list.find((s) => s.id === 's2');
  ok('a late report does not overwrite a newer one on screen either', s2.status === 'blocked');
}

{
  const site = { id: 'new-site', kind: 'site', state: 'waiting', createdAt: Date.now(),
    payload: { name: 'Pump house', priority: 3, address: '1 Lake Rd' } };
  const list = fieldSites({ sites: SITES, outbox: [site, queued('r9', 'new-site', 'ok', 1)] });
  const s = list.find((x) => x.id === 'new-site');
  ok('a site added with no signal is listed', Boolean(s) && s.name === 'Pump house');
  ok('marked as not sent', s?.unsent?.id === 'new-site');
  ok('and can carry a report already', s?.status === 'ok' && s.queued.length === 1);
}

{
  const reports = [
    { id: 'old', site_id: 's1', status: 'ok', recorded_at: iso(300) },
    { id: 'new', site_id: 's1', status: 'needs_work', recorded_at: iso(60) },
    { id: 'r1', site_id: 's1', status: 'blocked', recorded_at: iso(5) },
    { id: 'else', site_id: 's2', status: 'ok', recorded_at: iso(1) },
  ];
  const t = timeline('s1', { reports, outbox: [queued('r1', 's1', 'blocked', 5), queued('r2', 's1', 'ok', 2)] });
  ok('queued reports come first, newest first', t.queued.map((e) => e.id).join() === 'r2,r1');
  ok('saved ones newest first, only this site\'s', t.saved.map((r) => r.id).join() === 'new,old');
  ok('a report both sent and still listed is shown once', !t.saved.some((r) => r.id === 'r1'));
}

{
  const { site, error } = cleanSite({ name: '  Gate 4  ', priority: '9', address: ' x '.repeat(400) });
  ok('a site keeps its trimmed name', !error && site.name === 'Gate 4');
  ok('an out-of-range priority falls back to P2', site.priority === 2);
  ok('long text is bounded', site.address.length <= 300);
  ok('a site needs a name', cleanSite({ name: '   ' }).error === 'A site needs a name');
  ok('a report needs a finding', cleanReport({ status: 'great' }).error === 'Pick what you found');
  ok('a report keeps a valid one', cleanReport({ status: 'blocked', note: ' gate shut ' }).report.note === 'gate shut');
  ok('a phone number is made dialable', dialable('+1 (416) 555-0141') === '+14165550141');
}

{
  // The ids have to pass the table's own check: ^[A-Za-z0-9_-]{8,64}$.
  const ID = /^[A-Za-z0-9_-]{8,64}$/;
  ok('a report id passes the column check', ID.test(reportId(crypto.randomUUID())));
  const { sites, reports } = demoRows('u1', () => crypto.randomUUID(), Date.now());
  ok('the demo has Field Reports\' 14 sites', sites.length === 14);
  ok('and its 9 reports, each on one of them',
    reports.length === 9 && reports.every((r) => sites.some((s) => s.id === r.site_id)));
  ok('every demo report id passes the column check', reports.every((r) => ID.test(r.id)));
  ok('every demo row is owned', [...sites, ...reports].every((r) => r.owner === 'u1'));
}

// ── report ────────────────────────────────────────────────────────────

console.log(`\n  ${pass} checks passed`);
if (fails.length) {
  console.log(`  ${fails.length} failed:\n`);
  for (const f of fails) console.log(`   ✗ ${f}`);
  process.exit(1);
}
console.log('  all good\n');
