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
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** Everything the bridge reads, pointed at the fake instead of your .env. */
const bridgeEnv = (port, cmd) => ({
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
});

/** Run the real bridge once against the fake, and hand back what it did. */
async function runBridge({ messages, onPatch, cmd }) {
  const { state, server, port } = await startFake({ messages, onPatch });

  const child = spawn(process.execPath, ['bridge/bridge.mjs', '--once'], {
    cwd: root,
    env: bridgeEnv(port, cmd),
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

// ── 5. the keeper ─────────────────────────────────────────────────────
// keep-up.mjs is what the Windows task runs. A bridge that stops has to be
// started again, and stopping the keeper has to take the bridge with it.

const until = async (cond, ms = 10_000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  return cond();
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const logAt = join(mkdtempSync(join(tmpdir(), 'keep-up-')), 'bridge.log');
const readLog = () => { try { return readFileSync(logAt, 'utf8'); } catch { return ''; } };

{
  // --once with nothing queued: every bridge it starts checks in and exits.
  const { state, server, port } = await startFake({ messages: [asked] });
  const keeper = spawn(process.execPath, ['bridge/keep-up.mjs', '--once'], {
    cwd: root,
    env: { ...bridgeEnv(port), BRIDGE_LOG: logAt, BRIDGE_RETRY_MS: '50' },
    stdio: 'ignore',
  });
  const signIns = () => state.requests.filter((r) => r.path.startsWith('/auth/v1/token')).length;
  ok('a bridge that stops is started again', await until(() => signIns() >= 3), `${signIns()} starts`);
  keeper.kill();
  await new Promise((r) => keeper.on('close', r));
  server.close();

  has('what the bridge printed ends up in the log', readLog(), 'nothing waiting');
  has('and so does the keeper saying it restarted it', readLog(), 'starting again');
}

{
  const { server, port } = await startFake({ messages: [asked] });
  const keeper = spawn(process.execPath, ['bridge/keep-up.mjs'], {
    cwd: root,
    env: { ...bridgeEnv(port), BRIDGE_LOG: logAt },
    stdio: 'ignore',
  });
  const pids = () => [...readLog().matchAll(/started the bridge \(pid (\d+)\)/g)].map((m) => Number(m[1]));
  const before = pids().length;
  await until(() => pids().length > before);
  const bridgePid = pids().at(-1);
  await until(() => readLog().includes('bridge up as'));

  keeper.kill('SIGKILL');
  await new Promise((r) => keeper.on('close', r));
  ok('killing the keeper takes the bridge with it', await until(() => !alive(bridgePid), 5_000),
    `pid ${bridgePid} still running`);
  if (alive(bridgePid)) process.kill(bridgePid);
  server.close();
}

// ── 6. the dashboard, as tools ────────────────────────────────────────
// bridge/tools.mjs is what your own assistant calls to see jobs and usage
// and to queue work. It gets a fake of its own: plain tables, `eq` filters,
// and a missing table answering the way PostgREST does.

function startTables(tables) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await new Promise((resolve) => {
      let text = '';
      req.on('data', (d) => { text += d; });
      req.on('end', () => resolve(text ? JSON.parse(text) : null));
    });
    requests.push({ method: req.method, path: url.pathname + url.search, body });
    const send = (data, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/auth/v1/token') { send({ access_token: 'tok', user: { id: 'u1' } }); return; }
    const table = url.pathname.replace('/rest/v1/', '');
    if (!tables[table]) { send({ code: 'PGRST205', message: `no table ${table}` }, 404); return; }
    if (req.method === 'POST') {
      const row = { id: `job-${tables[table].length + 1}`, status: 'queued', created_at: new Date().toISOString(), ...body };
      tables[table].push(row);
      send([row]);
      return;
    }
    const where = [...url.searchParams]
      .filter(([k]) => !['select', 'order', 'limit'].includes(k))
      .map(([k, v]) => [k, v.replace(/^eq\./, '')]);
    const limit = Number(url.searchParams.get('limit') ?? 1000);
    send(tables[table].filter((r) => where.every(([k, v]) => String(r[k] ?? '') === v)).slice(0, limit));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ requests, server, port: server.address().port }));
  });
}

