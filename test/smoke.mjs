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
has('and when it last checked in, as a phrase rather than "now ago"',
  el('desktop-card').textContent, 'just now');

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
ok('the projects door counts every project', text('projects-count') === '4',
  `got ${text('projects-count')}`);
ok('no door is marked current on home',
  !el('projects-link').hasAttribute('aria-current') && !el('ideas-link').hasAttribute('aria-current'));
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
ok('the chat head links to the live site',
  el('chat-head').querySelector('a[href="https://alpha.fly.dev/"]')?.target === '_blank');
ok('the reply that deployed it links there too',
  Boolean(el('thread').querySelector('#job-j2 a[href="https://alpha.fly.dev/"]')));
ok('a reply that deployed nothing has no site link',
  !el('thread').querySelector('#job-j1 a[href*="fly.dev"]'));
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
has('and says what it is queued behind, since alpha is already busy',
  el('toasts').textContent, 'behind the agent already on alpha');
has('the thread says it too, rather than just "queued"',
  el('thread').textContent, 'waiting for alpha to finish');

// ── 8. stopping a job ─────────────────────────────────────────────────

el('thread').querySelector('[data-cancel="j1"]').click();
await tick();
ok('stop requests cancellation',
  fake.updates.some((u) => u.patch?.cancel_requested === true && u.where[1] === 'j1'));

// ── 9. a job finishing while you watch ────────────────────────────────

// The host deploys and re-syncs before it marks a job done, so a finish is
// when the project list is worth reading again.
fake.tables.projects[0].live_url = 'https://alpha-v2.fly.dev/';
fake.emit('jobs', 'UPDATE', { ...fake.tables.jobs[0], status: 'done', num_turns: 9 });
await tick();
has('a finish toast names the project', el('toasts').textContent, 'alpha');
ok('the thread re-renders without a live log', !el('thread').querySelector('[data-log="j1"]'));
has('a finish re-reads the project list, live link and all',
  el('chat-head').innerHTML, 'https://alpha-v2.fly.dev/');

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

// ── 10c. the projects view ────────────────────────────────────────────
// Everything you have, what each one is, and where it is live. The host
// writes the catalogue; this screen adds the runs and anything in flight.

window.location.hash = '#/projects';
await tick();

ok('the projects view is shown', !el('projects-view').hidden);
ok('every other view steps aside there',
  el('home-view').hidden && el('chat-view').hidden && el('new-view').hidden && el('ideas-view').hidden);
ok('the composer is out of the way', el('composer').hidden);
has('the topbar names it', text('view-title'), 'Projects');
has('the topbar says how many are live', text('view-sub'), '2 live');
ok('its sidebar door is marked current', el('projects-link').getAttribute('aria-current') === 'page');
ok('and the ideas door is not', !el('ideas-link').hasAttribute('aria-current'));

const projCards = () => [...el('projects-grid').querySelectorAll('.proj')];
const shownNames = () => projCards().map((c) => c.dataset.project);
const projCard = (name) => el('projects-grid').querySelector(`[data-project="${name}"]`);

// delta is being built right now: it has a chat before the host lists it.
ok('every listed project has a card, plus the one being built',
  shownNames().length === 5 && shownNames().includes('delta'), shownNames().join());
ok('the sidebar door counts it too', text('projects-count') === '5', text('projects-count'));
has('the intro counts them', text('projects-intro'), '5 projects');
has('and says how many are live', text('projects-intro'), '2 live on the web');

has('a card says what the project is', projCard('alpha').textContent, 'A snake game');
has('a card names its language', projCard('alpha').textContent, 'JavaScript');
has('a card counts the runs it has had', projCard('alpha').textContent, '3 runs');
has('a card counts stars when there are some', projCard('untouched-repo').textContent, '3 stars');

const liveA = projCard('alpha').querySelector('a.proj-live');
ok('a live project links to its site', liveA?.getAttribute('href') === 'https://alpha-v2.fly.dev/',
  liveA?.getAttribute('href'));
ok('in a new tab, without handing it the opener',
  liveA?.target === '_blank' && liveA?.rel.includes('noopener'));
has('the link reads as an address, not a URL', liveA?.textContent ?? '', 'alpha-v2.fly.dev');
ok('the link does not print its scheme', !(liveA?.textContent ?? '').includes('https://'));
has('a Pages site keeps its path', projCard('untouched-repo').textContent, 'me.github.io/untouched-repo');
has('a project that is not online says so', projCard('gamma').textContent, 'Not online');
has('a project with no description says so', projCard('gamma').textContent, 'No description yet');
ok('a description is escaped, never parsed',
  projCard('beta').innerHTML.includes('&lt;my&gt;') && !projCard('beta').querySelector('my'));

has('a desktop-only project is labelled', projCard('gamma').textContent, 'local only');
ok('and is not called public or private',
  !/public|private/.test(projCard('gamma').querySelector('.proj-tags')?.textContent ?? ''));
has('a repo not on the desktop is labelled', projCard('beta').textContent, 'not cloned');
has('a private repo is labelled', projCard('alpha').textContent, 'private');
ok('a repo link is offered for a project on GitHub',
  Boolean(projCard('beta').querySelector('a[href="https://github.com/me/beta"]')));
ok('and not for one that is not on GitHub',
  !projCard('gamma').querySelector('a[href^="https://github.com/"]'));
ok('every card opens its chat',
  projCards().every((c) => c.querySelector('.proj-name').getAttribute('href')
    === `#/p/${encodeURIComponent(c.dataset.project)}`));
has('a project being worked on says so', projCard('delta').innerHTML, 'data-status="running"');
has('a paused one says that instead', projCard('gamma').innerHTML, 'data-status="paused"');

const projChips = () => [...el('projects-filters').querySelectorAll('.filter-chip')];
const projChip = (key) => projChips().find((c) => c.dataset.projectFilter === key);
ok('there is an all chip, a live chip, and one per language, most used first',
  projChips().map((c) => c.dataset.projectFilter).join() === 'all,live,lang:TypeScript,lang:JavaScript',
  projChips().map((c) => c.dataset.projectFilter).join());
ok('all is the selected chip to begin with', projChip('all').classList.contains('on'));
ok('every chip carries its own count',
  projChips().every((c) => /\d/.test(c.querySelector('.count')?.textContent ?? '')));

projChip('live').click();
await tick();
ok('the live chip keeps only what is live',
  shownNames().sort().join() === 'alpha,untouched-repo', shownNames().join());
ok('and shows that it is the active one', projChip('live').classList.contains('on'));

