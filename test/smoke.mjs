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
  // suggestion and idea glyphs are named as data, so they dodge icon()
  ...[...jsSrc.matchAll(/icon: '([\w-]+)'/g)].map((m) => m[1]),
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

// Usage readings arrive on a timer, not only over realtime: `usage_windows`
// has to be in the Supabase publication for an event to reach us, and when
// this poll was dropped the meters silently froze on the first load.
const recurring = file('app.js').match(/setInterval\(([\s\S]{0,200}?), 10_000\)/)?.[1] ?? '';
ok('the recurring timer re-reads usage, not just the host',
  recurring.includes('pollUsage'), `timer body: ${recurring}`);

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

// A frozen meter and a quiet account look identical unless the page says
// which it is, so the block reports when it last read.
has('the limits block says when it last read', text('usage-foot'), 'last read');
has('nothing claims the numbers moved on a first read',
  text('usage-foot'), 'unchanged so far');

// The refresh re-reads on demand — the same path the 10-second timer takes.
fake.tables.usage_windows = [
  { window_type: 'five_hour', pct: 71, resets_at: iso(-60) },
  { window_type: 'seven_day', pct: 88, resets_at: iso(-4000) },
  { window_type: 'seven_day_opus', pct: 65, resets_at: null },
];
el('usage-refresh').click();
await tick();
has('a re-read updates the meter', el('usage-home').innerHTML, '71%');
has('and the headroom with it', el('usage-home').innerHTML, '29% left');
has('a changed reading is reported as changed', text('usage-foot'), 'changed');
ok('and no longer claims it is unchanged',
  !text('usage-foot').includes('unchanged'), text('usage-foot'));

// A read that fails keeps the last good numbers — an empty list and a
// broken query are not the same thing.
fake.failTable('usage_windows', 'permission denied for table usage_windows');
el('usage-refresh').click();
await tick();
has('a failed read says so', text('usage-foot'), 'couldn’t read the limits');
has('and names the reason', text('usage-foot'), 'permission denied');
has('the last good reading is still on screen', el('usage-home').innerHTML, '71%');
ok('it is not mistaken for an empty account', el('usage-empty').hidden);
fake.failTable('usage_windows', null);
el('usage-refresh').click();
await tick();
ok('recovering clears the error', !text('usage-foot').includes('couldn’t'));

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

// ── 10b. the ideas view ───────────────────────────────────────────────
// The long list: next steps for what exists, plus new builds derived from
// the themes your own projects actually show.

window.location.hash = '#/ideas';
await tick();

ok('the ideas view is shown', !el('ideas-view').hidden);
ok('every other view steps aside',
  el('home-view').hidden && el('chat-view').hidden && el('new-view').hidden);
ok('the composer is out of the way there', el('composer').hidden);
has('the topbar names it', text('view-title'), 'Ideas');

const cards = el('ideas-grid').querySelectorAll('.idea');
ok('a bunch of new project ideas render', cards.length >= 8, `got ${cards.length}`);
ok('every card says what it is', [...cards].every((c) => c.querySelector('.idea-blurb')?.textContent.trim()));
ok('every card says why it was offered', [...cards].every((c) => c.querySelector('.idea-why')?.textContent.trim()));
ok('every card is clickable with an id', [...cards].every((c) => c.dataset.suggest));
has('the intro says they came from your projects', text('ideas-intro'), 'derived from');

// The basis, spelled out: which themes were read and which projects said so.
ok('the profile card is shown', !el('ideas-profile').hidden);
has('the profile card names a theme it found', el('ideas-profile').textContent, 'games');
has('the profile card names the evidence', el('ideas-profile').textContent, 'alpha');
has('the profile card names the stack', el('ideas-profile').textContent, 'node');

// next steps come from the same engine the home block uses
ok('next steps are listed too', el('ideas-next').querySelectorAll('.suggest').length >= 2);
has('a failed project is among them', el('ideas-next').innerHTML, 'Fix what broke in beta');
ok('no opener pads out the derived list',
  !el('ideas-next').innerHTML.includes('data-kind="starter"'));

const chips = el('ideas-filters').querySelectorAll('.filter-chip');
ok('there is a chip per way of narrowing it', chips.length >= 4, `got ${chips.length}`);
ok('everything is the selected chip to begin with',
  chips[0].classList.contains('on') && chips[0].textContent.includes('Everything'));
