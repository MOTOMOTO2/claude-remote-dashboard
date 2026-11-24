// Set up the cloud runner on this Vercel project, one question at a time.
//
//   npm run cloud:setup
//
// It finds out which settings the deployment already has, works out every
// value it can on its own (your Supabase project from config.js, your GitHub
// account from `gh`, fresh random secrets), asks for the rest, and stores each
// one with `vercel env add` after you say yes. Values never go anywhere but
// Vercel, and nothing is stored on this machine.
//
// Run it again any time: it only asks about what is still missing.

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const say = (s = '') => process.stdout.write(`${s}\n`);
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));
const yes = async (q) => /^y/i.test(await ask(`${q} [y/N] `));

/** A secret typed without echoing it. */
function askHidden(q) {
  return new Promise((resolve) => {
    const out = process.stdout;
    out.write(q);
    const write = rl._writeToOutput;
    rl._writeToOutput = () => {};
    rl.question('', (a) => {
      rl._writeToOutput = write;
      out.write('\n');
      resolve(a.trim());
    });
  });
}

const vercel = (args, input) => spawnSync('npx', ['--yes', 'vercel@latest', ...args], {
  cwd: root, input, encoding: 'utf8', stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'pipe'],
});
const tryRun = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};

// ── where we are ──────────────────────────────────────────────────────

say(`\n  ${bold('claude-remote · cloud runner setup')}\n`);
if (!existsSync(new URL('../.vercel/project.json', import.meta.url))) {
  say('  This folder is not linked to a Vercel project yet. Run `npx vercel link` first.\n');
  process.exit(1);
}
const listing = vercel(['env', 'ls', 'production']);
if (listing.status !== 0) {
  say(`  Could not read the project's settings from Vercel:\n  ${listing.stderr.trim()}\n`);
  process.exit(1);
}
const have = new Set([...listing.stdout.matchAll(/^\s*([A-Z][A-Z0-9_]+)\s/gm)].map((m) => m[1]));

const cfgText = readFileSync(new URL('../config.js', import.meta.url), 'utf8');
const supabaseUrl = cfgText.match(/supabaseUrl:\s*'([^']+)'/)?.[1] ?? '';
const ref = supabaseUrl.match(/https:\/\/([a-z0-9-]+)\.supabase\./)?.[1] ?? '';

const values = {};
const later = [];

async function store(name, value, { secret = true } = {}) {
  if (!value) return;
  const res = vercel(['env', 'add', name, 'production', ...(secret ? ['--sensitive'] : [])], `${value}\n`);
  if (res.status === 0) say(`  ${bold('✓')} ${name} saved`);
  else {
    // Older CLIs have no --sensitive; every Vercel variable is encrypted anyway.
    const plain = vercel(['env', 'add', name, 'production'], `${value}\n`);
    say(plain.status === 0 ? `  ${bold('✓')} ${name} saved` : `  ✗ ${name}: ${(plain.stderr || res.stderr).trim().split('\n').at(-1)}`);
  }
}

async function want(name, how) {
  if (have.has(name)) { say(`  ${dim(`✓ ${name} is already set`)}`); return; }
  say(`\n  ${bold(name)}`);
  const value = await how();
  if (value) { values[name] = value; await store(name, value, { secret: !/^(SUPABASE_URL|GITHUB_OWNER|OWNER_NAME|OWNER_ID)$/.test(name) }); }
  else later.push(name);
}

// ── each setting ──────────────────────────────────────────────────────

await want('SUPABASE_URL', async () => {
  say(`  From config.js: ${supabaseUrl || '(not found)'}`);
  return supabaseUrl && (await yes('  Use it?')) ? supabaseUrl : ask('  Your Supabase URL: ');
});

await want('SUPABASE_SERVICE_KEY', async () => {
  say('  The secret (service_role) key: it lets the runner update jobs and write the log.');
  say(`  Find it at https://supabase.com/dashboard/project/${ref || '<project>'}/settings/api-keys`);
  say('  (the PC runner\'s agent-host/.env has the same key, if that is easier).');
  return askHidden('  Paste it (hidden): ');
});

await want('OWNER_ID', async () => {
  // Whose dashboard this is: the only account the runner will work for.
  const key = values.SUPABASE_SERVICE_KEY;
  if (key && supabaseUrl) {
    const res = await fetch(`${supabaseUrl}/rest/v1/jobs?select=owner&limit=1`, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
    }).catch(() => null);
    const owner = res?.ok ? (await res.json())[0]?.owner : null;
    if (owner) {
      say(`  Your jobs belong to ${owner}.`);
      if (await yes('  That is you — use it?')) return owner;
    }
  }
  say(`  Your user id, from https://supabase.com/dashboard/project/${ref || '<project>'}/auth/users`);
  return ask('  OWNER_ID: ');
});

await want('CLAUDE_CODE_OAUTH_TOKEN', async () => {
  say('  A one-year token that lets the runner use your Claude subscription.');
  say(`  In a terminal, run ${bold('claude setup-token')} (or ${bold('npx @anthropic-ai/claude-code setup-token')}),`);
  say('  approve it in the browser, and paste the token it prints.');
  return askHidden('  Paste it (hidden), or press Enter to do it later: ');
});

await want('GH_TOKEN', async () => {
  say('  Lets the runner clone your repos, push its work, and create repos for new projects.');
  const fromGh = tryRun('gh', ['auth', 'token']);
  if (fromGh && await yes('  Use the token the GitHub CLI on this machine is signed in with?')) return fromGh;
  say('  Otherwise make one at https://github.com/settings/tokens (classic, "repo" scope).');
  return askHidden('  Paste it (hidden): ');
});

await want('GITHUB_OWNER', async () => {
  const login = tryRun('gh', ['api', 'user', '-q', '.login']);
  if (login && await yes(`  Your GitHub account is ${login} — use it?`)) return login;
  return ask('  Your GitHub username: ');
});

await want('OWNER_NAME', async () => ask('  What should Claude call you? (Enter to skip) '));

await want('RUNNER_SECRET', async () => {
  say('  A random password the sandboxes use to call back. Generated for you.');
  return randomBytes(24).toString('base64url');
});

await want('CRON_SECRET', async () => {
  say('  The same for Vercel\'s daily cron, which resumes anything paused for usage. Generated.');
  return randomBytes(24).toString('base64url');
});

rl.close();

// ── what next ─────────────────────────────────────────────────────────

say('');
if (later.length) {
  say(`  Still to set: ${later.join(', ')}. Run ${bold('npm run cloud:setup')} again when you have them.`);
} else {
  say('  Everything is set.');
}
say(`  Settings take effect on the next deployment: push to main, or run ${bold('npx vercel --prod')}.`);
say(`  Then open the dashboard — the topbar says ${bold('cloud · asleep')} when the runner is ready.\n`);
