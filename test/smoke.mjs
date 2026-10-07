// Boots the real app in jsdom against a fake Supabase and walks the screens
// a person actually uses. No build step means no type checker, so this is the
// safety net: it catches a renamed id, a broken selector, or a render that
// throws, which is exactly what goes wrong in a vanilla app.

import { readdirSync } from 'node:fs';
import { fake } from './fake-supabase.mjs';
import { root, file, seed, makeWindow, tick } from './harness.mjs';

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
has('live row shows the current activity', el('active-list').innerHTML, 'Edit src/game.js');

const meters = el('usage-home').querySelectorAll('.meter');
ok('three usage meters render', meters.length === 3, `got ${meters.length}`);
has('meter is labelled in words', el('usage-home').innerHTML, 'Session · 5 hours');
has('meter prints its percentage', el('usage-home').innerHTML, '42%');
ok('high usage meter carries the severity class',
  el('usage-home').querySelectorAll('.meter.full').length === 1);
ok('mid usage meter carries the warn class',
  el('usage-home').querySelectorAll('.meter.warn').length === 1);
ok('meter fill width matches the value',
  el('usage-home').querySelector('.meter-fill').getAttribute('style').includes('42%'));

ok('project tile counts the projects', text('kpi-projects') === '4', `got ${text('kpi-projects')}`);
ok('finished tile counts done jobs', text('kpi-done') === '1');
ok('failed tile counts errors', text('kpi-failed') === '1');
ok('failed tile is flagged', el('kpi-failed').closest('.tile').classList.contains('flag'));

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
ok('examples render', el('example-row').querySelectorAll('.example').length >= 3);

el('example-row').querySelector('.example').click();
await tick();
ok('clicking an example fills the composer', el('prompt').value.length > 10);

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

// ── 14. markdown unit checks ──────────────────────────────────────────

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
