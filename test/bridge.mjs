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
import { rm } from 'node:fs/promises';
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

/**
 * Everything the bridge reads, pointed at the fake instead of your .env.
 * Every variable it might pick up is named here, blank if the test does not
 * want it — otherwise a real bridge/.env on this machine leaks in, and a
 * test run would talk to the actual hub in the actual house.
 */
const bridgeEnv = (port, cmd, extra = {}) => ({
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
  HA_URL: '',
  HA_TOKEN: '',
  HA_NAME: '',
  HA_SENSORS: '',
  HA_EXCLUDE: '',
  // Explicitly blank, so a developer who has these exported for their own
  // hub does not get a different test run from everybody else.
  HOUSE_RELAY: '',
  HOUSE_RELAY_HOST: '',
  HOUSE_RELAY_PRIORITY: '',
  ...extra,
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

    const where = [...url.searchParams]
      .filter(([k]) => !['select', 'order', 'limit'].includes(k))
      .map(([k, v]) => [k, v.replace(/^eq\./, '')])
      // `in.("a","b")` is the only other filter anything here writes.
      .map(([k, v]) => [k, v.startsWith('in.(')
        ? v.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, '')) : v]);
    const hit = (r) => where.every(([k, v]) => (Array.isArray(v)
      ? v.includes(String(r[k] ?? '')) : String(r[k] ?? '') === v));

    if (req.method === 'POST') {
      // A mirror writes a page of devices at once; everything else writes one.
      // The key is whatever that table's primary key is — house_hubs is one
      // row per *relay*, so two relays checking in make two rows, not one
      // they take turns overwriting.
      const rows = (Array.isArray(body) ? body : [body]).map((one) => {
        const key = one.entity_id ?? one.owner;
        const found = key && tables[table].find((r) => (one.entity_id
          ? r.entity_id === one.entity_id && r.owner === one.owner
          : r.owner === one.owner && table === 'house_hubs'
            && String(r.relay ?? '') === String(one.relay ?? '')));
        if (found) { Object.assign(found, one); return found; }
        const row = { id: `job-${tables[table].length + 1}`, status: 'queued', created_at: new Date().toISOString(), ...one };
        tables[table].push(row);
        return row;
      });
      send(rows);
      return;
    }

    if (req.method === 'PATCH') {
      const changed = tables[table].filter(hit);
      for (const r of changed) Object.assign(r, body);
      send(changed);
      return;
    }

    if (req.method === 'DELETE') {
      tables[table] = tables[table].filter((r) => !hit(r));
      send([]);
      return;
    }

    const limit = Number(url.searchParams.get('limit') ?? 1000);
    send(tables[table].filter(hit).slice(0, limit));
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
  ok('the provider lists every tool it has',
    listed.map((t) => t.name).join() === 'dashboard_status,job_details,list_projects,'
      + 'queue_job,house_status,house_control',
    JSON.stringify(listed.map((t) => t.name)));
  ok('only the two that change something say they act',
    listed.filter((t) => t.acts).map((t) => t.name).join() === 'queue_job,house_control');

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

// ── 7. the house ──────────────────────────────────────────────────────
// The hub is the one thing here that lives on another machine, so it gets a
// stand-in too: a server that answers the four Home Assistant endpoints the
// relay uses. Then the real bridge/house.mjs runs against it and the fake
// PostgREST at once, and we read what it left in both.

