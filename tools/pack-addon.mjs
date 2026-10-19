// Make bridge/addon a folder you can copy straight to the hub.
//
// A local Home Assistant add-on is built on the hub, and the build context is
// the add-on's own directory — so the four files the relay runs cannot be
// referred to as ../../house.js from inside its Dockerfile. This copies them
// in, under bridge/addon/relay, keeping the layout the imports expect.
//
// They are gitignored rather than committed: one copy of the relay lives in
// the repo, and this script is how it gets to the hub.
//
//   npm run addon

import { cp, mkdir, rm, readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'bridge', 'addon', 'relay');

/** house.js keeps its place at the root: bridge/ imports it as ../house.js. */
const FILES = [
  ['house.js', 'house.js'],
  ['bridge/env.mjs', 'bridge/env.mjs'],
  ['bridge/ha.mjs', 'bridge/ha.mjs'],
  ['bridge/house.mjs', 'bridge/house.mjs'],
];

export async function pack({ to = dest, quiet = false } = {}) {
  await rm(to, { recursive: true, force: true });
  await mkdir(join(to, 'bridge'), { recursive: true });

  const copied = [];
  for (const [from, into] of FILES) {
    await cp(join(root, from), join(to, into));
    copied.push(into);
  }

  // The one mistake worth catching here: a relative import reaching outside
  // what we copied would build fine and then crash on the hub.
  const missing = [];
  for (const [, into] of FILES) {
    const text = await readFile(join(to, into), 'utf8');
    const imports = text.matchAll(/^\s*(?:import|export)[^'"]*from\s*['"](\.[^'"]+)['"]/gm);
    for (const m of imports) {
      const target = join(dirname(join(to, into)), m[1]);
      const there = await stat(target).then(() => true, () => false);
      if (!there) missing.push(`${into} imports ${m[1]}`);
    }
  }

  if (!quiet) for (const f of copied) process.stdout.write(`  + relay/${f}\n`);
  return { copied, missing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write('\n  packing bridge/addon so the hub can build it\n\n');
  const { copied, missing } = await pack();
  if (missing.length) {
    process.stderr.write('\n  These would not resolve on the hub:\n'
      + missing.map((m) => `    ${m}\n`).join('') + '\n');
    process.exit(1);
  }
  process.stdout.write(`\n  ${copied.length} files packed. Now copy the folder to the hub —\n`
    + '  it shares one over the network for exactly this:\n\n'
    + '    Windows   \\\\homeassistant\\addons\n'
    + '    macOS     smb://homeassistant/addons\n\n'
    + '  Copy bridge/addon there as a folder named house_relay. Then on the hub:\n'
    + '  Settings → Add-ons → Add-on store → ⋮ → Check for updates, and "House\n'
    + '  relay" is under Local add-ons. Install it, fill in the Supabase half on\n'
    + '  its Configuration tab, and start it.\n\n'
    + '  Nothing else has to be awake after that — not this PC.\n\n');
}