projChip('lang:TypeScript').click();
await tick();
ok('a language chip keeps only that language',
  shownNames().sort().join() === 'beta,untouched-repo', shownNames().join());

projChip('all').click();
await tick();
ok('all brings everything back', shownNames().length === 5);

const searchProjects = async (q) => {
  el('projects-search').value = q;
  el('projects-search').dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick();
};
await searchProjects('snake');
ok('search reads the descriptions', shownNames().join() === 'alpha', shownNames().join());
await searchProjects('forecast');
ok('and the topics', shownNames().join() === 'beta', shownNames().join());
await searchProjects('nothing-like-this');
ok('a search with no match says so', !el('projects-none').hidden && shownNames().length === 0);
await searchProjects('');
ok('clearing it hides that note again', el('projects-none').hidden);

const sortProjects = async (value) => {
  const radio = el('projects-sort').querySelector(`input[value="${value}"]`);
  radio.checked = true;
  radio.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick();
};
await sortProjects('name');
ok('A–Z sorts by name', shownNames().join() === 'alpha,beta,delta,gamma,untouched-repo',
  shownNames().join());
await sortProjects('recent');
ok('recent puts the work in flight first',
  shownNames().slice(0, 3).sort().join() === 'alpha,delta,gamma', shownNames().join());
ok('then whatever moved last', shownNames().slice(3).join() === 'beta,untouched-repo',
  shownNames().join());

// Leave a language filter on: §15 empties the account, and a filter that
// outlives its language must not blank the page when projects come back.
projChip('lang:JavaScript').click();
await tick();

// ── 10d. the agents view ──────────────────────────────────────────────
// Several agents at once is the whole point of this screen, so the checks
// are about the arithmetic it prints: who holds a slot, how many are left,
// and what each queued job is actually waiting for.

const store = await import('../store.js');

window.location.hash = '#/agents';
await tick();

ok('the agents view is shown', !el('agents-view').hidden);
ok('every other view steps aside there',
  el('home-view').hidden && el('chat-view').hidden && el('new-view').hidden
  && el('ideas-view').hidden && el('projects-view').hidden);
ok('the composer is out of the way', el('composer').hidden);
ok('the bottom tabs stay put where there is no composer', !el('tabbar').hidden);
has('the topbar names it', text('view-title'), 'Agents');
has('the topbar counts the running agents against the ceiling',
  text('view-sub'), '1 of 3 running');
ok('its sidebar door is marked current', el('agents-link').getAttribute('aria-current') === 'page');
ok('and its tab is too', el('tab-agents').getAttribute('aria-current') === 'page');

// delta is running, gamma is paused and holding its slot, alpha is queued.
ok('the hero counts what is running', text('fleet-value') === '1', text('fleet-value'));
ok('an agent in flight gets a card each',
  el('fleet-list').querySelectorAll('.agent').length === 2,
  String(el('fleet-list').querySelectorAll('.agent').length));
ok('the empty note stays out of the way', el('fleet-empty').hidden);
has('a card names the project', el('fleet-list').textContent, 'delta');
has('a paused agent says it keeps its slot', el('fleet-list').textContent, 'keeps its slot');
ok('every card can be stopped',
  el('fleet-list').querySelectorAll('[data-cancel]').length === 2);