function startHub({ states, token = 'ha-token' }) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await new Promise((resolve) => {
      let text = '';
      req.on('data', (d) => { text += d; });
      req.on('end', () => resolve(text ? JSON.parse(text) : null));
    });
    const send = (data, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== `Bearer ${token}`) { send({ message: 'nope' }, 401); return; }

    if (url.pathname === '/api/') { send({ message: 'API running.' }); return; }
    if (url.pathname === '/api/config') {
      send({ location_name: 'The flat', version: '2025.9.1', unit_system: { temperature: '°C' } });
      return;
    }
    if (url.pathname === '/api/states') { send(states); return; }
    if (url.pathname === '/api/template') {
      // Home Assistant renders a template to plain text; ours asks for the
      // room each entity is in, one per line.
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${states.map((s) => `${s.entity_id}|${s.attributes.area ?? ''}`).join('\n')}\n`);
      return;
    }
    if (url.pathname.startsWith('/api/states/')) {
      const id = decodeURIComponent(url.pathname.replace('/api/states/', ''));
      const found = states.find((s) => s.entity_id === id);
      send(found ?? { message: 'not found' }, found ? 200 : 404);
      return;
    }
    if (url.pathname.startsWith('/api/services/')) {
      const [domain, service] = url.pathname.replace('/api/services/', '').split('/');
      calls.push({ domain, service, data: body });
      // The hub answers with what it changed, and then it has changed.
      const hit = states.find((s) => s.entity_id === body.entity_id);
      if (hit) hit.state = /off|close|lock$/.test(service) ? 'off' : 'on';
      send(hit ? [hit] : []);
      return;
    }
    send({ message: 'no such endpoint' }, 404);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ calls, server, port: server.address().port }));
  });
}

const entity = (id, state, attributes = {}) => ({ entity_id: id, state, attributes });

{
  const states = [
    entity('light.kitchen_ceiling', 'on', {
      friendly_name: 'Kitchen ceiling', area: 'Kitchen',
      brightness: 128, supported_color_modes: ['brightness'],
    }),
    entity('switch.kettle', 'off', { friendly_name: 'Kettle', area: 'Kitchen' }),
    entity('climate.hall', 'heat', {
      friendly_name: 'Hall thermostat', area: 'Hall',
      current_temperature: 19.4, temperature: 20.5, hvac_action: 'heating',
    }),
    entity('lock.front_door', 'locked', { friendly_name: 'Front door', area: 'Hall' }),
    entity('sensor.hall_temp', '19.4', {
      friendly_name: 'Hall temperature', area: 'Hall',
      device_class: 'temperature', unit_of_measurement: '°C',
    }),
    // The two a real install is full of and nobody wants a card for.
    entity('sensor.phone_wifi', '-54', { friendly_name: 'Phone wifi', device_class: 'signal_strength' }),
    entity('update.hub', 'off', { friendly_name: 'Hub update' }),
  ];
  const hub = await startHub({ states });

  const tables = {
    jobs: [{ id: 'a1', owner: 'u1', status: 'done' }],
    house_devices: [
      // Left over from a hub that no longer has it: the relay should drop it.
      { owner: 'u1', entity_id: 'light.gone', name: 'Removed lamp', state: 'off' },
    ],
    house_hubs: [],
    house_commands: [
      { id: 1, owner: 'u1', entity_id: 'light.kitchen_ceiling', name: 'Kitchen ceiling',
        action: 'off', value: null, source: 'dashboard', status: 'queued',
        created_at: new Date().toISOString() },
    ],
  };
  const { server, port } = await startTables(tables);

  const env = bridgeEnv(port, null, {
    HA_URL: `http://127.0.0.1:${hub.port}`,
    HA_TOKEN: 'ha-token',
    HA_NAME: 'the flat',
  });

  const run = (file, args = []) => new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    if (args[0] === 'call') child.stdin.end(args[2] ?? '{}');
    else child.stdin.end('');
    child.on('close', (code) => resolve({ out, err, code }));
  });

  const relay = await run('bridge/house.mjs', ['--once']);
  ok('the house relay runs to the end', relay.code === 0, relay.err || relay.out);

  const lamp = tables.house_devices.find((d) => d.entity_id === 'light.kitchen_ceiling');
  ok('a light is mirrored with its room and its brightness as a percentage',
    lamp?.area === 'Kitchen' && lamp.kind === 'light' && lamp.attrs.level === 50,
    JSON.stringify(lamp));
  // It started `on`; the queued tap turned it off, and the relay looked again
  // rather than leaving the screen showing the state it just left behind.
  ok('and re-read after obeying, so the card shows what actually happened',
    lamp?.state === 'off' && lamp.is_on === false, JSON.stringify(lamp));
  ok('a thermostat keeps both temperatures',
    tables.house_devices.find((d) => d.entity_id === 'climate.hall')?.attrs.current_temperature === 19.4);
  ok('a temperature sensor is worth a card',
    tables.house_devices.some((d) => d.entity_id === 'sensor.hall_temp'));
  ok('a wifi-strength sensor is not',
    !tables.house_devices.some((d) => d.entity_id === 'sensor.phone_wifi'));
  ok('and neither is a domain this app cannot draw',
    !tables.house_devices.some((d) => d.entity_id === 'update.hub'));
  ok('a device the hub no longer has is dropped',
    !tables.house_devices.some((d) => d.entity_id === 'light.gone'),
    JSON.stringify(tables.house_devices.map((d) => d.entity_id)));

  ok('the hub heartbeat says it answered',
    tables.house_hubs[0]?.reachable === true && tables.house_hubs[0]?.name === 'the flat'
      && tables.house_hubs[0]?.owner === 'u1',
    JSON.stringify(tables.house_hubs[0]));

  const off = hub.calls.find((c) => c.service === 'turn_off');
  ok('a queued tap becomes the Home Assistant call it means',
    off?.domain === 'light' && off.data.entity_id === 'light.kitchen_ceiling',
    JSON.stringify(hub.calls));
  ok('and the command is closed as done',
    tables.house_commands[0].status === 'done' && !tables.house_commands[0].error,
    JSON.stringify(tables.house_commands[0]));

  // ── the same house, as tools your assistant calls ──
  const status = await run('bridge/tools.mjs', ['call', 'house_status', '{}']);
  ok('house_status runs', status.code === 0, status.err);
  has('it names the hub', status.out, 'the flat');
  has('and groups by room', status.out, 'Hall');
  has('and says what the thermostat is doing', status.out, 'set 20.5°');
  has('and offers the rooms to ask about next', status.out, 'Rooms: Hall, Kitchen');

  const room = await run('bridge/tools.mjs', ['call', 'house_status', '{"room":"kitchen"}']);
  has('a room shows everything in it, on or off', room.out, 'Kettle');
  ok('and nothing from another room', !room.out.includes('Front door'), room.out);

  const before = hub.calls.length;
  const control = await run('bridge/tools.mjs',
    ['call', 'house_control', '{"device":"kitchen ceiling","action":"level","value":30}']);
  ok('house_control runs', control.code === 0, control.err);
  const dim = hub.calls.at(-1);
  ok('a brightness becomes brightness_pct on the right entity',
    hub.calls.length > before && dim.service === 'turn_on' && dim.data.brightness_pct === 30
      && dim.data.entity_id === 'light.kitchen_ceiling',
    JSON.stringify(dim));
  ok('and the dashboard is told who did it',
    tables.house_commands.some((c) => c.source === 'assistant' && c.action === 'level'
      && Number(c.value) === 30 && c.status === 'done'),
    JSON.stringify(tables.house_commands.map((c) => `${c.source}:${c.action}:${c.status}`)));

  const nothing = hub.calls.length;
  const wrong = await run('bridge/tools.mjs', ['call', 'house_control', '{"device":"kitchn","action":"on"}']);
  ok('a name that matches nothing changes nothing',
    wrong.code === 1 && hub.calls.length === nothing, wrong.out);
  has('and says what it does have', wrong.err, 'Did you mean');

  const locked = await run('bridge/tools.mjs', ['call', 'house_control', '{"device":"front door","action":"level","value":50}']);
  ok('an action a device cannot do is refused rather than posted',
    locked.code === 1 && !hub.calls.some((c) => c.domain === 'lock' && c.service === 'turn_on'),
    locked.out);

  // "Turn off the kitchen" means its lights — never the kettle.
  const kettleBefore = hub.calls.filter((c) => c.data.entity_id === 'switch.kettle').length;
  await run('bridge/tools.mjs', ['call', 'house_control', '{"room":"kitchen","action":"off"}']);
  ok('a bare room means its lights, not everything plugged in',
    hub.calls.filter((c) => c.data.entity_id === 'switch.kettle').length === kettleBefore,
    JSON.stringify(hub.calls.map((c) => c.data.entity_id)));

  hub.server.close();
  server.close();
}

