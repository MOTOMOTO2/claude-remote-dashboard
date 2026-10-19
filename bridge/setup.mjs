// "Your assistant is not set up yet" — this is the thing that answers it.
//
//   node bridge/setup.mjs          check everything, fix what it can
//   npm run bridge:setup
//
// Four things have to be true before #/ask works. This says which of them
// are, does the two it can do on its own, and prints the exact next command
// for the ones only you can do:
//
//   1. the relay          — a Supabase project (config.js already has it)
//   2. the tables         — bridge/schema.sql, pasted into the SQL editor
//   3. bridge/.env        — written from the example, with the relay filled in
//   4. your assistant     — ASSISTANT_CMD or ASSISTANT_URL, and it answers
//
// It never writes to Supabase and never overwrites a .env you already have.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { answerWith } from './reply.mjs';

const here = new URL('./', import.meta.url);
const ENV_PATH = new URL('.env', here);
const EXAMPLE = new URL('.env.example', here);
const SCHEMA = new URL('schema.sql', here);
const CONFIG_JS = new URL('../config.js', here);

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', b: '\x1b[1m', ok: '\x1b[32m', no: '\x1b[31m', wait: '\x1b[33m', off: '\x1b[0m' }
  : { dim: '', b: '', ok: '', no: '', wait: '', off: '' };

const steps = [];
const step = (state, title, ...lines) => {
  const mark = { ok: `${C.ok}OK${C.off}`, todo: `${C.no}--${C.off}`, warn: `${C.wait}??${C.off}` }[state];
  console.log(`\n  [${mark}] ${C.b}${title}${C.off}`);
  for (const l of lines.filter(Boolean)) console.log(`       ${l}`);
  steps.push(state);
};
const quote = (s) => `${C.dim}${s}${C.off}`;

// ── 1. the relay ──────────────────────────────────────────────────────
// config.js is the one place the Supabase project is written down, so the
// bridge is told about it from there rather than asking you twice.

function readConfigJs() {
  let text;
  try { text = readFileSync(CONFIG_JS, 'utf8'); } catch { return {}; }
  const pick = (key) => text.match(new RegExp(`${key}\\s*:\\s*['"\`]([^'"\`]*)`))?.[1] ?? '';
  return { url: pick('supabaseUrl').replace(/\/+$/, ''), key: pick('supabaseAnonKey') };
}

/** https://abcd.supabase.co -> abcd, which is what the dashboard URL wants. */
const projectRef = (url) => url.match(/^https:\/\/([a-z0-9-]+)\.supabase\./i)?.[1] ?? '';

const cfg = readConfigJs();
if (!cfg.url || !cfg.key) {
  step('todo', 'The relay',
    'config.js has no Supabase project in it yet.',
    `Run ${quote('cp config.example.js config.js')} and fill in the URL and publishable key.`);
} else {
  step('ok', 'The relay', `${cfg.url}`);
}

// ── 2. the tables ─────────────────────────────────────────────────────
// Asking for one row of each is enough: a table that is not there answers
// PGRST205, and a table that is there answers [] because row-level security
// hides your rows from an unauthenticated key. Either way nothing is read.

const WANTED = ['chats', 'chat_messages', 'assistants', 'settings'];

async function tableExists(name) {
  try {
    const res = await fetch(`${cfg.url}/rest/v1/${name}?select=*&limit=1`, {
      headers: { apikey: cfg.key, authorization: `Bearer ${cfg.key}` },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.ok) return true;
    const body = await res.json().catch(() => ({}));
    return body.code === 'PGRST205' || /schema cache/i.test(body.message ?? '') ? false : null;
  } catch {
    return null;                               // no network: do not guess
  }
}

let tablesReady = false;
if (cfg.url && cfg.key) {
  const found = await Promise.all(WANTED.map(tableExists));
  const missing = WANTED.filter((_, i) => found[i] === false);
  const unknown = found.some((f) => f === null);
  const ref = projectRef(cfg.url);
  const editor = ref ? `https://supabase.com/dashboard/project/${ref}/sql/new` : 'the SQL editor';

  if (unknown) {
    step('warn', 'The tables', 'Could not reach Supabase to check. Try again when you are online.');
  } else if (!missing.length) {
    tablesReady = true;
    step('ok', 'The tables', `all four are there: ${WANTED.join(', ')}`);
  } else {
    step('todo', `The tables (${missing.length} missing: ${missing.join(', ')})`,
      `Open  ${editor}`,
      `Paste ${fileURLToPath(SCHEMA)}`,
      'Press run once. It adds tables and changes nothing that is already there.',
      `${C.dim}(The Assistant screen has the same two buttons, if the phone is closer.)${C.off}`);
  }
}

// ── 3. bridge/.env ────────────────────────────────────────────────────
// Written for you, with the relay already filled in. Never overwritten: the
// bottom half of that file is a password.

function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

let created = false;
if (!existsSync(ENV_PATH)) {
  const filled = readFileSync(EXAMPLE, 'utf8')
    .replace(/^SUPABASE_URL=.*$/m, `SUPABASE_URL=${cfg.url}`)
    .replace(/^SUPABASE_ANON_KEY=.*$/m, `SUPABASE_ANON_KEY=${cfg.key}`);
  writeFileSync(ENV_PATH, filled);
  created = true;
}

const env = { ...parseEnv(readFileSync(ENV_PATH, 'utf8')), ...process.env };
const named = env.SUPABASE_EMAIL && !/example\.com$/.test(env.SUPABASE_EMAIL);
const signIn = env.SUPABASE_SERVICE_KEY ? 'with the service-role key'
  : (named && env.SUPABASE_PASSWORD) ? `as ${env.SUPABASE_EMAIL}` : '';

// Name the one line that is missing rather than both of them: "fill this in"
// is the sort of instruction you read twice.
if (!signIn) {
  step('todo', created ? 'bridge/.env (written for you)' : 'bridge/.env',
    created ? `Created from the example, with ${cfg.url} already in it.` : '',
    `Edit ${fileURLToPath(ENV_PATH)}:`,
    named
      ? `${quote('SUPABASE_PASSWORD=')}  the password for ${env.SUPABASE_EMAIL}. That one line `
        + 'is all that is missing from this file.'
      : `${quote('SUPABASE_EMAIL=')} and ${quote('SUPABASE_PASSWORD=')}  the account you sign `
        + 'in to the dashboard with',
    `${C.dim}It is gitignored, and it stays on this machine. The bridge signs in as you, so `
      + `row-level security still applies and no service-role key ends up here.${C.off}`);
} else {
  step('ok', 'bridge/.env', `signs in ${signIn}`);
}

// ── 4. your assistant ─────────────────────────────────────────────────
// The bridge does not know what your assistant is, by design. If you have
// not told it yet, look for the usual local suspects and offer them, because
// "which port is it on" is the only hard part of this step.

const LIKELY = [
  { port: 11434, path: '/api/tags', chat: '/api/chat', what: 'Ollama' },
  { port: 1234, path: '/v1/models', chat: '/v1/chat/completions', what: 'LM Studio' },
  { port: 8080, path: '/v1/models', chat: '/v1/chat/completions', what: 'llama.cpp' },
  { port: 5000, path: '/v1/models', chat: '/v1/chat/completions', what: 'text-generation-webui' },
  { port: 8000, path: '/v1/models', chat: '/v1/chat/completions', what: 'an OpenAI-shaped server' },
  { port: 3000, path: '/', chat: '/', what: 'something on :3000' },
];

async function knock({ port, path }) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(900) });
    return res.status < 500;
  } catch { return false; }
}

const cmd = env.ASSISTANT_CMD ?? '';
const url = env.ASSISTANT_URL ?? '';
const isExample = /example-assistant\.mjs/.test(cmd);

if (!cmd && !url) {
  const live = (await Promise.all(LIKELY.map(async (c) => (await knock(c)) ? c : null))).filter(Boolean);
  step('todo', 'Your assistant',
    `Nothing is configured. Put one line in ${fileURLToPath(ENV_PATH)}:`,
    live.length
      ? `Answering on this machine right now: ${live.map((c) => `${c.what} (:${c.port})`).join(', ')}`
      : 'Nothing is answering on the usual local ports.',
    ...live.map((c) => quote(`ASSISTANT_URL=http://127.0.0.1:${c.port}${c.chat}`)),
    quote('ASSISTANT_CMD=python C:\\path\\to\\your\\assistant.py'),
    `${C.dim}A command gets the question as $ASSISTANT_PROMPT, as $ASSISTANT_TRANSCRIPT and`
      + ` as JSON on stdin; whatever it prints is the reply.${C.off}`);
} else {
  process.stdout.write(`\n  ${C.dim}asking ${cmd ? cmd.split(/\s+/)[0] : url}…${C.off}`);
  let reply = '', failed = null;
  try {
    let headers = {};
    try { headers = JSON.parse(env.ASSISTANT_HEADERS || '{}'); } catch { /* as if unset */ }
    const answer = answerWith({ cmd, url, headers });
    await answer({
      messages: [{ role: 'user', text: 'Say hello in one short sentence.' }],
      onChunk: (text) => { reply += text; },
      stopped: () => false,
    });
  } catch (e) { failed = e?.message ?? String(e); }
  process.stdout.write('\r'.padEnd(60, ' ') + '\r');

  const where = cmd ? `ASSISTANT_CMD=${cmd}` : `ASSISTANT_URL=${url}`;
  if (failed) {
    step('todo', 'Your assistant', where, `It did not answer: ${failed}`,
      `Retry with ${quote('node bridge/bridge.mjs --try "hello"')} once you have changed it.`);
  } else if (!reply.trim()) {
    step('warn', 'Your assistant', where, 'It ran, but printed nothing.');
  } else {
    step(isExample ? 'warn' : 'ok', 'Your assistant', where,
      `Answered with ${reply.trim().length} characters: "${reply.trim().slice(0, 60)}"`,
      isExample ? `${C.dim}That is the stand-in. Point ASSISTANT_CMD or ASSISTANT_URL at your own `
        + `assistant when you are ready — nothing else changes.${C.off}` : '');
  }
}

// ── what is left ──────────────────────────────────────────────────────

const todo = steps.filter((s) => s === 'todo').length;
console.log('');
if (!todo) {
  console.log(`  ${C.ok}Nothing left.${C.off} Start it and leave it running:\n`);
  console.log(`      ${C.b}npm run bridge${C.off}`);
  console.log(`\n  ${C.dim}Or have Windows keep it running, from an Administrator PowerShell:${C.off}\n`);
  console.log(`      powershell -ExecutionPolicy Bypass -File "${fileURLToPath(new URL('run-at-logon.ps1', here))}"\n`);
} else {
  console.log(`  ${todo} thing${todo === 1 ? '' : 's'} left. Do ${todo === 1 ? 'it' : 'them'} and run `
    + `${C.b}npm run bridge:setup${C.off} again.\n`);
}
process.exit(todo ? 1 : 0);
