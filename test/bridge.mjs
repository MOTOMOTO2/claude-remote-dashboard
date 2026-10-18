// Runs the real bridge against a stand-in for Supabase.
//
// bridge/reply.mjs is covered by the smoke suite against fixed strings, but
// the loop around it — claiming a message so two bridges cannot take the
// same one, streaming into the row, noticing a stop, recording a failure —
// only exists as HTTP requests. So this starts a server that answers the way
// PostgREST does, runs `bridge.mjs --once` against it as a real child
// process, and reads what it left behind.
//
//   node test/bridge.mjs

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => {
  if (cond) pass++;
  else fails.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const has = (label, haystack, needle) =>
  ok(label, String(haystack).includes(needle), `got ${JSON.stringify(String(haystack).slice(0, 160))}`);

// ── a stand-in for PostgREST ──────────────────────────────────────────
// Only the five request shapes the bridge makes, and only the `eq` filters
// it uses — but the claim really is filtered, so the lock is really tested.

function startFake({ messages, onPatch = () => {} }) {
  const state = {
    messages,
    assistants: [],
    requests: [],
  };

  const filters = (search) => [...new URLSearchParams(search)]
    .filter(([k]) => !['select', 'order', 'limit'].includes(k))
    .map(([k, v]) => [k, v.replace(/^eq\./, '')]);

  const matches = (row, pairs) =>
    pairs.every(([k, v]) => String(row[k] ?? '') === String(v));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await new Promise((resolve) => {
      let text = '';
      req.on('data', (d) => { text += d; });
      req.on('end', () => resolve(text ? JSON.parse(text) : null));
    });
    state.requests.push({ method: req.method, path: url.pathname + url.search, body });

    const send = (data, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (url.pathname === '/auth/v1/token') {
      send({ access_token: 'tok', user: { id: 'u1' } });
      return;
    }

    const table = url.pathname.replace('/rest/v1/', '');
    const where = filters(url.search);

    if (req.method === 'GET') {
      if (table === 'chats') { send([{ owner: 'u1' }]); return; }
      send(state.messages.filter((m) => matches(m, where)));
      return;
    }

    if (req.method === 'POST') {           // the heartbeat upsert
      state.assistants = [body];
      send([body]);
      return;
    }

    if (req.method === 'PATCH') {
      const hit = state.messages.filter((m) => matches(m, where));
      for (const row of hit) Object.assign(row, body);
      // The dashboard can set cancel_requested between two writes, and the
      // bridge is supposed to find out from the write's own response.
      for (const row of hit) onPatch(row, state);
      send(hit);
      return;
    }

    send([], 405);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ state, server, port: server.address().port });
    });
  });
}

const queued = (over = {}) => ({
  id: 7, chat_id: 'c1', owner: 'u1', role: 'assistant', status: 'queued',
  text: '', error: null, cancel_requested: false, created_at: new Date().toISOString(),
  ...over,
});

const asked = {
  id: 6, chat_id: 'c1', owner: 'u1', role: 'user', status: 'done',
  text: 'hello', created_at: new Date(Date.now() - 1000).toISOString(),
};

/** Run the real bridge once against the fake, and hand back what it did. */
async function runBridge({ messages, onPatch, cmd }) {
  const { state, server, port } = await startFake({ messages, onPatch });

  const child = spawn(process.execPath, ['bridge/bridge.mjs', '--once'], {
    cwd: root,
    env: {
      ...process.env,
      SUPABASE_URL: `http://127.0.0.1:${port}`,
      SUPABASE_ANON_KEY: 'anon',
      SUPABASE_EMAIL: 'me@example.com',
      SUPABASE_PASSWORD: 'hunter2',
      SUPABASE_SERVICE_KEY: '',
      OWNER_ID: '',
      ASSISTANT_NAME: 'jarvis',
      ASSISTANT_MODEL: 'test-brain',
      ASSISTANT_URL: '',
      ASSISTANT_CMD: cmd ?? `"${process.execPath}" bridge/example-assistant.mjs`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((r) => child.on('close', r));
  server.close();
  return { state, out, code };
}

// ── 1. the ordinary case ──────────────────────────────────────────────

const plain = await runBridge({ messages: [asked, queued()] });
const answer = plain.state.messages.find((m) => m.id === 7);

ok('the bridge exits cleanly', plain.code === 0, plain.out);
ok('it signs in and finds whose rows these are',
  plain.state.requests.some((r) => r.path.startsWith('/auth/v1/token')));
ok('it says hello so the dashboard knows it is awake',
  plain.state.assistants[0]?.name === 'jarvis', JSON.stringify(plain.state.assistants));
ok('with the model it was told to report',
  plain.state.assistants[0]?.model === 'test-brain');
ok('and a timestamp', Boolean(plain.state.assistants[0]?.last_seen));

const claim = plain.state.requests.find((r) => r.method === 'PATCH');
has('the claim is filtered on the status, so two bridges cannot both take it',
  claim.path, 'status=eq.queued');
ok('and the claim is what marks it streaming', claim.body.status === 'streaming');

ok('the reply ends up done', answer.status === 'done', answer.status);
ok('with the assistant’s words in it', answer.text.length > 20, answer.text);
has('which are the words it actually said', answer.text, 'running on your PC');
ok('and no error', !answer.error);
ok('the stop flag is left clean for next time', answer.cancel_requested === false);

ok('it read the thread before answering',
  plain.state.requests.some((r) => r.method === 'GET' && r.path.includes('chat_id=eq.c1')));

const writes = plain.state.requests.filter((r) => r.method === 'PATCH');
ok('the answer is written more than once, so it reads as typing',
  writes.length >= 3, `${writes.length} writes`);
ok('the last write is the one that finishes it',
  writes.at(-1).body.status === 'done');

// ── 2. stopping one mid-sentence ──────────────────────────────────────
// The dashboard sets cancel_requested; the bridge is told by the response
// to its own next write, which is the only round trip it was going to make
// anyway.

const cancelled = await runBridge({
  messages: [asked, queued({ id: 7 })],
  onPatch: (row) => {
    if (row.status === 'streaming' && row.text) row.cancel_requested = true;
  },
});
const halted = cancelled.state.messages.find((m) => m.id === 7);

ok('a stopped reply still finishes as done, not as a failure',
  halted.status === 'done', halted.status);
has('and says it was stopped', halted.text, '(stopped)');
ok('a stop is not recorded as an error', !halted.error);
has('the log says so too', cancelled.out, 'stopped');

// ── 3. an assistant that falls over ───────────────────────────────────

const broken = await runBridge({
  messages: [asked, queued({ id: 7 })],
  cmd: `"${process.execPath}" -e "console.error('model not found'); process.exit(4)"`,
});
const failed = broken.state.messages.find((m) => m.id === 7);

ok('a failing assistant leaves the reply in error', failed.status === 'error', failed.status);
has('with what it said on stderr', failed.error, 'model not found');
has('and the exit code', failed.error, 'exited 4');
ok('the bridge itself survives it', broken.code === 0, broken.out);

// ── 4. nothing to do ──────────────────────────────────────────────────

const idle = await runBridge({ messages: [asked] });
has('with no queued reply it says so and stops', idle.out, 'nothing waiting');
ok('and still checked in first', idle.state.assistants.length === 1);

// ── report ────────────────────────────────────────────────────────────

console.log(`\n  ${pass} bridge checks passed`);
if (fails.length) {
  console.error(`  ${fails.length} failed:\n`);
  for (const f of fails) console.error(`   ✗ ${f}`);
  process.exit(1);
}
console.log('  the loop holds\n');
process.exit(0);