ok('every chip carries its own count',
  [...chips].every((c) => /\d/.test(c.querySelector('.count')?.textContent ?? '')));
ok('the sidebar advertises how many there are',
  Number(text('ideas-count'))
    === cards.length + el('ideas-next').querySelectorAll('.suggest').length,
  `badge says ${text('ideas-count')}`);

// a theme chip narrows the grid to that theme and drops the next steps
const gameChip = [...chips].find((c) => c.dataset.ideaFilter === 'theme:game');
ok('a theme the account shows has its own chip', Boolean(gameChip));
gameChip.click();
await tick();
const narrowed = [...el('ideas-grid').querySelectorAll('.idea')];
ok('the grid narrows to that theme',
  narrowed.length > 0 && narrowed.every((c) => c.dataset.ideaTheme === 'game'),
  narrowed.map((c) => c.dataset.ideaTheme).join());
ok('the chip shows it is the active one',
  el('ideas-filters').querySelector('[data-idea-filter="theme:game"]').classList.contains('on'));
ok('next steps step aside under a theme filter', el('ideas-next-block').hidden);

[...el('ideas-filters').querySelectorAll('.filter-chip')]
  .find((c) => c.dataset.ideaFilter === 'next').click();
await tick();
ok('the carry-on filter hides the new builds', el('ideas-new-block').hidden);
ok('and keeps the next steps', !el('ideas-next-block').hidden);

[...el('ideas-filters').querySelectorAll('.filter-chip')]
  .find((c) => c.dataset.ideaFilter === 'all').click();
await tick();
ok('everything comes back', !el('ideas-new-block').hidden && !el('ideas-next-block').hidden);

// Leave a theme filter set on the way out: the account is wiped in §15, and
// a filter that outlives the theme it names must not blank the page.
[...el('ideas-filters').querySelectorAll('.filter-chip')]
  .find((c) => c.dataset.ideaFilter === 'theme:game').click();
await tick();

// A new build is a brief, so it opens the composer for a brand-new project.
el('prompt').value = '';
const firstCard = el('ideas-grid').querySelector('.idea');
const cardTitle = firstCard.querySelector('.idea-title').textContent.trim();
firstCard.click();
await tick();
ok('an idea opens the new-project composer', window.location.hash === '#/new',
  `got ${window.location.hash}`);
ok('an idea loads a real brief, not its title',
  el('prompt').value.length > 80 && el('prompt').value !== cardTitle,
  `${el('prompt').value.length} chars`);
ok('nothing was queued by clicking it', fake.inserts.at(-1)?.prompt !== el('prompt').value);
el('prompt').value = '';

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

// With nothing to read off, the ideas view says so and still offers openers.
window.location.hash = '#/ideas';
await tick();
ok('the ideas view works on a fresh account', !el('ideas-view').hidden);
ok('it drops the profile card with nothing to profile', el('ideas-profile').hidden);
has('and says there is nothing to read off yet', text('ideas-intro'), 'Nothing to read off');
ok('a filter that outlived its theme is dropped, not obeyed',
  el('ideas-filters').querySelector('[data-idea-filter="all"]')?.classList.contains('on'));
ok('it still offers somewhere to start',
  el('ideas-grid').querySelectorAll('.idea[data-kind="opener"]').length > 0);
ok('with no carry-on block at all', el('ideas-next-block').hidden);
window.location.hash = '#/';
await tick();

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

// ── 18. the idea engine ───────────────────────────────────────────────
// Everything it offers is supposed to be derived, so the checks are about
// derivation: nothing on a theme the account never shows, and the evidence
// it cites has to be a project that really said it.

const { ideas: ideaList, profile: readProfile } = await import('../ideas.js');

const gameAccount = {
  jobs: [
    { id: 'a', project_slug: 'snake', status: 'done', created_at: iso(300),
      prompt: 'build a snake game for the browser with a high-score list' },
    { id: 'b', project_slug: 'tetris', status: 'done', created_at: iso(200),
      prompt: 'a tetris clone, keyboard controls, pause' },
  ],
  projects: [
    { name: 'snake', full_name: 'me/snake', is_local: true },
    { name: 'tetris', full_name: 'me/tetris', is_local: true },
  ],
};