ok('and every card opens its thread',
  [...el('fleet-list').querySelectorAll('.agent-name')]
    .every((a) => /#\/(p|j)\//.test(a.getAttribute('href'))));

ok('there is a pip per slot', el('fleet-pips').querySelectorAll('.pip').length === 3,
  String(el('fleet-pips').querySelectorAll('.pip').length));
ok('two of them are taken', el('fleet-pips').querySelectorAll('.pip.on').length === 2);
has('the pips say the same thing in words',
  el('fleet-pips').getAttribute('aria-label'), '2 of 3 slots busy');
has('the block heading counts the busy slots', text('slots-note'), '2 of 3 busy');
has('the hint says what the number does', text('slots-hint'), 'up to 3 agents at once');
has('and admits nothing has been published yet', text('slots-hint'), 'Not published yet');
has('and how much room is left', text('slots-hint'), '1 slot free');

ok('the queued job is waiting', el('waiting-list').querySelectorAll('.row').length === 1);
has('and says it is next, since a slot is free', el('waiting-list').textContent, 'next up');
has('the doors carry the number in flight', text('agents-count'), '3');
ok('including the tab badge', text('tab-agents-count') === '3' && !el('tab-agents-count').hidden);
ok('finished runs are listed under them',
  el('fleet-done').querySelectorAll('.row').length === 3);

// A second agent starts while you watch — the case this screen exists for.
const extra = {
  id: 'par-1', project_slug: 'epsilon', prompt: 'write the docs site', status: 'running',
  created_at: iso(3), claimed_at: iso(2), effort: 'high', usage_cap_pct: 90,
};
fake.tables.jobs.push(extra);
fake.emit('jobs', 'INSERT', extra);
await tick();
ok('a second agent joins the first', text('fleet-value') === '2', text('fleet-value'));
ok('and gets a card of its own', el('fleet-list').querySelectorAll('.agent').length === 3);
ok('every slot is taken now', el('fleet-pips').querySelectorAll('.pip.on').length === 3);
has('so the queue is waiting on a slot, not on the desktop',
  el('waiting-list').textContent, 'waiting for a free slot');
has('the hero says the fleet is full', el('fleet-chips').textContent, '3 of 3 slots busy');

// A log line from any live agent reaches this screen, not just a thread.
fake.emit('job_events', 'INSERT', { id: 20, job_id: 'par-1', kind: 'tool', text: 'Write docs/index.md' });
await tick();
has('a live log line lands on the card', el('fleet-list').textContent, 'Write docs/index.md');

// The ceiling is a row in Supabase, so it follows you between devices.
fake.tables.settings = [{ owner: 'u1', max_parallel: 5 }];
await store.pollSettings();
await tick();
ok('a ceiling set elsewhere is picked up',
  el('slots').querySelector('input[value="5"]').checked);
has('and the hint counts against it', text('slots-hint'), 'up to 5 agents at once');

// Changing it publishes it where the runner looks.
const setSlots = async (n) => {
  const r = el('slots').querySelector(`input[value="${n}"]`);
  r.checked = true;
  r.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick();
};
await setSlots(2);
const wrote = fake.upserts.at(-1);
ok('the ceiling is written to the settings table', wrote?.table === 'settings');
ok('with the number you picked', wrote?.row.max_parallel === 2, JSON.stringify(wrote?.row));
ok('one row per account, keyed on the owner',
  wrote?.onConflict === 'owner' && wrote?.row.owner === 'u1');
has('three in flight against a ceiling of two is reported, not hidden',
  el('fleet-chips').textContent, 'over the ceiling');

// Without the migration the number is only local, and the screen says so.
fake.failTable('settings', 'relation "public.settings" does not exist');
await store.pollSettings();
await tick();
has('a missing settings table is explained, not swallowed',
  text('slots-hint'), 'Saved on this device only');
fake.failTable('settings', null);
await store.pollSettings();
await tick();
ok('and the claim comes back when it can be published',
  !text('slots-hint').includes('this device only'));

// One agent per project: a job for a project that is already busy says so.
const queuedGamma = {
  id: 'q-gamma', project_slug: 'gamma', prompt: 'add tests to the CLI',
  status: 'queued', created_at: iso(1),
};
fake.tables.jobs.push(queuedGamma);
fake.emit('jobs', 'INSERT', queuedGamma);
await tick();
ok('both queued jobs are listed', el('waiting-list').querySelectorAll('.row').length === 2);
has('and one is waiting for its own project, not for a slot',
  el('waiting-list').textContent, 'waiting for gamma to finish');

// Stopping the lot, once there is a lot to stop.
ok('stop all is offered', !el('stop-all').hidden);
const before = fake.updates.filter((u) => u.patch?.cancel_requested).length;
el('stop-all').click();
await tick();
if (el('confirm').open) el('confirm-yes').click();
await tick();
const stopped = fake.updates.filter((u) => u.patch?.cancel_requested).length - before;
ok('stop all asks every open agent to stop', stopped === 5, `stopped ${stopped}`);

// Put the fixtures back the way the later sections expect them.
for (const id of ['par-1', 'q-gamma']) {
  fake.tables.jobs = fake.tables.jobs.filter((j) => j.id !== id);
  fake.emit('jobs', 'DELETE', null, { id });
}
await tick();

// The short form of the same answer, where a row has no space for a clause.
window.location.hash = '#/';
await tick();
has('a queued row on home says what it is waiting for',
  el('active-list').textContent, 'for a slot');
window.location.hash = '#/agents';
await tick();

// ── 10e. your own assistant ───────────────────────────────────────────
// The other half of the merge: the same relay, carrying a conversation
// instead of a build. What matters here is that a reply never lies about
// where it is — "typing…" over a PC that is off is the bug this walk exists
// to catch.

window.location.hash = '#/ask';
await tick();

ok('the assistant view is shown', !el('ask-view').hidden);
ok('every other view steps aside there',
  el('home-view').hidden && el('chat-view').hidden && el('new-view').hidden
  && el('ideas-view').hidden && el('projects-view').hidden && el('agents-view').hidden);
ok('the composer comes with it', !el('composer').hidden);
ok('and takes the bottom of the window from the tabs', el('tabbar').hidden);
ok('job settings are out of the way — a conversation has none',
  el('opts-toggle').hidden && el('opts').hidden);
ok('the chip says who answers instead', !el('ask-who').hidden);
has('and names it', text('ask-who-text'), 'jarvis');
has('the topbar names your assistant, not the app', text('view-title'), 'jarvis');
has('and says it is reachable', text('view-sub'), 'online');
has('the topbar counts the conversations', text('view-sub'), '2 conversations');
ok('its sidebar door is marked current', el('ask-link').getAttribute('aria-current') === 'page');
ok('and its tab is too', el('tab-ask').getAttribute('aria-current') === 'page');
has('the presence pill says it in a word', text('ask-presence-text'), 'online');
ok('and wears the online class', el('ask-presence').classList.contains('online'));
ok('nothing is asking you to set anything up', el('ask-setup').hidden);

// #/ask with no id opens the newest conversation, the way a chat app does.
has('the newest conversation is open', text('ask-title'), 'what should I build next?');
ok('its turns are drawn', el('ask-thread').querySelectorAll('.turn').length === 1);
has('your message is there', el('ask-thread').textContent, 'what should I build next?');
has('the reply renders as Markdown', el('ask-thread').innerHTML, '<strong>snake</strong>');
has('including its heading', el('ask-thread').innerHTML, '<h2>Two ideas</h2>');
has('the reply is signed by the assistant', el('ask-thread').textContent, 'jarvis');
ok('a finished reply can be copied', Boolean(el('ask-thread').querySelector('[data-ask-copy]')));
ok('and asked again', Boolean(el('ask-thread').querySelector('[data-ask-again]')));
ok('and handed to an agent', Boolean(el('ask-thread').querySelector('[data-ask-build]')));
ok('a finished reply has no stop button', !el('ask-thread').querySelector('[data-ask-stop]'));
ok('the opener is out of the way once there are messages', el('ask-open').hidden);

ok('the other conversation is one tap away', !el('ask-history').hidden);
has('listed by name', el('ask-history-list').textContent, 'Fixing the printer');
ok('the open one is not listed twice',
  el('ask-history-list').querySelectorAll('.row').length === 1);
ok('and it links to itself', el('ask-history-list').querySelector('.row')
  .getAttribute('href') === '#/ask/c2');

// ── sending one ───────────────────────────────────────────────────────

const insertsBefore = fake.inserts.length;
el('prompt').value = 'how do I get this onto my phone?';
el('composer').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
await tick();

const written = fake.inserts.slice(insertsBefore);
ok('a message and the reply it is owed are written together', written.length === 2,
  `wrote ${written.length}`);
ok('yours is stored as said', written[0].role === 'user' && written[0].status === 'done');
has('with the text you typed', written[0].text, 'onto my phone');
ok('the reply row is queued and empty',
  written[1].role === 'assistant' && written[1].status === 'queued' && written[1].text === '');
ok('both are owned by you', written.every((r) => r.owner === 'u1'));
ok('both land in the open conversation', written.every((r) => r.chat_id === 'c1'));
ok('the composer is emptied', el('prompt').value === '');

ok('the thread shows the new turn', el('ask-thread').querySelectorAll('.turn').length === 2);
const pending = el('ask-thread').querySelectorAll('.turn')[1];
has('the reply says it is about to start', pending.textContent, 'about to start');
ok('a pending reply is drawn as work in progress',
  pending.querySelector('.msg.agent').dataset.status === 'running'
  || pending.querySelector('.msg.agent').dataset.status === 'queued');
ok('a pending reply can be stopped', Boolean(pending.querySelector('[data-ask-stop]')));
ok('a reply on the way is counted on the Ask door', text('ask-count') === '1', text('ask-count'));
ok('and on its tab', text('tab-ask-count') === '1' && !el('tab-ask-count').hidden);

const replyId = written[1].id;

// ── the answer streaming in ───────────────────────────────────────────

const streamed = { ...written[1], status: 'streaming', text: 'Add it to your home' };
fake.tables.chat_messages = fake.tables.chat_messages
  .map((m) => (m.id === replyId ? streamed : m));
fake.emit('chat_messages', 'UPDATE', streamed);
await tick();

has('the words arrive as they are written', el('ask-thread').textContent, 'Add it to your home');
has('and the reply says it is typing', el('ask-thread').textContent, 'typing');

const finished = {
  ...streamed,
  status: 'done',
  text: 'Add it to your home screen, then sign in **inside that app**.',
};
fake.tables.chat_messages = fake.tables.chat_messages
  .map((m) => (m.id === replyId ? finished : m));
fake.emit('chat_messages', 'UPDATE', finished);
await tick();

has('the finished answer renders', el('ask-thread').innerHTML, '<strong>inside that app</strong>');
ok('nothing is on the way any more', el('tab-ask-count').hidden);
ok('a finished reply stops saying typing', !el('ask-thread').textContent.includes('typing'));
ok('a reply you are watching arrive needs no toast as well',
  !el('toasts').textContent.includes('jarvis answered'));

// One that lands while you are on another screen is the whole point of
// relaying through your PC, so that one does say so.
window.location.hash = '#/';
await tick();
const away = {
  id: 95, chat_id: 'c1', owner: 'u1', role: 'assistant', status: 'queued',
  text: '', created_at: iso(0),
};
fake.tables.chat_messages.push(away);
fake.emit('chat_messages', 'INSERT', away);
await tick();
const landed = { ...away, status: 'done', text: 'answered while you were away' };
fake.tables.chat_messages = fake.tables.chat_messages.map((m) => (m.id === 95 ? landed : m));
fake.emit('chat_messages', 'UPDATE', landed);
await tick();
has('a reply landing while you are elsewhere is announced',
  el('toasts').textContent, 'jarvis answered');

window.location.hash = '#/ask';
await tick();

// ── handing an answer to an agent ─────────────────────────────────────

el('ask-thread').querySelector(`[data-ask-build="${replyId}"]`).click();
await tick();
ok('handing an answer over opens the new-project composer',
  window.location.hash === '#/new', window.location.hash);
has('with the answer already in the box', el('prompt').value, 'inside that app');
el('prompt').value = '';

// ── a PC that is switched off ─────────────────────────────────────────
// The case the whole screen is built around: the message is kept, and it
// says so, rather than pretending something is typing.

const askStore = await import('../store.js');
fake.tables.assistants = [
  { owner: 'u1', name: 'jarvis', model: 'llama3', last_seen: iso(40) },
];
const sleeping = {
  id: 90, chat_id: 'c1', owner: 'u1', role: 'assistant', status: 'queued',
  text: '', created_at: iso(0),
};
fake.tables.chat_messages.push(sleeping);
fake.emit('chat_messages', 'INSERT', sleeping);
await askStore.pollAssistant();
window.location.hash = '#/ask';
await tick();

has('an offline assistant says when it was last heard', text('ask-presence-text'), 'last seen');
ok('and the pill stops claiming to be online',
  el('ask-presence').classList.contains('offline'));
has('a queued reply waits for the PC, it does not pretend to type',
  el('ask-thread').textContent, 'waiting for your PC');
has('and says what that means for you', el('ask-thread').textContent,
  'answered as soon as it is on again');
ok('nothing claims to be typing', !el('ask-thread').textContent.includes('typing…'));

// Two queued at once, and the second one says what it is behind.
const behind = {
  id: 91, chat_id: 'c2', owner: 'u1', role: 'assistant', status: 'queued',
  text: '', created_at: iso(-1),
};
fake.tables.chat_messages.push(behind);
fake.emit('chat_messages', 'INSERT', behind);
fake.tables.assistants = [
  { owner: 'u1', name: 'jarvis', model: 'llama3', last_seen: new Date().toISOString() },
];
await askStore.pollAssistant();
window.location.hash = '#/ask/c2';
await tick();
has('a reply behind another says how many are in front',
  el('ask-thread').textContent, '1 ahead');

// ── an answer that failed ─────────────────────────────────────────────

const broke = {
  ...behind, status: 'error', text: '', error: 'ollama exited 1 — model not found',
};
fake.tables.chat_messages = fake.tables.chat_messages.map((m) => (m.id === 91 ? broke : m));
fake.emit('chat_messages', 'UPDATE', broke);
await tick();
has('a failure says what the PC said', el('ask-thread').textContent, 'model not found');
ok('a failed reply is drawn in the failure tone',
  Boolean(el('ask-thread').querySelector('.msg.agent[data-status="error"]')));
has('and it can be asked again', el('ask-thread').innerHTML, 'data-ask-again');

// ── a bridge that has never checked in ────────────────────────────────

fake.tables.assistants = [];
await askStore.pollAssistant();
await tick();
ok('with no bridge the screen says what to run', !el('ask-setup').hidden);
has('naming the command', el('ask-setup').textContent, 'node bridge/bridge.mjs');
has('and the two ways to point it at your assistant',
  el('ask-setup').textContent, 'ASSISTANT_CMD');
has('the pill says there is nothing there yet', text('ask-presence-text'), 'no assistant yet');

// ── a schema that predates the feature ────────────────────────────────

fake.failTable('chats', 'relation "public.chats" does not exist');
await askStore.loadAsk();
await tick();
has('a missing table asks you to run the migration', el('ask-setup').textContent, 'schema.sql');
has('and prints what the read actually said',
  el('ask-setup').textContent, 'does not exist');
ok('the app is still standing', !el('ask-view').hidden);

fake.failTable('chats', null);
fake.tables.assistants = [
  { owner: 'u1', name: 'jarvis', model: 'llama3', last_seen: new Date().toISOString() },
];
await askStore.loadAsk();
await tick();
ok('and recovers when the table turns up', el('ask-setup').hidden);

// ── an opener, when there is nothing said yet ─────────────────────────

const fresh = fake.inserts.length;
el('ask-new').click();
await tick();
ok('a new conversation is written', fake.inserts.length === fresh + 1);
ok('and opened', window.location.hash.startsWith('#/ask/'), window.location.hash);
ok('an empty conversation offers openers', !el('ask-open').hidden);
ok('four of them', el('ask-starters').querySelectorAll('.suggest').length === 4);
el('ask-starters').querySelector('.suggest').click();
await tick();
ok('tapping one fills the box rather than sending it',
  el('prompt').value.length > 10 && fake.inserts.length === fresh + 1);
el('prompt').value = '';

// ── home knows about it too ───────────────────────────────────────────

window.location.hash = '#/';
await tick();
has('home names the assistant', el('ask-card').textContent, 'jarvis');
has('and says it is online', el('ask-card').textContent, 'online');
has('and counts the conversations', el('ask-card').textContent, 'thread');
has('and explains what happens if the PC sleeps',
  el('ask-card').textContent, 'Replies come straight back here');
has('and when it was last heard from', el('ask-card').textContent, 'just now');
ok('home offers a way straight in', el('ask-quick').querySelectorAll('a, button').length >= 2);
ok('the card is a door', el('ask-card').getAttribute('href') === '#/ask');

// ── deleting one ──────────────────────────────────────────────────────

window.location.hash = '#/ask/c2';
await tick();
el('ask-clear').click();
await tick();
if (el('confirm').open) el('confirm-yes').click();
await tick();
ok('deleting a conversation deletes the row',
  fake.deletes.some((d) => d.table === 'chats' && d.where[1] === 'c2'));
has('and its messages go with it in the view',
  String(el('ask-history-list').textContent), '');
ok('and you land back on the assistant', window.location.hash === '#/ask');

// Put the fixtures back for the sections after this one.
fake.tables.chat_messages = fake.tables.chat_messages
  .filter((m) => ![90, 91, 95].includes(m.id) && m.chat_id !== 'c2');
await askStore.loadAsk();
window.location.hash = '#/agents';
await tick();

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
key('p');
await tick();
ok('"p" opens the projects', window.location.hash === '#/projects');
window.location.hash = '#/';
await tick();

// ── 13b. the same screens on a phone ──────────────────────────────────
// Three things are decided in JS rather than CSS, because they are about
// how much there is rather than how wide it is: home's reference blocks,
// which limit leads, and how much log a card shows.

screen.width = 390;
window.location.hash = '#/';
await tick();
window.dispatchEvent(new window.Event('resize'));
await tick();

ok('the bottom tabs are there', !el('tabbar').hidden);
ok('home is on its own tab', el('tab-home').getAttribute('aria-current') === 'page');
ok('the reference blocks are folded away', el('home-more').hidden);
ok('and the toggle that opens them is offered', !el('home-more-toggle').hidden);
has('which says what it would do', text('home-more-label'), 'More detail');
el('home-more-toggle').click();
await tick();
ok('tapping it unfolds them', !el('home-more').hidden);
has('and the label flips', text('home-more-label'), 'Less detail');
ok('the strip is in there, not dropped', !el('activity-block').hidden);

// The limits block leads with the window that will actually stop you.
const phoneMeters = [...el('usage-home').querySelectorAll('.meter')];
has('the tightest window leads on a phone',
  el('usage-home').querySelector('.meter-name').textContent, 'all models');
const fold = el('usage-home').querySelector('details.fold');
ok('the rest fold behind their own count', Boolean(fold));
has('and the fold says how many', fold?.textContent ?? '', '2 more windows');
ok('nothing is dropped, only folded', phoneMeters.length === 3, String(phoneMeters.length));

// The composer and the tabs never fight over the bottom of the window.
window.location.hash = '#/p/alpha';
await tick();
ok('a thread gets the composer', !el('composer').hidden);
ok('and the tabs step aside for it', el('tabbar').hidden);

window.location.hash = '#/agents';
await tick();
ok('the fleet gets the tabs back', !el('tabbar').hidden && el('composer').hidden);

// A card carries the tail of its own log, and a phone gets less of it.
for (const n of [1, 2, 3]) {
  fake.emit('job_events', 'INSERT',
    { id: 30 + n, job_id: made.id, kind: 'tool', text: `Edit file${n}.js` });
}
await tick();
const tail = () => el('fleet-list').querySelector('.agent-tail');
ok('a card carries the tail of its log', Boolean(tail()));
ok('two lines of it on a phone', tail()?.children.length === 2,
  String(tail()?.children.length));
has('the newest line is one of them', tail()?.textContent ?? '', 'Edit file3.js');

screen.width = 1200;
window.dispatchEvent(new window.Event('resize'));
await tick();
ok('three on a screen with room for them', tail()?.children.length === 3,
  String(tail()?.children.length));

window.location.hash = '#/';
await tick();
ok('a wide window shows the reference blocks again', !el('home-more').hidden);
ok('and keeps the tabs out of it', el('home-more-toggle').hidden);

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

// A run that died because the desktop's Claude login expired says so, and
// says what to do on the PC — the project itself is not what broke.
const AUTH = 'Failed to authenticate: OAuth session expired and could not be refreshed';
window.location.hash = '#/';
fake.emit('jobs', 'UPDATE', { ...row('j4'), status: 'running' });
await tick();
fake.emit('jobs', 'UPDATE', { ...row('j4'), status: 'error', error: AUTH,
  created_at: new Date().toISOString() });
await tick();
has('home flags a signed-out desktop', el('hero-chips').textContent, 'desktop signed out');
has('the toast says where to fix it', el('toasts').textContent, '/login');

window.location.hash = '#/p/gamma';
await tick();
const authNote = el('thread').querySelector('[data-signed-out]');
ok('the chat explains a sign-in failure', Boolean(authNote));
has('and names the fix', authNote?.textContent ?? '', '/login');
has('the raw error is still shown', el('thread').textContent, 'could not be refreshed');

fake.emit('jobs', 'UPDATE', { ...row('j4'), status: 'done', error: null,
  created_at: new Date().toISOString() });
window.location.hash = '#/';
await tick();
ok('a later finished run clears the flag',
  !el('hero-chips').textContent.includes('desktop signed out'));

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

window.location.hash = '#/agents';
await tick();
ok('the fleet screen survives an empty account', !el('agents-view').hidden);
ok('with nothing running', text('fleet-value') === '0');
ok('it says so rather than showing an empty list', !el('fleet-empty').hidden);
ok('there is no queue', el('waiting-block').hidden);
ok('nothing to stop', el('stop-all').hidden);
ok('and the tab badge goes away', el('tab-agents-count').hidden);
ok('but the slots are still there to set', el('slots').querySelectorAll('input').length === 6);

window.location.hash = '#/projects';
await tick();
ok('the projects view has an empty state of its own', !el('projects-empty').hidden);
ok('with no search or sort for nothing', el('projects-tools').hidden);
ok('and no filter chips', el('projects-filters').children.length === 0);
ok('and no "nothing matches" note — nothing was searched', el('projects-none').hidden);
ok('the sidebar door drops its count', text('projects-count') === '');

// Projects come back: the language filter left on in §10c names a language
// none of them use, so it is dropped rather than obeyed.
fake.tables.projects = [{ name: 'solo', full_name: 'me/solo', language: 'Go', pushed_at: iso(5) }];
window.document.dispatchEvent(new window.Event('visibilitychange'));
await tick();
ok('a filter that outlived its language is dropped, not obeyed',
  el('projects-filters').querySelector('[data-project-filter="all"]')?.classList.contains('on')
  && el('projects-grid').querySelectorAll('.proj').length === 1);
fake.tables.projects = [];
window.document.dispatchEvent(new window.Event('visibilitychange'));
await tick();

window.location.hash = '#/';
await tick();

// ── 16. time helpers ──────────────────────────────────────────────────
// The reset label is the one piece of formatting a wrong answer makes
// actively misleading, so it gets fixed dates rather than fixtures.

const { dayClock, until, dayDelta, span, weekday, since } = await import('../util.js');
ok('a check-in seconds ago reads as a phrase', since(iso(0)) === 'just now');
ok('an older one keeps the measurement', since(iso(240)) === '4h ago');
ok('and nothing is nothing', since(null) === '');
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

const signedOutRun = suggest({
  jobs: [{ id: 'a', project_slug: 'solo', status: 'error', created_at: iso(5),
    prompt: 'build a thing',
    error: 'Failed to authenticate: OAuth session expired and could not be refreshed' }],
  projects: [{ name: 'solo', full_name: 'me/solo' }],
});
ok('a desktop sign-in failure is not offered as something to fix',
  !kinds(signedOutRun).includes('fix'), kinds(signedOutRun).join());

const { signedOut } = await import('../util.js');
ok('an expired OAuth session reads as signed out',
  signedOut('Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed'));
ok('an ordinary failure does not read as signed out', !signedOut('npm ERR! ETARGET'));
ok('no error is not signed out', !signedOut(null));

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

// "Put it online" trusts the host's record over the keyword probe.
const webSite = (project, job = {}) => suggest({
  jobs: [{ id: 'w', project_slug: 'site', status: 'done', created_at: iso(5),
    prompt: 'a landing page in html and css with tests and a readme and a ci workflow', ...job }],
  projects: [{ name: 'site', full_name: 'me/site', is_local: true, ...project }],
}).filter((s) => s.slug === 'site').map((s) => s.kind);
ok('a browser project with nothing deployed is offered a deploy',
  webSite({}).includes('deploy'), webSite({}).join());
ok('one the host lists as live is not', !webSite({ live_url: 'https://site.fly.dev/' }).includes('deploy'));
ok('nor one whose last run deployed it',
  !webSite({}, { live_url: 'https://site.fly.dev/' }).includes('deploy'));
ok('nor one kept on the desktop, which the host never deploys',
  !webSite({ full_name: null }).includes('deploy'));

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

// ── 18b. the project catalogue ────────────────────────────────────────
// What the Projects screen is built from. Fixed inputs, because a wrong
// answer here is a link to the wrong place, or to nowhere.

const { catalog, narrow, order, languages, tally, liveHost, webUrl } = await import('../catalog.js');

const cat = catalog({
  projects: [
    { name: 'web', full_name: 'me/web', language: 'Go', pushed_at: iso(10),
      live_url: 'https://web.fly.dev/', live_kind: 'fly' },
    { name: 'cli', full_name: 'me/cli', language: 'Go', pushed_at: iso(50) },
    { name: 'sneaky', full_name: 'me/sneaky', live_url: 'javascript:alert(1)' },
    { name: 'Zed', full_name: null, is_local: true },
  ],
  jobs: [
    { id: 'a', project_slug: 'cli', status: 'done', created_at: iso(1), live_url: 'https://cli.fly.dev/' },
    { id: 'b', project_slug: 'fresh', status: 'running', created_at: iso(2) },
    { id: 'c', project_slug: 'gone', status: 'done', created_at: iso(3) },
    { id: 'd', project_slug: 'web', status: 'queued', created_at: iso(4) },
    { id: 'e', project_slug: 'web', status: 'paused', created_at: iso(6) },
  ],
});
const byName = (n) => cat.find((e) => e.name === n);

ok('the catalogue is the host list plus a build in flight',
  cat.map((e) => e.name).sort().join() === 'Zed,cli,fresh,sneaky,web', cat.map((e) => e.name).join());
ok('a chat whose project the host has lost is left out', !byName('gone'));
ok('with no host list at all, every chat counts',
  catalog({ jobs: [{ id: 'x', project_slug: 'x', status: 'done' }] }).length === 1);
ok('a deploy on a job shows before the host re-syncs',
  byName('cli').live_url === 'https://cli.fly.dev/' && byName('cli').live_kind === 'fly');
ok('a live link that is not a web address is dropped', byName('sneaky').live_url === null);
ok('the most urgent job in flight speaks for the project', byName('web').busy?.status === 'paused');
ok('a run counts as activity, not just a push', byName('cli').touched > byName('web').touched);

ok('languages are counted, most used first',
  JSON.stringify(languages(cat)) === '[["Go",2]]', JSON.stringify(languages(cat)));
ok('the tally adds up', JSON.stringify(tally(cat))
  === JSON.stringify({ total: 5, live: 2, onGitHub: 3, localOnly: 1 }), JSON.stringify(tally(cat)));
ok('the live filter keeps what is live',
  narrow(cat, { filter: 'live' }).map((e) => e.name).sort().join() === 'cli,web');
ok('a search is not case-sensitive', narrow(cat, { query: 'ZED' }).length === 1);
ok('A–Z ignores case', order(cat, 'name').map((e) => e.name).join() === 'cli,fresh,sneaky,web,Zed',
  order(cat, 'name').map((e) => e.name).join());
ok('recent puts work in flight first',
  order(cat).slice(0, 2).map((e) => e.name).sort().join() === 'fresh,web');

ok('an address prints without its scheme or trailing slash',
  liveHost('https://me.github.io/site/') === 'me.github.io/site' && liveHost('https://a.fly.dev/') === 'a.fly.dev');
ok('only http and https become links',
  webUrl('https://a.dev') === 'https://a.dev' && webUrl('javascript:alert(1)') === null
  && webUrl('data:text/html,x') === null && webUrl(null) === null);
ok('a link with a quote in it is refused', webUrl('https://a.dev/"onmouseover="x') === null);

// ── 18b. the fleet model ──────────────────────────────────────────────
// What a queued job is waiting for is arithmetic, and a wrong answer here
// is worse than a crash: it would tell you your desktop is idle when it is
// full, or the other way round.

const { fleet, clampSlots } = await import('../fleet.js');

const job = (id, status, slug, minsAgo) => ({
  id, status, project_slug: slug, created_at: iso(minsAgo), prompt: 'x',
});
const reasons = (f) => f.waiting.map((w) => w.reason).join();

const full = fleet({
  jobs: [job('a', 'running', 'one', 9), job('b', 'running', 'two', 8), job('c', 'queued', 'three', 7)],
  maxParallel: 2,
  hostFresh: true,
});
ok('a full fleet has no free slots', full.used === 2 && full.free === 0);
ok('and the queue is waiting on a slot', reasons(full) === 'slot', reasons(full));
ok('one pip per slot, all taken', full.pips.join() === 'running,running');

const room = fleet({
  jobs: [job('a', 'running', 'one', 9), job('c', 'queued', 'three', 7)],
  maxParallel: 3,
  hostFresh: true,
});
ok('a job with a slot waiting for it is next, not blocked', reasons(room) === 'next');
ok('free slots are counted', room.free === 2);
ok('an empty slot has a pip of its own', room.pips.join() === 'running,free,free');

const paused = fleet({
  jobs: [job('a', 'paused', 'one', 9), job('c', 'queued', 'three', 7)],
  maxParallel: 1,
  hostFresh: true,
});
ok('a paused agent keeps its slot', paused.used === 1 && paused.free === 0);
ok('so the next job waits for one', reasons(paused) === 'slot');

const sameProject = fleet({
  jobs: [job('a', 'running', 'one', 9), job('c', 'queued', 'one', 7)],
  maxParallel: 4,
  hostFresh: true,
});
ok('a second job on a busy project waits for the project, not a slot',
  reasons(sameProject) === 'project', reasons(sameProject));

const offline = fleet({ jobs: [job('c', 'queued', 'one', 7)], maxParallel: 3, hostFresh: false });
ok('with no desktop, a queued job is waiting for the desktop', reasons(offline) === 'host');

const queueOrder = fleet({
  jobs: [job('a', 'running', 'one', 9), job('b', 'queued', 'two', 8),
    job('c', 'queued', 'three', 7), job('d', 'queued', 'four', 6)],
  maxParallel: 2,
  hostFresh: true,
});
ok('the queue is read in the order the runner would claim it',
  reasons(queueOrder) === 'next,slot,slot', reasons(queueOrder));
ok('and each job knows how many are in front of it',
  queueOrder.waiting.map((w) => w.ahead).join() === '0,1,2');
ok('only the ones a slot would release are counted as blocked',
  queueOrder.blocked === 2);

const lowered = fleet({
  jobs: [job('a', 'running', 'one', 9), job('b', 'running', 'two', 8)],
  maxParallel: 1,
  hostFresh: true,
});
ok('a ceiling lowered under a running fleet is reported, not hidden',
  lowered.over === 1 && lowered.free === 0);

ok('the ceiling is clamped to something a desktop can do',
  clampSlots(0) === 1 && clampSlots(99) === 6 && clampSlots('4') === 4);
ok('and nonsense falls back to the default', clampSlots('many') === 3);
ok('an empty account has an empty fleet',
  fleet({}).used === 0 && fleet({}).waiting.length === 0);

// ── 18c. the assistant model ──────────────────────────────────────────
// Fixed inputs, because every one of these answers is a sentence the screen
// shows you while you wait. "typing…" over a PC that is off, or "about to
// start" for something fourth in line, is worse than a crash: you would sit
// there believing it.

const {
  presence, replyState, conversations, turns: askTurns, titleOf, pendingQueue, isPending,
} = await import('../assistant.js');

const nowMs = Date.parse('2026-03-12T12:00:00Z');
const seenAt = (secondsAgo) => new Date(nowMs - secondsAgo * 1000).toISOString();

const never = presence(null, nowMs);
ok('never having checked in is not the same as being offline',
  never.known === false && never.online === false);
ok('a bridge that said hello 5s ago is online',
  presence({ name: 'jarvis', last_seen: seenAt(5) }, nowMs).online);
ok('one that said hello 5 minutes ago is not',
  !presence({ name: 'jarvis', last_seen: seenAt(300) }, nowMs).online);
ok('and it is still known, so the screen can say when',
  presence({ name: 'jarvis', last_seen: seenAt(300) }, nowMs).known);
ok('the name and model come through',
  presence({ name: 'jarvis', model: 'llama3', last_seen: seenAt(1) }, nowMs).model === 'llama3');
ok('a bridge with no name still has one to print',
  presence({ name: '', last_seen: seenAt(1) }, nowMs).name === 'your assistant');

const queued = { role: 'assistant', status: 'queued', text: '' };
ok('a queued reply with the PC off waits for the PC',
  replyState({ message: queued, online: false, known: true }).kind === 'offline');
ok('and never claims to be typing',
  !replyState({ message: queued, online: false, known: true }).label.includes('typing'));
ok('a queued reply with the PC on is about to start',
  replyState({ message: queued, online: true }).kind === 'next');
has('one with others in front says how many',
  replyState({ message: queued, online: true, ahead: 2 }).label, '2 ahead');
ok('a streaming reply is typing even if the heartbeat is stale',
  replyState({ message: { ...queued, status: 'streaming' }, online: false }).kind === 'typing');
ok('a stop beats everything else',
  replyState({ message: { ...queued, status: 'streaming', cancel_requested: true } }).kind
    === 'stopping');
ok('a done reply is done and not live',
  replyState({ message: { ...queued, status: 'done', text: 'hi' } }).kind === 'done');
ok('an errored reply carries its reason',
  replyState({ message: { ...queued, status: 'error', error: 'boom' } }).note === 'boom');
ok('with no bridge at all, a reply says so rather than guessing',
  replyState({ message: queued, online: false, known: false }).kind === 'never');
ok('only a queued or streaming reply is pending',
  isPending(queued) && isPending({ ...queued, status: 'streaming' })
  && !isPending({ ...queued, status: 'done' })
  && !isPending({ role: 'user', status: 'done' }));

const msgs = [
  { id: 1, chat_id: 'a', role: 'user', text: 'first thing I ever asked', status: 'done', created_at: iso(90) },
  { id: 2, chat_id: 'a', role: 'assistant', text: 'answered', status: 'done', created_at: iso(89) },
  { id: 3, chat_id: 'b', role: 'user', text: 'later', status: 'done', created_at: iso(5) },
  { id: 4, chat_id: 'b', role: 'assistant', text: '', status: 'queued', created_at: iso(4) },
];
const convos = conversations({
  chats: [
    { id: 'a', created_at: iso(90), updated_at: iso(89) },
    { id: 'b', created_at: iso(5), updated_at: iso(4) },
    { id: 'c', created_at: iso(200), updated_at: iso(200), title: 'Named by hand' },
  ],
  messages: msgs,
});
ok('conversations come back newest first', convos.map((c) => c.id).join() === 'b,a,c',
  convos.map((c) => c.id).join());
ok('an untitled conversation is named by how it opened',
  convos.find((c) => c.id === 'a').title === 'first thing I ever asked');
ok('a title you set wins', convos.find((c) => c.id === 'c').title === 'Named by hand');
ok('an empty one still shows up, with a name',
  convos.find((c) => c.id === 'c').messages.length === 0
  && convos.find((c) => c.id === 'c').asked === 0);
ok('a pending reply is counted against its own conversation',
  convos.find((c) => c.id === 'b').pending === 1
  && convos.find((c) => c.id === 'a').pending === 0);
ok('a long opening line is clipped, not left to break the row',
  titleOf({}, [{ role: 'user', text: 'x'.repeat(120), created_at: iso(1) }]).length <= 48);
ok('nothing said yet has a name anyway',
  titleOf({}, []) === 'New conversation');

const paired = askTurns(msgs.filter((m) => m.chat_id === 'a'));
ok('a message and its reply are one turn', paired.length === 1
  && paired[0].you.id === 1 && paired[0].reply.id === 2);
const volunteered = askTurns([
  { id: 1, role: 'assistant', text: 'unprompted', created_at: iso(3) },
  { id: 2, role: 'user', text: 'oh', created_at: iso(2) },
  { id: 3, role: 'assistant', text: 'yes', created_at: iso(1) },
]);
ok('a reply with nothing in front of it still gets a turn',
  volunteered.length === 2 && volunteered[0].you === null);

ok('the queue is read in the order the bridge would claim it',
  pendingQueue(msgs).map((m) => m.id).join() === '4');
ok('an empty account has an empty queue', pendingQueue([]).length === 0);
ok('and no presence to report', presence(undefined).known === false);

// ── 19b. the bridge's adapters ────────────────────────────────────────
// The one part of the PC half that has to guess: what shape a reply arrives
// in. Every guess lives in bridge/reply.mjs, so every guess is checked here.

const {
  bodyText, bodyError, chunkText, sniff, makeStream, oneShot, transcript,
} = await import('../bridge/reply.mjs');

ok('OpenAI streaming deltas are understood',
  bodyText({ choices: [{ delta: { content: 'hi' } }] }) === 'hi');
ok('OpenAI whole messages are too',
  bodyText({ choices: [{ message: { content: 'hi' } }] }) === 'hi');
ok('Anthropic content blocks are joined',
  bodyText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }) === 'ab');
