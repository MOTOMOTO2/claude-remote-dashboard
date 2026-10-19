// The PC half of "talk to my own assistant from anywhere".
//
// Your assistant runs on your machine. A phone on mobile data cannot reach
// it, and opening a port so it could is a bad trade. So this does what the
// coding runner already does: it talks *outward* to Supabase, claims whatever
// you sent from the dashboard, asks your assistant, and streams the answer
// back into the same row. Nothing listens for inbound connections, nothing
// needs a static IP, and the whole thing is reachable for exactly as long as
// this process is running — which is to say, as long as the PC is on.
//
//   node bridge/bridge.mjs                  keep answering, for ever
//   node bridge/bridge.mjs --once           answer one message and stop
//   node bridge/bridge.mjs --try "hello"    just test your assistant, no
//                                           Supabase involved at all
//
// Configure it with environment variables (a bridge/.env file is read if it
// is there). Either sign in as yourself — recommended, no service key on
// disk — or use the service-role key the coding runner already has:
//
//   SUPABASE_URL=https://xxxx.supabase.co
//   SUPABASE_ANON_KEY=...        + SUPABASE_EMAIL=... SUPABASE_PASSWORD=...
//   SUPABASE_SERVICE_KEY=...     (instead of the three above)
//
// And say what your assistant actually is — one of these:
//
//   ASSISTANT_CMD=python C:\ai\jarvis.py
//   ASSISTANT_URL=http://127.0.0.1:11434/api/chat
//
// Your smart home hub rides along in the same process, if you point it at
// one — see bridge/house.mjs:
//
//   HA_URL=http://homeassistant.local:8123
//   HA_TOKEN=...
//
// Optional: ASSISTANT_NAME (defaults to this computer's name), ASSISTANT_MODEL
// (shown in the dashboard), ASSISTANT_HEADERS (JSON, sent with ASSISTANT_URL).

import { hostname } from 'node:os';
import { answerWith } from './reply.mjs';
import { loadDotEnv } from './env.mjs';
import { startHouse } from './house.mjs';
import * as ha from './ha.mjs';

// ── configuration ─────────────────────────────────────────────────────

loadDotEnv();

const env = process.env;
const CONFIG = {
  url: (env.SUPABASE_URL ?? '').replace(/\/+$/, ''),
  anonKey: env.SUPABASE_ANON_KEY ?? env.SUPABASE_KEY ?? '',
  serviceKey: env.SUPABASE_SERVICE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  email: env.SUPABASE_EMAIL ?? '',
  password: env.SUPABASE_PASSWORD ?? '',
  owner: env.OWNER_ID ?? '',
  name: env.ASSISTANT_NAME || hostname() || 'assistant',
  model: env.ASSISTANT_MODEL ?? '',
  cmd: env.ASSISTANT_CMD ?? '',
  endpoint: env.ASSISTANT_URL ?? '',
  headers: parseJson(env.ASSISTANT_HEADERS, {}),
  historyMax: Number(env.ASSISTANT_HISTORY ?? 24),
};

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

const BEAT_MS = 10_000;     // the dashboard calls you offline after 30s
const IDLE_MS = 1_500;      // how often to look for something to answer
const FLUSH_MS = 400;       // how often a growing reply is written back

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const die = (msg) => { console.error(`\n  ${msg}\n`); process.exit(1); };

// ── talking to your assistant ─────────────────────────────────────────

const answer = answerWith({
  cmd: CONFIG.cmd,
  url: CONFIG.endpoint,
  headers: CONFIG.headers,
});

// ── --try: the adapter on its own ─────────────────────────────────────

const args = process.argv.slice(2);
const tryAt = args.indexOf('--try');
if (tryAt >= 0) {
  if (!answer) die('Set ASSISTANT_CMD or ASSISTANT_URL first — there is nothing to ask.');
  const question = args.slice(tryAt + 1).join(' ') || 'Say hello in one short sentence.';
  process.stdout.write(`\n  asking ${CONFIG.cmd || CONFIG.endpoint}\n  > ${question}\n\n`);
  let got = 0;
  await answer({
    messages: [{ role: 'user', text: question }],
    onChunk: (text) => { got += text.length; process.stdout.write(text); },
    stopped: () => false,
  }).catch((e) => die(`That failed: ${e.message}`));
  process.stdout.write(`\n\n  ${got} characters. Your assistant works — start the bridge.\n\n`);
  process.exit(0);
}