const read = readProfile(gameAccount);
ok('a theme is found from the words of the work', read.themes.has('game'));
ok('and it remembers which projects said so',
  (read.themes.get('game') ?? []).sort().join() === 'snake,tetris');
ok('a theme the account never mentions is not claimed', !read.themes.has('bot'));

const gameIdeas = ideaList(gameAccount);
ok('a themed account gets several new builds', gameIdeas.length >= 4, `got ${gameIdeas.length}`);
ok('every build is a new project, not a message to an old one',
  gameIdeas.every((i) => i.slug === null));
ok('every build ships a title, a blurb, a reason and a brief',
  gameIdeas.every((i) => i.id && i.title && i.blurb && i.why && i.prompt));
ok('a brief is long enough to send', gameIdeas.every((i) => i.prompt.length > 80));
ok('no build is offered twice',
  new Set(gameIdeas.map((i) => i.id)).size === gameIdeas.length);
has('the reason names the projects it was read off', gameIdeas[0].why, 'snake');
ok('the themed ideas lead the list', gameIdeas[0].theme === 'game');
ok('openers do not pad out a list that has real ideas',
  !gameIdeas.some((i) => i.kind === 'opener'), gameIdeas.map((i) => i.kind).join());

// a combo needs both halves to be things you have actually built
ok('a combo is not offered on one theme alone',
  !gameIdeas.some((i) => i.id === 'idea:combo:leaderboard-dash'));
const twoThemes = ideaList({
  jobs: [
    { id: 'a', project_slug: 'snake', status: 'done', prompt: 'a snake game in the browser' },
    { id: 'b', project_slug: 'pulse', status: 'done', prompt: 'a dashboard with charts of my commits' },
  ],
  projects: [{ name: 'snake' }, { name: 'pulse' }],
});
const combo = twoThemes.find((i) => i.id === 'idea:combo:leaderboard-dash');
ok('a combo appears once both halves are there', Boolean(combo),
  twoThemes.map((i) => i.kind).join());
has('a combo cites both projects', combo?.why ?? '', 'snake');

// the shape of the account is a signal of its own
const localShape = ideaList({
  jobs: [
    { id: 'a', project_slug: 'one', status: 'done', prompt: 'a cli that renames files' },
    { id: 'b', project_slug: 'two', status: 'done', prompt: 'a cli that resizes images' },
  ],
  projects: [
    { name: 'one', full_name: null, is_local: true },
    { name: 'two', full_name: null, is_local: true },
  ],
});
ok('two local-only projects suggest getting them pushed',
  localShape.some((i) => i.id === 'idea:shape:push-everything'),
  localShape.map((i) => i.id).join());
has('and it says how many there are',
  localShape.find((i) => i.id === 'idea:shape:push-everything').why, '2 projects');

// a brief lands in tools you have already used
has('a brief names the stack it found',
  ideaList({
    jobs: [{ id: 'a', project_slug: 'api', status: 'done',
      prompt: 'a python fastapi service backed by sqlite' }],
    projects: [{ name: 'api' }],
  })[0].prompt,
  'python');

// nothing to go on
const blank = ideaList({});
ok('an empty account still has somewhere to start', blank.length > 0);
ok('and is honest that those are openers', blank.every((i) => i.kind === 'opener'));
ok('an opener still ships a real brief', blank.every((i) => i.prompt.length > 80));

// breadth before depth: the first screenful spans the themes
const broad = ideaList({
  jobs: [
    { id: 'a', project_slug: 'g', status: 'done', prompt: 'a browser game' },
    { id: 'b', project_slug: 'c', status: 'done', prompt: 'a cli with flags and stdout' },
    { id: 'd', project_slug: 's', status: 'done', prompt: 'a rest api with endpoints' },
  ],
  projects: [{ name: 'g' }, { name: 'c' }, { name: 's' }],
  limit: 3,
});
ok('the first three ideas come from three different themes',
  new Set(broad.map((i) => i.theme)).size === 3, broad.map((i) => i.theme).join());
ok('a limit is a limit', broad.length === 3);

// ── 19. markdown unit checks ──────────────────────────────────────────

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