{
  // The hub being off is the ordinary case, not a crash: the relay says so
  // in the heartbeat and leaves the mirror alone, so the screen can tell
  // "your PC is asleep" from "the Pi did not answer".
  const tables = {
    jobs: [{ id: 'a1', owner: 'u1', status: 'done' }],
    house_devices: [], house_hubs: [], house_commands: [],
  };
  const { server, port } = await startTables(tables);
  const dead = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['bridge/house.mjs', '--once'], {
      cwd: root,
      // Port 1 is never listening, and the timeout keeps the test honest.
      env: bridgeEnv(port, null, {
        HA_URL: 'http://127.0.0.1:1', HA_TOKEN: 'x', HA_TIMEOUT_MS: '1200', HA_NAME: 'the flat',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ out, code }));
  });
  ok('a hub that is off does not take the relay down with it', dead.code === 0, dead.out);
  has('and it says so in the log', dead.out, 'hub unreachable');
  ok('the heartbeat records the hub as unreachable, with why',
    tables.house_hubs[0]?.reachable === false && /unreachable/.test(tables.house_hubs[0]?.error ?? ''),
    JSON.stringify(tables.house_hubs[0]));
  server.close();
}

// ── 8. two relays, one house ──────────────────────────────────────────
// The setup that makes the house reachable while you are out: the add-on on
// the hub, which is always up, *and* the bridge on the PC, which is not.
// Both check in and either can obey a tap — but only one writes devices,
// because two relays with different HA_EXCLUDE settings would otherwise
// spend the evening deleting each other's rows.