ok('Anthropic stream deltas are understood', bodyText({ delta: { text: 'c' } }) === 'c');
ok('Ollama chat is understood', bodyText({ message: { content: 'ok' } }) === 'ok');
ok('Ollama generate is understood', bodyText({ response: 'ok' }) === 'ok');
ok('a hand-written endpoint can just say reply', bodyText({ reply: 'ok' }) === 'ok');
ok('or text, or answer',
  bodyText({ text: 'a' }) === 'a' && bodyText({ answer: 'b' }) === 'b');
ok('a shape nobody recognises yields nothing rather than noise',
  bodyText({ mystery: 1 }) === '');
ok('an error in the body is found', bodyError({ error: 'no model' }) === 'no model');
ok('including a nested one', bodyError({ error: { message: 'no model' } }) === 'no model');
ok('and a body with no error says so', bodyError({ ok: 1 }) === '');

ok('a server-sent event stream is recognised', sniff('data: {"x":1}') === 'sse');
ok('so is newline-delimited JSON', sniff('{"x":1}\n') === 'lines');
ok('and plain prose', sniff('Hello there') === 'prose');
ok('nothing yet is not a guess', sniff('   ') === null);

ok('an SSE data line gives up its text',
  chunkText('data: {"choices":[{"delta":{"content":"hey"}}]}', 'sse') === 'hey');
