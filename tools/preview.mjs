// Renders one screen of the app to a static HTML file you can open (or
// screenshot) without a Supabase project. It boots the real app in jsdom
// against the test fixtures, then freezes the DOM.
//
//   node --import ./test/register.mjs tools/preview.mjs agents dark
//
// Writes preview/<view>-<theme>.html.
// Views: agents · sheet · ask · house · chat · new · ideas · projects · auth ·
// empty · setup. `sheet` is the front page with the usage sheet open.
// Themes: light · dark · mobile · mobile-dark.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fake } from '../test/fake-supabase.mjs';
import { seed, makeWindow, tick, root, iso } from '../test/harness.mjs';

const [view = 'agents', theme = 'light'] = process.argv.slice(2);
const HASH = {
  agents: '#/agents', sheet: '#/agents', ask: '#/ask', chat: '#/p/alpha', new: '#/new',
  ideas: '#/ideas', projects: '#/projects', house: '#/house',
  auth: '#/', empty: '#/', setup: '#/ask',
};
const mobile = theme.startsWith('mobile');
const dark = theme === 'dark' || theme.endsWith('-dark');
if (!(view in HASH)) {
  console.error(`unknown view "${view}" — pick one of ${Object.keys(HASH).join(', ')}`);
  process.exit(1);
}

seed();
if (view === 'empty') {
  for (const table of Object.keys(fake.tables)) fake.tables[table] = [];
}
// An account whose schema predates the assistant: the screen that has to
// talk you through setting it up rather than just naming a file.
if (view === 'setup') {
  fake.failTable('chats', 'relation "public.chats" does not exist');
  fake.tables.assistants = [];
}
// A reply arriving is the state worth looking at on the assistant screen.
if (view === 'ask') {
  fake.tables.chat_messages.push(
    { id: 9, chat_id: 'c1', owner: 'u1', role: 'user', status: 'done', created_at: iso(2),
      text: 'how do I keep you reachable when I am out?' },
    { id: 10, chat_id: 'c1', owner: 'u1', role: 'assistant', status: 'streaming',
      created_at: iso(2),
      text: 'Leave the bridge running on this PC. It talks outward to Supabase, so' },
  );
}
const { dom, window } = makeWindow({ width: mobile ? 420 : 1200, dark });
window.localStorage.setItem('cr-theme', dark ? 'dark' : 'light');
window.location.hash = HASH[view];

await import('../app.js');
await tick();

if (view !== 'auth') {
  fake.signIn();
  await tick();
  window.location.hash = HASH[view];
  await tick();
  if (view === 'new') window.document.getElementById('opts').hidden = false;
  if (view === 'sheet') {
    window.document.getElementById('usage-pill').click();
    await tick();
  }
}

const frozen = dom.serialize()
  // Nothing should re-run; this is a snapshot, not a working app.
  .replace(/<script[\s\S]*?<\/script>/g, '')
  // The file lives one directory down, so assets resolve from the parent.
  .replace('<head>', '<head>\n<base href="../">');

mkdirSync(new URL('preview/', root), { recursive: true });
const out = new URL(`preview/${view}-${theme}.html`, root);
writeFileSync(out, frozen);
console.log(`wrote ${out.pathname.split('/').pop()}`);
process.exit(0);
