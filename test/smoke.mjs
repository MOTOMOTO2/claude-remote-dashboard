// Boots the real app in jsdom against a fake Supabase and walks the screens
// a person actually uses. No build step means no type checker, so this is the
// safety net: it catches a renamed id, a broken selector, or a render that
// throws, which is exactly what goes wrong in a vanilla app.

import { readdirSync } from 'node:fs';
import { fake } from './fake-supabase.mjs';
import { root, file, seed, makeWindow, tick, iso } from './harness.mjs';

let pass = 0;
const fails = [];

function ok(label, cond, detail = '') {
  if (cond) { pass++; return; }
  fails.push(`${label}${detail ? ` — ${detail}` : ''}`);
}
const has = (label, haystack, needle) =>
  ok(label, String(haystack).includes(needle), `missing ${JSON.stringify(needle)}`);

// ── 1. static invariants ──────────────────────────────────────────────

const htmlSrc = file('index.html');
const jsFiles = readdirSync(root)
  .filter((f) => f.endsWith('.js') && !['config.js', 'config.example.js', 'sw.js'].includes(f));
const jsSrc = jsFiles.map((f) => file(f)).join('\n');

const declaredIds = [...htmlSrc.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const dupes = declaredIds.filter((v, i) => declaredIds.indexOf(v) !== i);
ok('no duplicate element ids', dupes.length === 0, dupes.join(', '));

const usedIds = new Set([...jsSrc.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
for (const id of usedIds) {
  ok(`#${id} exists in index.html`, declaredIds.includes(id));
}

const sprite = new Set([...htmlSrc.matchAll(/<g id="i-([\w-]+)"/g)].map((m) => m[1]));
const wanted = new Set([
  ...[...htmlSrc.matchAll(/href="#i-([\w-]+)"/g)].map((m) => m[1]),
  ...[...jsSrc.matchAll(/icon\('([\w-]+)'/g)].map((m) => m[1]),
  ...[...jsSrc.matchAll(/glyph: '([\w-]+)'/g)].map((m) => m[1]),
  ...[...jsSrc.matchAll(/glyph = '([\w-]+)'/g)].map((m) => m[1]),
  // suggestion glyphs are named as data, so they dodge the icon() pattern
  ...[...file('suggest.js').matchAll(/icon: '([\w-]+)'/g)].map((m) => m[1]),
]);
for (const name of wanted) ok(`icon #i-${name} is in the sprite`, sprite.has(name));

const shell = JSON.parse(file('sw.js').match(/const FILES = (\[[^\]]+\])/)[1].replace(/'/g, '"'));
const onDisk = new Set(readdirSync(root));
for (const name of shell) {
  ok(`service worker caches a real file: ${name}`, name === '.' || onDisk.has(name));
}
for (const name of jsFiles) {
  ok(`${name} is in the service-worker shell`, shell.includes(name));
}

// ── 2. fixtures and a window ──────────────────────────────────────────

seed();
const { window, screen } = makeWindow({ width: 1200 });

const el = (id) => window.document.getElementById(id);
const text = (id) => el(id)?.textContent.trim() ?? '';

// ── 4. boot: signed out ───────────────────────────────────────────────

await import('../app.js');
await tick();

ok('boot splash is hidden once the session is known', el('boot').hidden);
ok('sign-in form is shown when there is no session', !el('auth').hidden);
ok('app shell is hidden when signed out', el('app').hidden);

// ── 5. sign in → home ─────────────────────────────────────────────────

el('email').value = 'me@example.com';
el('password').value = 'hunter2';
el('auth-form').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
await tick();

ok('app shell is shown after sign-in', !el('app').hidden);
ok('sign-in form is hidden after sign-in', el('auth').hidden);

ok('hero counts the running agents', text('hero-value') === '1', `got ${text('hero-value')}`);
ok('hero label is singular for one agent', text('hero-label') === 'agent running');
has('hero chips mention the paused job', el('hero-chips').innerHTML, 'paused for usage');

ok('live block is visible', !el('active-block').hidden);
ok('live block lists the two open jobs', el('active-list').querySelectorAll('.row').length === 2);
ok('every live row links somewhere real',
  [...el('active-list').querySelectorAll('.row')].every((r) => /#\/(p|j)\/.+/.test(r.getAttribute('href'))));
has('live row shows the current activity', el('active-list').innerHTML, 'Edit src/game.js');

const meters = el('usage-home').querySelectorAll('.meter');
ok('three usage meters render', meters.length === 3, `got ${meters.length}`);
has('meter is labelled in words', el('usage-home').innerHTML, 'Session · 5 hours');
has('meter prints its percentage', el('usage-home').innerHTML, '42%');
has('meter prints the headroom too', el('usage-home').innerHTML, '58% left');
ok('high usage meter carries the severity class',
  el('usage-home').querySelectorAll('.meter.full').length === 1);
ok('mid usage meter carries the warn class',
  el('usage-home').querySelectorAll('.meter.warn').length === 1);
ok('meter fill width matches the value',
  el('usage-home').querySelector('.meter-fill').getAttribute('style').includes('42%'));
has('severity ships as a word, not just a colour', el('usage-home').innerHTML, 'nearly out');
has('a healthy window says so', el('usage-home').innerHTML, 'healthy');

// The weekly window resets in ~2.8 days, so it has to name the day and not
// just a clock — the bug this block exists to pin down.
const weeklyReset = new Date(Date.now() + 4000 * 60_000);
const weeklyDay = weeklyReset.toLocaleDateString([], { weekday: 'short' });
const weeklyMeter = [...meters].find((m) => m.textContent.includes('all models'));
has('the weekly meter names the day it resets', weeklyMeter.textContent, weeklyDay);
has('the weekly meter still gives the time', weeklyMeter.textContent,
  weeklyReset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
has('the weekly meter counts down as well', weeklyMeter.textContent, 'in 2d');
ok('the 5-hour meter does not bother with a weekday',
  !/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/.test(
    [...meters].find((m) => m.textContent.includes('5 hours')).textContent));
has('a window with no reset time admits it', el('usage-home').innerHTML, 'reset time unknown');

// the topbar carries the tightest window, so a limit is never a surprise
ok('the usage pill is shown', !el('usage-pill').hidden);
has('the usage pill reports the tightest window', text('usage-pill-text'), '88%');
ok('the usage pill wears that severity', el('usage-pill').classList.contains('full'));
has('the usage pill explains itself in words',
  el('usage-pill').getAttribute('aria-label'), 'tightest window');
has('and names the reset day there too', el('usage-pill').getAttribute('aria-label'), weeklyDay);

ok('project tile counts the projects', text('kpi-projects') === '4', `got ${text('kpi-projects')}`);
has('project tile says how many have been run', text('kpi-projects-note'), '3 worked on');
ok('finished tile counts done jobs', text('kpi-done') === '1');
has('finished tile adds up the turns', text('kpi-done-note'), '14 turns');
ok('failed tile counts errors', text('kpi-failed') === '1');
ok('failed tile is flagged', el('kpi-failed').closest('.tile').classList.contains('flag'));
ok('first-try rate is a share of the settled runs', text('kpi-rate') === '50%', `got ${text('kpi-rate')}`);
has('first-try rate names its denominator', text('kpi-rate-note'), '2 finished runs');

// the hero says how many; the line under it says what
ok('the hero names what the running agent is doing', !el('hero-now').hidden);
has('the hero line names the project', el('hero-now').innerHTML, 'alpha');
has('the hero line quotes the live activity', el('hero-now').innerHTML, 'Edit src/game.js');

// runs per day — one column per day, today's is the marked one
const cols = el('activity').querySelectorAll('.bar-col');
ok('the activity strip has a column per day', cols.length === 14, `got ${cols.length}`);
ok('today is the one marked column',
  el('activity').querySelectorAll('.bar-col.today').length === 1
  && cols[13].classList.contains('today'));
ok('every column is labelled for a screen reader',
  [...cols].every((c) => /run/.test(c.getAttribute('aria-label') ?? '')));
has('the heading totals the runs', text('activity-note'), '4 runs');

// your desktop, spelled out where the pill has no room to
has('the desktop card names the host', el('desktop-card').textContent, 'desk-pc');
has('the desktop card says it is online', el('desktop-card').textContent, 'online');
has('the desktop card reports the live feed', el('desktop-card').textContent, 'Live updates');
has('the desktop card says what that means', el('desktop-card').textContent, 'starts right away');

// suggestions, read off the account as it stands
has('a failed project is the first thing suggested',
  el('suggest-list').innerHTML, 'Fix what broke in beta');
has('a suggestion shows the reason it was offered',
  el('suggest-list').innerHTML, 'npm install failed');
has('an untouched repo is offered a look',
  el('suggest-new').innerHTML, 'Take a look at untouched-repo');
ok('a project that is mid-run is left alone',
  !el('suggest-new').innerHTML.includes('alpha'));
ok('home shows a short list', el('suggest-list').querySelectorAll('.suggest').length === 3);
ok('the new-project view shows the full list',
  el('suggest-new').querySelectorAll('.suggest').length === 6);
has('the heading says where they came from', text('suggest-note'), 'from your 2 projects');

ok('recent block is visible', !el('recent-block').hidden);
ok('recent block lists finished jobs', el('recent-list').querySelectorAll('.row').length === 2);

ok('sidebar lists three chats and one untouched repo',
  el('project-list').querySelectorAll('.list-item').length === 4,
  `got ${el('project-list').querySelectorAll('.list-item').length}`);
has('sidebar labels the untouched repos', el('project-list').innerHTML, 'Your repos');
has('sidebar shows a running tag', el('project-list').innerHTML, 'data-status="running"');
ok('composer is hidden on home', el('composer').hidden);
ok('host pill reads online', el('host-badge').classList.contains('online'));
has('host name is shown', text('host-name'), 'desk-pc');

// search filters the list
el('project-search').value = 'bet';
el('project-search').dispatchEvent(new window.Event('input', { bubbles: true }));
await tick();
ok('search narrows the sidebar to one match',
  el('project-list').querySelectorAll('.list-item').length === 1);
el('project-search').value = '';
el('project-search').dispatchEvent(new window.Event('input', { bubbles: true }));
await tick();

// ── 6. a project thread ───────────────────────────────────────────────

window.location.hash = '#/p/alpha';
await tick();

ok('chat view is shown', !el('chat-view').hidden);
ok('home view is hidden', el('home-view').hidden);
ok('composer is shown in a chat', !el('composer').hidden);
ok('repo visibility is hidden for an existing project', el('visibility-wrap').hidden);
ok('title is the project name', text('view-title') === 'alpha');
has('subtitle names the repo', text('view-sub'), 'me/alpha');

ok('both turns render', el('thread').querySelectorAll('.turn').length === 2);
ok('the open project is marked current',
  el('project-list').querySelector('[aria-current="page"]')?.textContent.includes('alpha'));
has('the prompt is shown', el('thread').innerHTML, 'build a snake game');
has('markdown bold becomes strong', el('thread').innerHTML, '<strong>high-score</strong>');
has('markdown list becomes a ul', el('thread').innerHTML, '<li>persists across reloads</li>');
has('markdown fence becomes a pre', el('thread').innerHTML, '<pre><code>const best = 0;');
ok('a user prompt containing html is escaped',
  !el('thread').innerHTML.includes('<script>alert(1)</script>'));
has('the escaped prompt is still readable', el('thread').innerHTML, '&lt;script&gt;');

ok('the running job has a live log', Boolean(el('thread').querySelector('[data-log="j1"]')));
ok('the finished job folds its log', Boolean(el('thread').querySelector('.fold')));
ok('a running job offers stop', Boolean(el('thread').querySelector('[data-cancel="j1"]')));
ok('a finished job offers run again', Boolean(el('thread').querySelector('[data-retry="j2"]')));
ok('a summary can be copied', Boolean(el('thread').querySelector('[data-copy-summary="j2"]')));
has('the repo link is offered', el('chat-head').innerHTML, 'https://github.com/me/alpha');
ok('the chat can be cleared', Boolean(el('chat-head').querySelector('[data-delete-chat="alpha"]')));
has('the chat head counts the runs', el('chat-head').textContent, '2 runs');
has('the chat head counts the finished ones', el('chat-head').textContent, '1 done');
has('the chat head adds up the turns', el('chat-head').textContent, '14 turns');
has('a reply shows the effort it ran at', el('thread').textContent, 'high effort');
has('a reply shows the usage cap it was given', el('thread').textContent, 'pauses at 90%');
has('a finished reply shows its turn count', el('thread').textContent, '14 turns');

// a live log line arrives
fake.emit('job_events', 'INSERT', { id: 9, job_id: 'j1', kind: 'tool', text: 'Bash npm test' });
await tick();
has('a realtime log line is appended', el('thread').querySelector('[data-log="j1"]').innerHTML,
  'Bash npm test');

// ── 7. sending a follow-up ────────────────────────────────────────────

el('prompt').value = 'now add sound effects';
el('composer').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
await tick();

const sent = fake.inserts.at(-1);
ok('a follow-up job was inserted', Boolean(sent));
ok('the follow-up carries the project slug', sent?.project_slug === 'alpha');
ok('the follow-up is an existing-project job', sent?.mode === 'existing');
ok('the follow-up keeps the chosen effort', sent?.effort === 'high');
ok('the follow-up keeps the usage cap', sent?.usage_cap_pct === 90);
ok('the composer is cleared after sending', el('prompt').value === '');
ok('a toast confirms the queue', el('toasts').children.length > 0);

// ── 8. stopping a job ─────────────────────────────────────────────────

el('thread').querySelector('[data-cancel="j1"]').click();
await tick();
ok('stop requests cancellation',
  fake.updates.some((u) => u.patch?.cancel_requested === true && u.where[1] === 'j1'));

// ── 9. a job finishing while you watch ────────────────────────────────

fake.emit('jobs', 'UPDATE', { ...fake.tables.jobs[0], status: 'done', num_turns: 9 });
await tick();
has('a finish toast names the project', el('toasts').textContent, 'alpha');
ok('the thread re-renders without a live log', !el('thread').querySelector('[data-log="j1"]'));

// ── 10. the new-project view ──────────────────────────────────────────

window.location.hash = '#/new';
await tick();

ok('new view is shown', !el('new-view').hidden);
ok('repo visibility is offered for a new project', !el('visibility-wrap').hidden);
ok('suggestions render', el('suggest-new').querySelectorAll('.suggest').length >= 3);
ok('an empty-ish account still gets openers',
  el('suggest-new').innerHTML.includes('data-kind="starter"'));

// A suggestion aimed at a project opens that chat with the prompt loaded —
// it is a head start, not a send.
el('suggest-new').querySelector('[data-suggest="fix:beta"]').click();
await tick();
ok('a project suggestion opens that project', window.location.hash === '#/p/beta',
  `got ${window.location.hash}`);
has('a project suggestion loads its prompt', el('prompt').value, 'The last run failed');
has('and the prompt carries the real error', el('prompt').value, 'ETARGET');
ok('nothing was queued by clicking it', fake.inserts.at(-1)?.prompt !== el('prompt').value);

window.location.hash = '#/new';
await tick();
el('prompt').value = '';
el('suggest-new').querySelector('[data-kind="starter"]').click();
await tick();
ok('an opener lands in the new-project composer', el('prompt').value.length > 10);
ok('an opener stays on the new-project view', window.location.hash === '#/new');

el('composer').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
await tick();
const made = fake.inserts.at(-1);
ok('a new-project job has no slug', made?.project_slug === null);
ok('a new-project job is mode=new', made?.mode === 'new');
ok('a new-project job carries the repo visibility',
  ['private', 'public', 'none'].includes(made?.repo_visibility));
ok('sending follows the job until it is named', window.location.hash.startsWith('#/j/'));
await tick();
has('the pending view shows your message', el('thread').innerHTML, made.prompt.slice(0, 20));

// the host names it → we slide over to the real chat
fake.emit('jobs', 'UPDATE', { ...made, project_slug: 'delta', status: 'running' });
await tick();
ok('a named job redirects to its chat', window.location.hash === '#/p/delta',
  `got ${window.location.hash}`);

// ── 11. clearing a chat ───────────────────────────────────────────────

window.location.hash = '#/p/beta';
await tick();
el('chat-head').querySelector('[data-delete-chat="beta"]').click();
await tick();
const dlg = el('confirm');
if (dlg.open) { el('confirm-yes').click(); }
await tick();
ok('clearing a chat deletes its jobs',
  fake.deletes.some((d) => d.table === 'jobs' && d.where[1] === 'beta'));
ok('clearing a chat returns home', window.location.hash === '#/' || window.location.hash === '');

// ── 12. theme ─────────────────────────────────────────────────────────

window.document.querySelector('[data-theme-set="dark"]').click();
ok('dark theme is stamped on the root', window.document.documentElement.dataset.theme === 'dark');
ok('theme choice is persisted', window.localStorage.getItem('cr-theme') === 'dark');
window.document.querySelector('[data-theme-set="system"]').click();
ok('system theme removes the stamp', !window.document.documentElement.hasAttribute('data-theme'));
ok('theme-color meta is kept in sync',
  Boolean(window.document.querySelector('meta[name="theme-color"]')));

// ── 13. the drawer and shortcuts on a phone ───────────────────────────

screen.width = 420;
el('menu-open').click();
ok('the drawer opens on a phone', el('sidebar').classList.contains('open'));
ok('the scrim covers the page with it', !el('scrim').hidden);
ok('the menu button reports its state', el('menu-open').getAttribute('aria-expanded') === 'true');

const key = (k) => window.document.dispatchEvent(
  new window.KeyboardEvent('keydown', { key: k, bubbles: true }));

key('Escape');
ok('Escape closes the drawer', !el('sidebar').classList.contains('open'));
ok('the scrim goes with it', el('scrim').hidden);

el('menu-open').click();
window.location.hash = '#/p/gamma';
await tick();
ok('opening a project closes the drawer', !el('sidebar').classList.contains('open'));
ok('the paused job explains itself', el('thread').textContent.includes('picks up'));

screen.width = 1200;
window.document.activeElement?.blur?.();   // shortcuts stay out of the way while typing
key('n');
await tick();
ok('"n" starts a new project', window.location.hash === '#/new');
key('/');
ok('"/" focuses the composer', window.document.activeElement === el('prompt'));
window.document.activeElement.blur();
window.location.hash = '#/';
await tick();
key('/');
ok('"/" does nothing on home, where there is no composer',
  window.document.activeElement !== el('prompt'));

// ── 14. finish notifications ──────────────────────────────────────────

ok('the bell starts off', el('notify-toggle').getAttribute('aria-pressed') === 'false');
el('notify-toggle').click();
await tick();
ok('turning the bell on asks for permission', window.Notification.permission === 'granted');
ok('the bell reports that it is on', el('notify-toggle').getAttribute('aria-pressed') === 'true');
ok('the choice is remembered', window.localStorage.getItem('cr-notify') === 'on');

const row = (id) => fake.tables.jobs.find((j) => j.id === id);

// While you are looking at the page a toast is enough.
fake.emit('jobs', 'UPDATE', { ...row('j4'), status: 'done' });
await tick();
ok('no notification while the page is visible', window.notifications.length === 0);

Object.defineProperty(window.document, 'visibilityState', { value: 'hidden', configurable: true });
fake.emit('jobs', 'UPDATE', { ...row('j1'), status: 'error' });
await tick();
ok('a background finish raises a notification', window.notifications.length === 1);
has('the notification names the project', window.notifications[0]?.title ?? '', 'alpha');

el('notify-toggle').click();
await tick();
ok('the bell can be turned back off', el('notify-toggle').getAttribute('aria-pressed') === 'false');
fake.emit('jobs', 'UPDATE', { ...row('j4'), status: 'error' });
await tick();
ok('nothing is raised once it is off', window.notifications.length === 1);

// ── 15. coming back to an empty account ───────────────────────────────

window.location.hash = '#/';
await tick();
fake.tables.jobs = [];
fake.tables.projects = [];
fake.tables.usage_windows = [];
fake.tables.job_events = [];

// Returning to the tab resyncs — the same path a phone takes after sleeping.
Object.defineProperty(window.document, 'visibilityState', { value: 'visible', configurable: true });
window.document.dispatchEvent(new window.Event('visibilitychange'));
await tick();

ok('the first-run empty state appears', !el('home-empty').hidden);
ok('the hero figure steps aside for it', el('hero-card').hidden);
ok('the live block is hidden with nothing to show', el('active-block').hidden);
ok('the usage block is hidden with no readings', el('usage-block').hidden);
ok('the glance tiles are hidden too', el('glance-block').hidden);
ok('the activity strip is hidden with no runs', el('activity-block').hidden);
ok('the desktop card is hidden on the first run', el('desktop-block').hidden);
ok('the suggestions block is hidden on the first run', el('suggest-block').hidden);
ok('the usage pill leaves the topbar', el('usage-pill').hidden);
ok('starting a project is still one tap away', !el('home-new').hidden);
has('the sidebar says so as well', el('project-list').textContent, 'No projects yet');

// ── 16. time helpers ──────────────────────────────────────────────────
// The reset label is the one piece of formatting a wrong answer makes
// actively misleading, so it gets fixed dates rather than fixtures.

const { dayClock, until, dayDelta, span, weekday } = await import('../util.js');
const noon = new Date('2026-03-12T12:00:00');          // a Thursday
const at = (d, h, m = 0) => new Date(2026, 2, d, h, m).toISOString();

ok('a reset later today is just a clock',
  dayClock(at(12, 15, 30), noon) === new Date(at(12, 15, 30))
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  dayClock(at(12, 15, 30), noon));
has('a reset tomorrow says tomorrow', dayClock(at(13, 9), noon), 'tomorrow');
ok('a reset later this week names the weekday',
  dayClock(at(15, 9), noon).startsWith(weekday(at(15, 9))), dayClock(at(15, 9), noon));
has('a reset beyond the week names the date', dayClock(at(23, 9), noon), 'Mar 23');
ok('a reset yesterday says so', dayClock(at(11, 9), noon).startsWith('yesterday'));
ok('an empty reset is empty', dayClock(null) === '' && dayClock(undefined) === '');

ok('day deltas count calendar days, not hours',
  dayDelta(at(13, 1), noon) === 1 && dayDelta(at(12, 23, 59), noon) === 0);

ok('a countdown over a day reads in days and hours',
  until(at(14, 16), noon) === '2d 4h', until(at(14, 16), noon));
ok('a countdown inside a day reads in hours and minutes',
  until(at(12, 15, 30), noon) === '3h 30m', until(at(12, 15, 30), noon));
ok('a countdown inside the hour reads in minutes',
  until(at(12, 12, 40), noon) === '40m', until(at(12, 12, 40), noon));
ok('an imminent reset says so', until(at(12, 12, 1), noon) === 'any moment');
ok('a span reads as a duration', span(at(12, 10), at(12, 12, 35)) === '2h 35m',
  span(at(12, 10), at(12, 12, 35)));
ok('a span with nothing to measure is empty', span(null, at(12, 12)) === '');

// ── 17. the suggestion engine ─────────────────────────────────────────

const { suggest } = await import('../suggest.js');

const only = (list, kind) => list.filter((s) => s.kind === kind);
const kinds = (list) => list.map((s) => s.kind);

const failed = suggest({
  jobs: [{ id: 'a', project_slug: 'solo', status: 'error', created_at: iso(5),
    prompt: 'build a thing', error: 'boom' }],
  projects: [{ name: 'solo', full_name: 'me/solo' }],
});
ok('a failed run is suggested first', failed[0].kind === 'fix', kinds(failed).join());
has('the fix prompt quotes the error', failed[0].prompt, 'boom');
ok('the fix is aimed at that project', failed[0].slug === 'solo');

const local = suggest({
  jobs: [{ id: 'a', project_slug: 'solo', status: 'done', created_at: iso(5),
    prompt: 'a snake game for the browser with tests' }],
  projects: [{ name: 'solo', full_name: null, is_local: true }],
});
ok('a local-only project is offered a push', kinds(local).includes('publish'), kinds(local).join());
ok('a project that mentions tests is not asked for tests again',
  !kinds(local).includes('tests'));
ok('no more than two suggestions come from one project',
  local.filter((s) => s.slug === 'solo').length <= 2);

const busy = suggest({
  jobs: [{ id: 'a', project_slug: 'solo', status: 'running', created_at: iso(1), prompt: 'x' }],
  projects: [{ name: 'solo' }],
});
ok('a running project is never suggested', !busy.some((s) => s.slug === 'solo'));
ok('a thin account is topped up with openers', only(busy, 'starter').length > 0);

const gone = suggest({
  jobs: [{ id: 'a', project_slug: 'ghost', status: 'error', created_at: iso(5), prompt: 'x' }],
  projects: [{ name: 'other' }],
});
ok('a project the host has lost is not suggested', !gone.some((s) => s.slug === 'ghost'));

const spread = suggest({
  jobs: ['one', 'two', 'three'].flatMap((slug, i) => [
    { id: `${slug}1`, project_slug: slug, status: 'done', created_at: iso(100 + i), prompt: 'make it' },
  ]),
  projects: ['one', 'two', 'three'].map((name) => ({ name, full_name: `me/${name}` })),
  limit: 3,
});
ok('the first screenful spans every project',
  new Set(spread.map((s) => s.slug)).size === 3, spread.map((s) => s.slug).join());
ok('suggestions are capped at the limit asked for', spread.length === 3);
ok('an account with nothing in it still suggests something',
  suggest({}).length > 0 && suggest({}).every((s) => s.kind === 'starter'));
ok('every suggestion ships a prompt, a title and a reason',
  [...failed, ...local, ...spread].every((s) => s.prompt && s.title && s.why && s.id));

// ── 18. markdown unit checks ──────────────────────────────────────────

const { md } = await import('../md.js');
has('headings render', md('# Title'), '<h1>Title</h1>');
has('links render', md('[docs](https://example.com)'), 'href="https://example.com"');
ok('javascript: urls are refused', !md('[x](javascript:alert(1))').includes('href'));
has('inline code is escaped', md('`<b>`'), '<code>&lt;b&gt;</code>');
ok('raw html is never emitted', !md('<img src=x onerror=alert(1)>').includes('<img'));
has('ordered lists render', md('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
has('quotes render', md('> hi'), '<blockquote>hi</blockquote>');
has('rules render', md('---'), '<hr>');
ok('empty input is empty', md('') === '' && md(null) === '');

// ── report ────────────────────────────────────────────────────────────

console.log(`\n  ${pass} checks passed`);
if (fails.length) {
  console.error(`  ${fails.length} failed:\n`);
  for (const f of fails) console.error(`   ✗ ${f}`);
  process.exit(1);
}
console.log('  all good\n');
process.exit(0);