// ── Supabase over plain HTTP ──────────────────────────────────────────
// No SDK: this is one process on your own machine making six kinds of
// request, and a dependency-free script is one less thing to keep current.

if (!CONFIG.url) die('SUPABASE_URL is not set. See the comment at the top of this file.');
// Two relays share this process: your assistant, and your house. Either one
// on its own is a reason to be running — only neither is a mistake.
if (!answer && !ha.configured()) {
  die('Nothing is configured to relay.\n'
    + '  For your assistant, set ASSISTANT_CMD or ASSISTANT_URL:\n'
    + '    ASSISTANT_CMD="python my_ai.py" node bridge/bridge.mjs --try "hello"\n'
    + '  For your smart home hub, set HA_URL and HA_TOKEN:\n'
    + '    node bridge/house.mjs --try');
}

const rest = `${CONFIG.url}/rest/v1`;
const key = CONFIG.serviceKey || CONFIG.anonKey;
if (!key) die('Set SUPABASE_SERVICE_KEY, or SUPABASE_ANON_KEY with an email and password.');

let token = CONFIG.serviceKey || '';
let owner = CONFIG.owner || '';

/** Sign in as you, so the bridge works under the same row-level security. */
async function signIn() {
  if (CONFIG.serviceKey) return;
  if (!CONFIG.email || !CONFIG.password) {
    die('With the anon key, set SUPABASE_EMAIL and SUPABASE_PASSWORD too — the bridge '
      + 'signs in as you so row-level security still applies.');
  }
  const res = await fetch(`${CONFIG.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'content-type': 'application/json' },
    body: JSON.stringify({ email: CONFIG.email, password: CONFIG.password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) die(`Sign-in failed: ${body.error_description ?? body.msg ?? res.status}`);
  token = body.access_token;
  owner = body.user?.id ?? owner;
}

async function api(path, { method = 'GET', body, prefer, retry = true } = {}) {
  const res = await fetch(`${rest}${path}`, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${token || key}`,
      'content-type': 'application/json',
      ...(prefer ? { prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // An access token lasts an hour and this process runs for weeks.
  if (res.status === 401 && retry && !CONFIG.serviceKey) {
    await signIn();
    return api(path, { method, body, prefer, retry: false });
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * Whose rows these are. With the service key there is no session to read it
 * from, so it is discovered from the data the dashboard has already written
 * — and OWNER_ID is there for the first run of a brand-new account.
 */
async function findOwner() {
  if (owner) return owner;
  for (const table of ['chats', 'jobs', 'chat_messages', 'house_devices']) {
    const rows = await api(`/${table}?select=owner&limit=1`).catch(() => null);
    if (rows?.[0]?.owner) return rows[0].owner;
  }
  die('Could not work out which account to answer for. Send one message from the '
    + 'dashboard first, or set OWNER_ID to your Supabase user id.');
  return null;
}

// ── the loop ──────────────────────────────────────────────────────────

/** Say hello, so the dashboard can tell you the assistant is awake. */
async function beat() {
  await api('/assistants', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: {
      owner,
      name: CONFIG.name,
      model: CONFIG.model || null,
      last_seen: new Date().toISOString(),
    },
  }).catch((e) => log(`heartbeat failed: ${e.message}`));
}

/** The oldest message waiting for an answer, claimed so nobody else takes it. */
async function claim() {
  const queued = await api(
    '/chat_messages?role=eq.assistant&status=eq.queued&order=created_at.asc&limit=1',
  );
  const next = queued?.[0];
  if (!next) return null;

  // The status filter is the lock: a second bridge gets an empty array.
  const taken = await api(`/chat_messages?id=eq.${next.id}&status=eq.queued`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: { status: 'streaming', text: '', error: null, updated_at: new Date().toISOString() },
  });
  return taken?.[0] ?? null;
}

/** What was said before, oldest first, so the assistant has the thread. */
async function history(row) {
  const rows = await api(
    `/chat_messages?chat_id=eq.${row.chat_id}&order=created_at.asc&limit=200`,
  );
  return (rows ?? [])
    .filter((m) => String(m.id) !== String(row.id))
    .filter((m) => m.role === 'user' || m.status === 'done')
    .filter((m) => String(m.text ?? '').trim())
    .slice(-CONFIG.historyMax);
}

/** Answer one message, streaming as it goes. */
async function handle(row) {
  const asked = await history(row);
  const question = [...asked].reverse().find((m) => m.role === 'user');
  log(`answering: ${String(question?.text ?? '').slice(0, 70).replace(/\s+/g, ' ')}`);

  let text = '';
  let written = '';
  let stop = false;
  let lastFlush = 0;

  /** Push what we have so far, and find out whether you pressed stop. */
  const flush = async (force = false) => {
    if (!force && (text === written || Date.now() - lastFlush < FLUSH_MS)) return;
    written = text;
    lastFlush = Date.now();
    const rows = await api(`/chat_messages?id=eq.${row.id}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: { text, updated_at: new Date().toISOString() },
    }).catch((e) => { log(`write failed: ${e.message}`); return null; });
    // The same round trip tells us if the dashboard asked it to stop.
    if (rows?.[0]?.cancel_requested) stop = true;
  };

  let pending = Promise.resolve();
  const queueFlush = () => { pending = pending.then(() => flush()).catch(() => {}); };

  try {
    await answer({
      messages: asked,
      onChunk: (piece) => { text += piece; queueFlush(); },
      stopped: () => stop,
    });
    await pending;
    await flush(true);
    const ending = stop ? `${text}\n\n*(stopped)*` : text;
    await api(`/chat_messages?id=eq.${row.id}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: {
        text: ending || '*(it answered with nothing)*',
        status: 'done',
        cancel_requested: false,
        updated_at: new Date().toISOString(),
      },
    });
    log(stop ? 'stopped' : `done · ${text.length} characters`);
  } catch (e) {
    await api(`/chat_messages?id=eq.${row.id}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: {
        text,
        status: 'error',
        error: String(e.message ?? e).slice(0, 500),
        cancel_requested: false,
        updated_at: new Date().toISOString(),
      },
    }).catch(() => {});
    log(`failed: ${e.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await signIn();
owner = await findOwner();

log(`bridge up as "${CONFIG.name}"${CONFIG.model ? ` (${CONFIG.model})` : ''}`);
if (answer) log(`asking: ${CONFIG.cmd || CONFIG.endpoint}`);
if (answer) await beat();

const once = args.includes('--once');
if (!once && answer) setInterval(beat, BEAT_MS).unref?.();

// The house rides along in the same process, so one thing to start on the PC
// covers both and the logon task needs no changes. It keeps its own clock:
// mirroring the hub must not wait behind a long answer.
const house = ha.configured()
  ? startHouse({ api, owner, log: (...a) => log('house:', ...a), once })
  : null;
if (house) log(`house relay on ${ha.config().url}`);
else if (!answer) log('nothing to relay — set ASSISTANT_CMD or HA_URL');

// One message at a time on purpose: your assistant is one process on one
// machine, and two answers streaming at once would only fight over it.
for (;;) {
  if (!answer) {                       // a house-only bridge: nothing to claim
    if (once) break;
    await sleep(IDLE_MS);
    continue;
  }

  let row = null;
  try {
    row = await claim();
  } catch (e) {
    log(`could not look for work: ${e.message}`);
    await sleep(5_000);
    continue;
  }

  if (row) await handle(row);
  if (once && row) break;
  if (once && !row) { log('nothing waiting'); break; }
  if (!row) await sleep(IDLE_MS);
}

if (house) await house.done;
process.exit(0);