ok('SSE protocol lines are not mistaken for prose',
  chunkText('event: message', 'sse') === '' && chunkText('', 'sse') === '');
ok('the end-of-stream marker adds nothing',
  chunkText('data: [DONE]', 'sse') === '');
ok('a JSON line that does not parse is kept as prose, never dropped',
  chunkText('{half a line', 'lines') === '{half a line\n');
ok('prose is passed through exactly', chunkText('  two  spaces ') === '  two  spaces ');

let errored = '';
try { chunkText('data: {"error":"model not found"}', 'sse'); }
catch (e) { errored = e.message; }
ok('an error arriving mid-stream is thrown, not printed as a reply',
  errored === 'model not found');

const prosePieces = [];
const proseStream = makeStream((t) => prosePieces.push(t));
proseStream.push('Line one\nLine ');
proseStream.push('two\n');
proseStream.end();
ok('prose keeps its own newlines', prosePieces.join('') === 'Line one\nLine two\n',
  JSON.stringify(prosePieces.join('')));

const ssePieces = [];
const sseStream = makeStream((t) => ssePieces.push(t));
sseStream.push('data: {"response":"Hel');
sseStream.push('lo"}\n\ndata: {"response":" there"}\n');
sseStream.end();
ok('a stream split mid-token is reassembled', ssePieces.join('') === 'Hello there',
  ssePieces.join('|'));
ok('and the mode is decided once, from the first thing said', sseStream.mode === 'sse');

const lumpy = [];
const lineStream = makeStream((t) => lumpy.push(t));
lineStream.push('{"response":"a"}\n{"response":"b"}');
lineStream.end();
ok('an unterminated last line is still delivered', lumpy.join('') === 'ab', lumpy.join('|'));

ok('a whole JSON body at once is unwrapped', oneShot('{"reply":"done"}') === 'done');
ok('a whole plain body is left alone', oneShot('just words') === 'just words');
ok('and an empty one is empty', oneShot('') === '' && oneShot(null) === '');

has('a transcript labels both sides',
  transcript([{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }]),
  'You: q\n\nAssistant: a');

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