async function tool(port, args, input = '') {
  const child = spawn(process.execPath, ['bridge/tools.mjs', ...args], {
    cwd: root, env: bridgeEnv(port), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.stdin.end(input);
  const code = await new Promise((r) => child.on('close', r));
  return { out, err, code };
}

{
  const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
  const tables = {
    jobs: [
      { id: 'a1', prompt: 'add dark mode', project_slug: 'hub', status: 'running', created_at: minutesAgo(3) },
      { id: 'b2', prompt: 'fix the login', project_slug: 'portfolio', status: 'error', error: 'npm install failed: ETARGET', created_at: minutesAgo(60) },
    ],
    job_events: [{ id: 1, job_id: 'b2', kind: 'tool', text: 'ran npm install' }],
    usage_windows: [{ window_type: 'five_hour', pct: 42.4, resets_at: new Date(Date.now() + 2 * 3600_000).toISOString() }],
    hosts: [{ name: 'desktop', last_seen: new Date().toISOString() }],
    projects: [{ name: 'hub', description: 'A home hub', language: 'TypeScript' }, { name: 'portfolio' }],
  };
  const { requests, server, port } = await startTables(tables);

  const listed = JSON.parse((await tool(port, ['list'])).out);
  ok('the provider lists its four tools', listed.length === 4, JSON.stringify(listed.map((t) => t.name)));
  ok('only queue_job says it acts', listed.filter((t) => t.acts).map((t) => t.name).join() === 'queue_job');

  const status = await tool(port, ['call', 'dashboard_status'], '{}');
  has('the status says whether the PC runner is up', status.out, 'PC runner: online (desktop');
  has('and what is running', status.out, 'Running (1):');
  has('and why the last failure failed', status.out, 'FAILED: npm install failed: ETARGET');
  has('with the latest failure named outright', status.out, 'Latest failure: - [b2] portfolio');
  has('and where usage stands', status.out, 'five_hour 42%');
  ok('it signed in as you rather than using a service key',
    requests.some((r) => r.path.startsWith('/auth/v1/token')));

  const details = await tool(port, ['call', 'job_details'], '{"job":"portfolio"}');
  has('a project name finds its latest job', details.out, '[b2] portfolio — error');
  has('with what it did', details.out, 'tool: ran npm install');

  const queued = await tool(port, ['call', 'queue_job'], '{"prompt":"add a contact form to the hub","project":"HUB"}');
  const row = tables.jobs.at(-1);
  ok('queue_job writes the same row the New screen does',
    row.owner === 'u1' && row.mode === 'existing' && row.project_slug === 'hub'
      && row.repo_visibility === 'none' && row.effort === 'high' && row.usage_cap_pct === 90,
    JSON.stringify(row));
  has('and says what it queued', queued.out, 'Queued job [job-3] on hub');

  const before = tables.jobs.length;
  const unknown = await tool(port, ['call', 'queue_job'], '{"prompt":"add a contact form","project":"hu"}');
  ok('a project that does not exist queues nothing', tables.jobs.length === before && unknown.code === 1);
  has('and suggests the near ones', unknown.err, 'Did you mean: hub');

  delete tables.projects;
  const none = await tool(port, ['call', 'list_projects'], '{}');
  ok('a table this account never made is "none yet", not a crash', none.code === 0, none.err);
  has('and says so', none.out, 'no projects listed yet');
  server.close();
}

// ── report ────────────────────────────────────────────────────────────

console.log(`\n  ${pass} bridge checks passed`);
if (fails.length) {
  console.error(`  ${fails.length} failed:\n`);
  for (const f of fails) console.error(`   ✗ ${f}`);
  process.exit(1);
}
console.log('  the loop holds\n');
process.exit(0);