{
  const states = [
    entity('light.kitchen_ceiling', 'on',
      { friendly_name: 'Kitchen ceiling', area: 'Kitchen', brightness: 128,
        supported_color_modes: ['brightness'] }),
    entity('switch.kettle', 'off', { friendly_name: 'Kettle', area: 'Kitchen' }),
  ];
  const hub = await startHub({ states });

  /** The add-on on the hub, checked in `secondsAgo` and mirroring. */
  const onHub = (secondsAgo) => ({
    owner: 'u1', relay: 'hub', host: 'hub', priority: 10, mirroring: true,
    name: 'the flat', kind: 'home-assistant', devices: 2, reachable: true,
    error: null, last_seen: new Date(Date.now() - secondsAgo * 1000).toISOString(),
  });

  const goneLamp = () => [{
    owner: 'u1', entity_id: 'light.gone', name: 'Removed lamp', state: 'off',
  }];

  const tables = {
    jobs: [{ id: 'a1', owner: 'u1', status: 'done' }],
    // Left over from a hub that no longer has it. Only the leader gets to
    // decide that a device is gone.
    house_devices: goneLamp(),
    house_hubs: [onHub(2)],
    house_commands: [
      { id: 1, owner: 'u1', entity_id: 'light.kitchen_ceiling', name: 'Kitchen ceiling',
        action: 'off', value: null, source: 'dashboard', status: 'queued',
        created_at: new Date().toISOString() },
    ],
  };
  const { server, port } = await startTables(tables);

  const runRelay = (extra = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['bridge/house.mjs', '--once'], {
      cwd: root,
      env: bridgeEnv(port, null, {
        HA_URL: `http://127.0.0.1:${hub.port}`,
        HA_TOKEN: 'ha-token',
        HA_NAME: 'the flat',
        HOUSE_RELAY: 'desktop',
        // The stand-in hub is on loopback, which is exactly how a relay
        // works out that it is running *on* the hub. These runs are meant
        // to be the one on a PC, so they say so.
        HOUSE_RELAY_HOST: 'pc',
        ...extra,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ out, code }));
  });

  // ── the PC, with the hub's own relay already mirroring ──
  const standby = await runRelay();
  ok('a second relay runs fine alongside the first', standby.code === 0, standby.out);
  has('and says it is standing by rather than pretending to lead',
    standby.out, 'standing by');

  const rows = tables.house_hubs;
  ok('each relay gets its own heartbeat row rather than overwriting one',
    rows.length === 2 && rows.some((r) => r.relay === 'hub')
      && rows.some((r) => r.relay === 'desktop'),
    JSON.stringify(rows.map((r) => r.relay)));
  const pc = rows.find((r) => r.relay === 'desktop');
  ok('the PC says where it is, and that it is not the one mirroring',
    pc.host === 'pc' && pc.priority === 0 && pc.mirroring === false && pc.reachable === true,
    JSON.stringify(pc));
  ok('and it left the hub relay row alone',
    rows.find((r) => r.relay === 'hub').mirroring === true);

  ok('a standby writes no devices of its own',
    !tables.house_devices.some((d) => d.entity_id === 'switch.kettle'),
    JSON.stringify(tables.house_devices.map((d) => d.entity_id)));
  ok('and does not get to decide that a device is gone',
    tables.house_devices.some((d) => d.entity_id === 'light.gone'),
    JSON.stringify(tables.house_devices.map((d) => d.entity_id)));

  // The one exception, and the reason it exists: your tap has to show up.
  ok('a standby still obeys the tap that was queued',
    tables.house_commands[0].status === 'done' && !tables.house_commands[0].error,
    JSON.stringify(tables.house_commands[0]));
  ok('and writes back the device it just changed, so the screen is not stale',
    tables.house_devices.find((d) => d.entity_id === 'light.kitchen_ceiling')?.state === 'off',
    JSON.stringify(tables.house_devices.map((d) => `${d.entity_id}:${d.state}`)));

  // ── the hub's relay goes away ──
  // A heartbeat older than FRESH_MS is a relay that is not there, so the PC
  // takes the mirror over rather than leaving the screen frozen.
  states[0].state = 'on';
  tables.house_hubs = [onHub(600)];
  tables.house_devices = goneLamp();
  const promoted = await runRelay();
  ok('a relay whose heartbeat went stale is stepped around', promoted.code === 0, promoted.out);
  has('and the other one says it has taken the mirror', promoted.out, 'is mirroring the house');
  ok('which means every device is written now',
    tables.house_devices.some((d) => d.entity_id === 'switch.kettle')
      && tables.house_devices.some((d) => d.entity_id === 'light.kitchen_ceiling'),
    JSON.stringify(tables.house_devices.map((d) => d.entity_id)));
  ok('and the device the hub no longer has is dropped',
    !tables.house_devices.some((d) => d.entity_id === 'light.gone'),
    JSON.stringify(tables.house_devices.map((d) => d.entity_id)));
  ok('the heartbeat now says this relay is the one mirroring',
    tables.house_hubs.find((r) => r.relay === 'desktop')?.mirroring === true,
    JSON.stringify(tables.house_hubs.map((r) => `${r.relay}:${r.mirroring}`)));

  // ── and a relay on the hub claims the mirror from a live PC ──
  // Which way round this goes matters: the hub is the one that will still be
  // there tomorrow, so it leads even when the PC got there first.
  tables.house_hubs = [{
    owner: 'u1', relay: 'desktop', host: 'pc', priority: 0, mirroring: true,
    name: 'the flat', devices: 2, reachable: true, error: null,
    last_seen: new Date().toISOString(),
  }];
  const addon = await runRelay({ HOUSE_RELAY: 'hub', HOUSE_RELAY_HOST: 'hub' });
  has('a relay on the hub takes the mirror from a live PC', addon.out, 'is mirroring the house');
  const hubRow = tables.house_hubs.find((r) => r.relay === 'hub');
  ok('and is recorded as on the hub, outranking it',
    hubRow?.host === 'hub' && hubRow?.priority === 10,
    JSON.stringify(tables.house_hubs.map((r) => `${r.relay}:${r.host}:${r.priority}`)));

  // ── loopback means "I am on the hub", with nothing to configure ──
  const guessed = await runRelay({ HOUSE_RELAY: 'guessed', HOUSE_RELAY_HOST: '' });
  const guessedRow = tables.house_hubs.find((r) => r.relay === 'guessed');
  ok('a relay reaching its hub over loopback works that out for itself',
    guessedRow?.host === 'hub', guessed.out);
  ok('and gets the priority that goes with being there, unasked',
    guessedRow?.priority === 10, JSON.stringify(guessedRow));

  hub.server.close();
  server.close();
}

// ── 9. the add-on that runs the relay on the hub ───────────────────────
// A local Home Assistant add-on is built on the hub, where the build context
// is the add-on's own folder — so the files the relay imports are copied in
// first. One left behind would build fine and crash on the Pi, so the pack
// is checked here instead of there.

{
  const { pack } = await import('../tools/pack-addon.mjs');
  const to = join(tmpdir(), `addon-pack-${process.pid}`);
  const { copied, missing } = await pack({ to, quiet: true });
  ok('packing the add-on copies the relay and the vocabulary it shares',
    copied.includes('house.js') && copied.includes('bridge/house.mjs'),
    JSON.stringify(copied));
  ok('and nothing any of them imports is left outside the copy',
    missing.length === 0, JSON.stringify(missing));

  const ran = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(to, 'bridge', 'house.mjs'), '--try'], {
      // No hub to answer, so this fails — but it has to fail *at the hub*,
      // which only happens if every import resolved first.
      env: { ...process.env, HA_URL: 'http://127.0.0.1:1', HA_TOKEN: 'x', HA_TIMEOUT_MS: '900' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ out, code }));
  });
  has('and the packed copy runs on its own', ran.out, 'unreachable');
  await rm(to, { recursive: true, force: true });
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
