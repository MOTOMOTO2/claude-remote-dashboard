// The cloud runner, tested the way the bridge is: the real code, against
// stand-ins for everything it talks to.
//
//   - host/memory.mjs and host/dispatch.mjs's `plan`, against fixed inputs;
//   - `dispatch`, against an in-memory PostgREST and a stand-in for Vercel
//     Sandbox, so claiming and starting are tested without Vercel;
//   - host/runner.mjs as a real child process, against the same PostgREST,
//     with test/fake-claude.mjs as `claude` and a bare git repository on
//     disk as GitHub — so a job really is cloned, committed and pushed;
//   - api/runner.js's handlers, for who may wake it.
//
//   node test/host.mjs

import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  slugify, jobPrompt, historyBlock, describeTool, usageRow, resumeAt, hitLimit, lostSession,
  chatPrompt, jobSystemPrompt, chatSystemPrompt, seedMemory,
} from '../host/memory.mjs';
import { claudeArgs } from '../host/claude.mjs';
import { plan, dispatch, overCap, localOnly, sandboxName, uniqueSlug, awakePc } from '../host/dispatch.mjs';
import { runnerEnv, runnerSource, makeSandboxes, BOOT } from '../host/sandboxes.mjs';
import { gitAuthEnv } from '../host/git.mjs';
import { fleet } from '../fleet.js';
import { replyState } from '../assistant.js';

const root = fileURLToPath(new URL('..', import.meta.url));

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => {
  if (cond) pass++;
  else fails.push(`${label}${detail ? ` — ${detail}` : ''}`);
};
const has = (label, haystack, needle) =>
  ok(label, String(haystack).includes(needle), `got ${JSON.stringify(String(haystack).slice(0, 200))}`);
const lacks = (label, haystack, needle) =>
  ok(label, !String(haystack).includes(needle), `found ${JSON.stringify(needle)}`);

// ── memory: the words Claude is given ─────────────────────────────────

ok('a prompt becomes a short name', slugify('Build me a pomodoro timer with dark mode') === 'pomodoro-timer-dark-mode',
  slugify('Build me a pomodoro timer with dark mode'));
ok('punctuation and filler go', slugify('Please make a simple CLI, for notes!') === 'cli-notes', slugify('Please make a simple CLI, for notes!'));
ok('nothing usable falls back', slugify('make a') === 'project');

has('a job is told nobody can answer', jobSystemPrompt({ slug: 'a' }), 'cannot answer questions');
has('a job is told to keep CLAUDE.md', jobSystemPrompt({ slug: 'a' }), 'create or update CLAUDE.md');
has('a job is told to verify', jobSystemPrompt({ slug: 'a' }), 'Never say something works unless you saw it work');
has('a new project is told it is new', jobSystemPrompt({ slug: 'x', isNew: true }), 'brand-new project called "x"');
lacks('an old project is not', jobSystemPrompt({ slug: 'x' }), 'brand-new');
has('today is given for the dated log', jobSystemPrompt({ slug: 'x', today: '2026-11-23' }), 'today is 2026-11-23');

const past = [
  { prompt: 'Add a login page', status: 'done', result: 'Added /login with email + password.', created_at: '2026-11-01T10:00:00Z' },
  { prompt: 'Fix the tests', status: 'error', error: 'npm test exited 1', created_at: '2026-11-02T10:00:00Z' },
];
const h = historyBlock(past);
has('history says what was asked', h, 'Add a login page');
has('history says what came of it', h, 'Added /login');
has('history says what failed and why', h, 'It failed: npm test exited 1');
ok('history is oldest first', h.indexOf('login page') < h.indexOf('Fix the tests'));
ok('no history is no block', historyBlock([]) === '');

const fresh = jobPrompt({ prompt: 'Make it blue', past });
has('a fresh run gets the history', fresh, 'Earlier requests on this project');
ok('and ends with the request', fresh.endsWith('New request:\nMake it blue'));
const resumed = jobPrompt({ prompt: 'Make it blue', past, resumed: true });
lacks('a resumed run is not re-told its history', resumed, 'Earlier requests');
has('a resumed run is warned the repo may have moved', resumed, 'git log');
ok('a resumed run still ends with the request', resumed.endsWith('Make it blue'));
has('a continued run carries on', jobPrompt({ prompt: 'x', continuing: true }), 'Carry on');

ok('an edit names the file, not the sandbox path', describeTool('Edit', { file_path: '/vercel/work/alpha/src/app.js' }) === 'Edit src/app.js',
  describeTool('Edit', { file_path: '/vercel/work/alpha/src/app.js' }));
ok('a command is shown as one', describeTool('Bash', { command: 'npm  test\n' }) === '$ npm test');
has('a subagent says what it is for', describeTool('Agent', { description: 'review the diff' }), 'review the diff');

const u = usageRow({ rateLimitType: 'five_hour', utilization: 0.427, resetsAt: 1_800_000_000 }, 0);
ok('utilization becomes a percentage', u.pct === 43, JSON.stringify(u));
ok('the reset becomes a time', u.resets_at === new Date(1_800_000_000_000).toISOString());
ok('a percentage stays one', usageRow({ rateLimitType: 'seven_day', utilization: 80 }).pct === 80);
ok('no window, no row', usageRow({ utilization: 0.5 }) === null);
ok('a reset in the future is waited for', resumeAt({ resetsAt: 2_000_000 }, 1_000_000_000) === new Date(2_000_060_000).toISOString());
ok('no reset waits half an hour', resumeAt(null, 0) === new Date(30 * 60_000).toISOString());
ok('the limit message is a limit', hitLimit('Claude AI usage limit reached|1700000000'));
ok('so is the newer wording', hitLimit("You've hit your limit · resets 3pm"));
ok('a test failure is not', !hitLimit('npm test exited 1'));
ok('a missing session is spotted', lostSession('No conversation found with session ID: abc'));

const chat = [
  { role: 'user', text: 'What is running?' },
  { role: 'assistant', text: 'Two agents.', status: 'done' },
  { role: 'user', text: 'Stop the second one' },
];
ok('a resumed chat sends only the new message', chatPrompt({ messages: chat, resumed: true }) === 'Stop the second one');
const freshChat = chatPrompt({ messages: chat });
has('a fresh chat is handed the thread', freshChat, 'You: Two agents.');
ok('and ends with the new message', freshChat.endsWith('Their new message:\nStop the second one'));
ok('a first message is just the message', chatPrompt({ messages: [chat[0]] }) === 'What is running?');
has('the assistant is told to queue, not edit', chatSystemPrompt({}), 'queue it with queue_job');
has('the assistant keeps its memory in CLAUDE.md', chatSystemPrompt({}), 'long-term memory');
has('the memory file starts with who it works for', seedMemory({ owner: 'Sam', github: 'sam' }), 'I work for Sam');

// ── the flags Claude Code is started with ─────────────────────────────

const flags = claudeArgs({ resume: 's1', effort: 'xhigh', systemFile: '/tmp/s.md', partial: true });
for (const f of ['-p', 'stream-json', '--verbose', 'bypassPermissions', '--include-partial-messages']) {
  ok(`claude is started with ${f}`, flags.includes(f));
}
ok('a session is resumed by id', flags[flags.indexOf('--resume') + 1] === 's1');
ok('the effort is passed through', flags[flags.indexOf('--effort') + 1] === 'xhigh');
ok('an unknown effort is not', !claudeArgs({ effort: 'extreme' }).includes('--effort'));
ok('never bare: bare skips CLAUDE.md and the subscription', !flags.includes('--bare'));

// ── what to start ─────────────────────────────────────────────────────

const NOW = Date.parse('2026-11-23T12:00:00Z');
const at = (min) => new Date(NOW + min * 60_000).toISOString();
const J = (id, o = {}) => ({ id, status: 'queued', project_slug: `p${id}`, created_at: at(-100 + Number(id)), usage_cap_pct: 90, ...o });

let pl = plan({ jobs: [J(1), J(2), J(3), J(4)], max: 3, now: NOW });
ok('the ceiling holds', pl.start.length === 3 && pl.skipped[0].why === 'slot', JSON.stringify(pl.skipped));
ok('oldest first', pl.start.map((j) => j.id).join() === '1,2,3');

pl = plan({ jobs: [J(1, { status: 'running', project_slug: 'a' }), J(2, { project_slug: 'a' }), J(3)], max: 3, now: NOW });
ok('one agent per project', pl.start.map((j) => j.id).join() === '3' && pl.skipped[0].why === 'project');

pl = plan({ jobs: [J(1, { project_slug: 'mine' })], projects: [{ name: 'mine', is_local: true, full_name: null }], now: NOW });
ok('a PC-only folder is left for the PC', !pl.start.length && pl.skipped[0].why === 'pc-only');
ok('a project on GitHub too is not PC-only', !localOnly([{ name: 'x', is_local: true }, { name: 'x', full_name: 'me/x' }]).has('x'));

const hot = [{ window_type: 'five_hour', pct: 95, resets_at: at(60) }];
pl = plan({ jobs: [J(1)], usage: hot, now: NOW });
ok('over the cap waits', !pl.start.length && pl.skipped[0].why === 'cap');
ok('a cap of 100 is no cap', plan({ jobs: [J(1, { usage_cap_pct: 100 })], usage: hot, now: NOW }).start.length === 1);
ok('a window that has reset does not count', !overCap(90, [{ pct: 99, resets_at: at(-1) }], NOW));

pl = plan({
  jobs: [J(1, { status: 'paused', claimed_by: 'cloud', resume_at: at(-1) }),
    J(2, { status: 'paused', claimed_by: 'cloud', resume_at: at(30) }),
    J(3, { status: 'paused', claimed_by: 'DESKTOP', resume_at: at(-1) })],
  now: NOW,
});
ok('a due pause of ours is resumed', pl.resume.map((j) => j.id).join() === '1');

ok('a waiting reply with nobody answering starts the Ask sandbox', plan({ waiting: 1, now: NOW }).chat);
ok('not when Claude is already answering', !plan({ waiting: 1, assistant: { name: 'Claude', last_seen: at(-0.1) }, now: NOW }).chat);
ok('a PC assistant does not count as Claude', plan({ waiting: 1, assistant: { name: 'DESKTOP', last_seen: at(-0.1) }, now: NOW }).chat);
ok('nothing waiting, nothing started', !plan({ waiting: 0, now: NOW }).chat);

// Your PC first: while it is awake, new jobs are its, as they always were.
pl = plan({ jobs: [J(1), J(2)], pcAwake: true, now: NOW });
ok('with the PC awake, the cloud starts no new job', !pl.start.length);
ok('and says it left them for the PC', pl.skipped.every((x) => x.why === 'pc'));
pl = plan({
  jobs: [J(1), J(2, { status: 'paused', claimed_by: 'cloud', resume_at: at(-1) })],
  pcAwake: true, now: NOW,
});
ok('a job the cloud already started still finishes in the cloud', pl.resume.map((j) => j.id).join() === '2');
ok('an awake PC still gets the Ask tab answered by Claude', plan({ waiting: 1, pcAwake: true, now: NOW }).chat);

ok('a PC that checked in 10s ago is awake', awakePc([{ name: 'DESKTOP', last_seen: at(-10 / 60) }], 'cloud', NOW)?.name === 'DESKTOP');
ok('one that checked in a minute ago is not', !awakePc([{ name: 'DESKTOP', last_seen: at(-1) }], 'cloud', NOW));
ok('the cloud\'s own heartbeat is never the PC', !awakePc([{ name: 'cloud', last_seen: at(-0.05) }], 'cloud', NOW));

ok('sandbox names are prefixed', sandboxName('alpha') === 'cr-job-alpha');
ok('a taken name gets a number', await uniqueSlug('todo app', { taken: async (s) => s === 'todo-app' }) === 'todo-app-2');

// ── how the dashboard words a runner that sleeps ──────────────────────

const q = [{ id: 1, status: 'queued', project_slug: 'a', created_at: at(-1) }];
ok('with no cloud runner, nothing online means waiting for the desktop',
  fleet({ jobs: q }).waiting[0].reason === 'host');
ok('with one, it means starting in the cloud', fleet({ jobs: q, wakes: true }).waiting[0].reason === 'wake');
ok('and it still takes its slot', fleet({ jobs: q, wakes: true }).waiting.length === 1);
const pendingReply = { role: 'assistant', status: 'queued' };
ok('a reply with Claude asleep is "starting Claude"',
  replyState({ message: pendingReply, online: false, known: true, wakes: true }).kind === 'waking');
ok('even before Claude has ever checked in',
  replyState({ message: pendingReply, online: false, known: false, wakes: true }).kind === 'waking');
ok('without the cloud it is still "waiting for your PC"',
  replyState({ message: pendingReply, online: false, known: true }).kind === 'offline');
ok('a reply being written is still typing', replyState({ message: { ...pendingReply, status: 'streaming' }, wakes: true }).kind === 'typing');

// ── the sandbox's environment ─────────────────────────────────────────

const renv = runnerEnv({ SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'k', GH_TOKEN: 'gh', VERCEL_TOKEN: 'nope', PATH: '/x' });
ok('the runner gets what it needs', renv.SUPABASE_SERVICE_KEY === 'k' && renv.GH_TOKEN === 'gh');
ok('and nothing else of the function', !renv.VERCEL_TOKEN && !renv.PATH);
ok('git can reach GitHub', renv.GIT_CONFIG_VALUE_0 === gitAuthEnv('gh').GIT_CONFIG_VALUE_0);
ok('the runner comes from the deployed commit', runnerSource({ VERCEL_GIT_REPO_OWNER: 'o', VERCEL_GIT_REPO_SLUG: 'r', VERCEL_GIT_COMMIT_SHA: 'abc' }).ref === 'abc');
has('the boot script runs the runner', BOOT, 'node host/runner.mjs');

// ── PostgREST, in memory ──────────────────────────────────────────────

function startFake(seed = {}) {
  const keys = { assistants: 'owner', hosts: 'name', usage_windows: 'window_type' };
  const db = {
    jobs: [], job_events: [], projects: [], usage_windows: [], hosts: [], settings: [],
    chats: [], chat_messages: [], assistants: [], ...structuredClone(seed),
  };
  let nextId = 1000;
  const requests = [];

  const parse = (search) => {
    const q = new URLSearchParams(search);
    const filters = [];
    let order = null;
    let limit = null;
    for (const [k, v] of q) {
      if (k === 'select') continue;
      if (k === 'order') { order = v; continue; }
      if (k === 'limit') { limit = Number(v); continue; }
      const m = v.match(/^(eq|neq|in|lte|gte|lt|gt|is)\.(.*)$/s);
      if (m) filters.push([k, m[1], m[2]]);
    }
    return { filters, order, limit };
  };
  const test = (row, [k, op, v]) => {
    const val = row[k];
    if (op === 'eq') return String(val ?? '') === v;
    if (op === 'neq') return String(val ?? '') !== v;
    if (op === 'is') return v === 'null' ? val == null : String(val) === v;
    if (op === 'in') return v.replace(/^\(|\)$/g, '').split(',').includes(String(val));
    const a = Date.parse(val) || Number(val);
    const b = Date.parse(v) || Number(v);
    return { lte: a <= b, gte: a >= b, lt: a < b, gt: a > b }[op];
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let text = '';
    for await (const d of req) text += d;
    const body = text ? JSON.parse(text) : null;
    requests.push({ method: req.method, path: url.pathname + url.search, body, prefer: req.headers.prefer });
    const send = (data, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };

    if (url.pathname === '/auth/v1/user') {
      const tok = (req.headers.authorization ?? '').replace('Bearer ', '');
      if (tok === 'owner-token') return send({ id: 'u1' });
      if (tok === 'stranger-token') return send({ id: 'u2' });
      return send({ msg: 'bad jwt' }, 401);
    }

    const table = url.pathname.replace('/rest/v1/', '');
    if (!db[table]) return send({ code: 'PGRST205', message: `no table ${table}` }, 404);
    const { filters, order, limit } = parse(url.search);
    const hit = (r) => filters.every((f) => test(r, f));
    const wantRows = String(req.headers.prefer ?? '').includes('return=representation');

    if (req.method === 'GET') {
      let rows = db[table].filter(hit);
      if (order) {
        const [col, dir] = order.split('.');
        rows = [...rows].sort((a, b) => String(a[col] ?? '').localeCompare(String(b[col] ?? '')) * (dir === 'desc' ? -1 : 1));
      }
      if (limit != null) rows = rows.slice(0, limit);
      return send(rows);
    }
    if (req.method === 'PATCH') {
      if (table === 'jobs' && body.status === 'cancelled' && seed.noCancelled) {
        return send({ message: 'violates check constraint' }, 400);
      }
      const rows = db[table].filter(hit);
      for (const r of rows) Object.assign(r, body);
      return send(wantRows ? rows : undefined, wantRows ? 200 : 204);
    }
    if (req.method === 'POST') {
      const list = Array.isArray(body) ? body : [body];
      const upsert = String(req.headers.prefer ?? '').includes('merge-duplicates');
      const out = [];
      for (const row of list) {
        const key = keys[table];
        const existing = upsert && key ? db[table].find((r) => r[key] === row[key]) : null;
        if (existing) { Object.assign(existing, row); out.push(existing); continue; }
        const made = { id: nextId++, ...row };
        db[table].push(made);
        out.push(made);
      }
      return send(wantRows ? out : undefined, wantRows ? 201 : 201);
    }
    return send({ message: 'unsupported' }, 405);
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ db, requests, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
  }));
}

/** The callback api/runner.js would answer; records what the runner asked for. */
function startCallback() {
  const calls = [];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const d of req) text += d;
    calls.push({ auth: req.headers.authorization, body: JSON.parse(text || '{}') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ calls, url: `http://127.0.0.1:${server.address().port}/api/runner`, close: () => server.close() });
  }));
}

// ── dispatch, with a stand-in for Vercel Sandbox ──────────────────────

function fakeSandboxes({ fail = false, states = {} } = {}) {
  const started = [];
  return {
    started,
    async startJob(o) { if (fail) throw new Error('quota exceeded'); started.push({ kind: 'job', ...o }); },
    async startChat() { started.push({ kind: 'chat' }); },
    async status(name) { return states[name] ?? 'running'; },
  };
}

{
  const fake = await startFake({
    jobs: [
      { id: 'a', owner: 'u1', status: 'queued', mode: 'new', project_slug: null, prompt: 'Build a todo app', created_at: at(-3), usage_cap_pct: 90 },
      { id: 'b', owner: 'u1', status: 'queued', mode: 'existing', project_slug: 'alpha', prompt: 'x', created_at: at(-2), usage_cap_pct: 90 },
      { id: 'c', owner: 'u1', status: 'queued', mode: 'existing', project_slug: 'alpha', prompt: 'y', created_at: at(-1), usage_cap_pct: 90 },
      { id: 'z', owner: 'u2', status: 'queued', mode: 'existing', project_slug: 'theirs', prompt: 'z', created_at: at(-1), usage_cap_pct: 90 },
    ],
    projects: [{ name: 'todo-app', full_name: 'me/todo-app' }],
    chat_messages: [{ id: 1, owner: 'u1', role: 'assistant', status: 'queued' }],
  });
  const api = (await import('../bridge/env.mjs')).connect({ SUPABASE_URL: fake.url, SUPABASE_SERVICE_KEY: 'svc', OWNER_ID: 'u1' }).api;
  const sbx = fakeSandboxes();
  const did = await dispatch({ api, owner: 'u1', sandboxes: sbx, now: () => NOW });
  const a = fake.db.jobs.find((j) => j.id === 'a');
  ok('a new project is named, avoiding a taken name', a.project_slug === 'todo-app-2', a.project_slug);
  ok('it is claimed by the cloud', a.status === 'running' && a.claimed_by === 'cloud');
  ok('the second job on a project waits', fake.db.jobs.find((j) => j.id === 'c').status === 'queued');
  ok('another account\'s job is not touched', fake.db.jobs.find((j) => j.id === 'z').status === 'queued');
  ok('each started job got its sandbox', sbx.started.filter((s) => s.kind === 'job').map((s) => s.slug).join() === 'todo-app-2,alpha',
    JSON.stringify(sbx.started));
  ok('a waiting reply starts the Ask sandbox', did.chat && sbx.started.some((s) => s.kind === 'chat'));

  // A wake while another is mid-way: the claim is the lock.
  const again = await dispatch({ api, owner: 'u1', sandboxes: sbx, now: () => NOW });
  ok('a second wake starts nothing twice', again.started.length === 0, JSON.stringify(again.started));
  fake.close();
}

{
  // The dispatcher reads the same heartbeats the dashboard does.
  const queuedJob = { id: 'p1', owner: 'u1', status: 'queued', mode: 'existing', project_slug: 'alpha', prompt: 'x', created_at: at(-1), usage_cap_pct: 90 };
  const fake = await startFake({
    jobs: [queuedJob],
    hosts: [{ name: 'DESKTOP', last_seen: new Date(NOW - 5_000).toISOString() }, { name: 'cloud', last_seen: at(-60) }],
  });
  const api = (await import('../bridge/env.mjs')).connect({ SUPABASE_URL: fake.url, SUPABASE_SERVICE_KEY: 'svc' }).api;
  const sbx = fakeSandboxes();
  let did = await dispatch({ api, owner: 'u1', sandboxes: sbx, now: () => NOW });
  ok('with your PC awake, the job is left for it', fake.db.jobs[0].status === 'queued' && !sbx.started.length);
  ok('and the dispatcher says which PC, and which jobs', did.pc === 'DESKTOP' && did.leftForPc.join() === 'p1', JSON.stringify(did));

  did = await dispatch({ api, owner: 'u1', sandboxes: sbx, now: () => NOW + 60_000 });
  ok('once the PC has gone quiet, the cloud takes it', fake.db.jobs[0].status === 'running' && sbx.started.length === 1,
    JSON.stringify(did));
  ok('and nothing is left for a PC that is not there', !did.pc && !did.leftForPc.length);

  fake.db.jobs[0] = { ...queuedJob, id: 'p2' };
  fake.db.hosts = [{ name: 'DESKTOP', last_seen: new Date(NOW - 5_000).toISOString() }];
  did = await dispatch({ api, owner: 'u1', sandboxes: fakeSandboxes(), pcFirst: false, now: () => NOW });
  ok('PC_FIRST=0 sends everything to the cloud', did.started.length === 1);
  fake.close();
}

{
  const fake = await startFake({
    jobs: [{ id: 'q', owner: 'u1', status: 'queued', mode: 'existing', project_slug: 'alpha', prompt: 'x', created_at: at(-1), usage_cap_pct: 90 }],
  });
  const api = (await import('../bridge/env.mjs')).connect({ SUPABASE_URL: fake.url, SUPABASE_SERVICE_KEY: 'svc' }).api;
  await dispatch({ api, owner: 'u1', sandboxes: fakeSandboxes({ fail: true }), now: () => NOW });
  const q = fake.db.jobs[0];
  ok('a sandbox that will not start puts the job back', q.status === 'queued' && q.claimed_by === null);
  has('and says why on its log', fake.db.job_events.map((e) => e.text).join(), 'could not start a sandbox: quota exceeded');
  fake.close();
}

{
  const fake = await startFake({
    jobs: [
      { id: 'd1', owner: 'u1', status: 'running', claimed_by: 'cloud', claimed_at: at(-10), project_slug: 'alpha', session_id: 's-9', created_at: at(-11) },
      { id: 'd2', owner: 'u1', status: 'running', claimed_by: 'cloud', claimed_at: at(-10), project_slug: 'beta', created_at: at(-11) },
      { id: 'd3', owner: 'u1', status: 'running', claimed_by: 'DESKTOP', claimed_at: at(-10), project_slug: 'gamma', created_at: at(-11) },
    ],
  });
  const api = (await import('../bridge/env.mjs')).connect({ SUPABASE_URL: fake.url, SUPABASE_SERVICE_KEY: 'svc' }).api;
  const sbx = fakeSandboxes({ states: { 'cr-job-alpha': 'stopped', 'cr-job-beta': 'failed', 'cr-job-gamma': 'stopped' } });
  const did = await dispatch({ api, owner: 'u1', sandboxes: sbx, now: () => NOW });
  ok('a dead sandbox with a session is picked back up', did.resumed.includes('d1') && sbx.started.some((s) => s.jobId === 'd1' && s.continuing));
  ok('one with no session starts over', did.started.some((s) => s.id === 'd2'));
  ok('the PC\'s jobs are the PC\'s business', fake.db.jobs.find((j) => j.id === 'd3').status === 'running');
  fake.close();
}

// ── the runner, for real, in a child process ──────────────────────────

const tmp = mkdtempSync(join(tmpdir(), 'host-test-'));
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
};
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// "GitHub": a bare repository with one commit in it.
mkdirSync(join(tmp, 'remote'), { recursive: true });
sh('git', ['init', '-q', '--bare', '-b', 'main', join(tmp, 'remote', 'alpha.git')]);
sh('git', ['clone', '-q', join(tmp, 'remote', 'alpha.git'), join(tmp, 'seed')]);
writeFileSync(join(tmp, 'seed', 'README.md'), '# alpha\n');
sh('git', ['add', '-A'], join(tmp, 'seed'));
sh('git', ['commit', '-q', '-m', 'first'], join(tmp, 'seed'));
sh('git', ['push', '-q', 'origin', 'HEAD:main'], join(tmp, 'seed'));

const claudeLog = join(tmp, 'claude.jsonl');
const calls = () => (existsSync(claudeLog)
  ? readFileSync(claudeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function runRunner(fake, cb, args, extra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'host', 'runner.mjs'), ...args], {
      env: {
        ...gitEnv,
        HOME: join(tmp, 'home'),
        SUPABASE_URL: fake.url,
        SUPABASE_SERVICE_KEY: 'svc',
        OWNER_ID: 'u1',
        OWNER_NAME: 'Sam',
        GH_TOKEN: 'gh-test',
        GITHUB_OWNER: 'me',
        GITHUB_API: 'http://127.0.0.1:9',
        REPO_URL: `file://${join(tmp, 'remote')}/{name}.git`,
        CLAUDE_BIN: join(root, 'test', 'fake-claude.mjs'),
        FAKE_CLAUDE_LOG: claudeLog,
        RUNNER_CALLBACK: cb.url,
        RUNNER_SECRET: 'shh',
        SANDBOX_NAME: 'cr-job-alpha',
        WATCH_MS: '200',
        ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

const job = (id, o = {}) => ({
  id, owner: 'u1', status: 'running', claimed_by: 'cloud', mode: 'existing', project_slug: 'alpha',
  prompt: `Request ${id}`, effort: 'high', usage_cap_pct: 90, repo_visibility: 'none',
  created_at: at(Number(id.replace(/\D/g, '') || 0)), ...o,
});

try {
  const fake = await startFake({
    projects: [{ name: 'alpha', full_name: 'me/alpha', is_local: false }],
    jobs: [
      job('j0', { status: 'done', prompt: 'Add a login page', created_at: at(-50) }),
      job('j1'),
      job('j2', { status: 'queued', claimed_by: null }),
    ],
    job_events: [{ id: 1, job_id: 'j0', kind: 'result', text: 'Added /login.' }],
  });
  const cb = await startCallback();

  // First job: a fresh session, handed the project's history.
  let r = await runRunner(fake, cb, ['--job', 'j1']);
  const j1 = fake.db.jobs.find((j) => j.id === 'j1');
  ok('the job finishes', j1.status === 'done', `${j1.status} ${j1.error ?? ''}\n${r.out}`);
  ok('its session is kept', /^sess-/.test(j1.session_id ?? ''), j1.session_id);
  ok('turns and cost are recorded', j1.num_turns === 4 && j1.cost_usd === 0.12);
  const ev1 = fake.db.job_events.filter((e) => e.job_id === 'j1');
  const kinds = (k) => ev1.filter((e) => e.kind === k).map((e) => e.text).join(' | ');
  has('it says where it is running', kinds('status'), 'Started in the cloud');
  has('it says what memory it had', kinds('status'), '1 earlier request for context');
  has('tool calls become activity lines', kinds('tool'), 'Edit feature.txt');
  has('a subagent\'s call is marked', kinds('tool'), '↳ $ npm test');
  has('Claude\'s words are logged', kinds('assistant'), 'Looking at the project.');
  has('the summary is the result', kinds('result'), 'Added the feature.');
  has('it says it pushed', kinds('status'), 'Pushed to main');

  const c1 = calls().at(-1);
  has('the first run was told the history', c1.stdin, 'Add a login page');
  has('and what came of it', c1.stdin, 'Added /login.');
  ok('and was not resumed', !c1.args.includes('--resume'));
  ok('it runs in the project\'s clone', c1.cwd.endsWith(join('work', 'alpha')), c1.cwd);
  ok('the effort was passed', c1.args[c1.args.indexOf('--effort') + 1] === 'high');
  ok('the job is not handed the database key', !c1.hasSupabase);
  ok('nor the raw GitHub token', !c1.hasGhToken && c1.hasGitAuth);

  const pushed = sh('git', ['--git-dir', join(tmp, 'remote', 'alpha.git'), 'log', '--format=%s', 'main']);
  has('the work reached "GitHub"', pushed, 'work');
  has('so did what Claude left uncommitted', pushed, 'Work from the dashboard: Request j1');
  const files = sh('git', ['--git-dir', join(tmp, 'remote', 'alpha.git'), 'ls-tree', '--name-only', 'main']);
  has('CLAUDE.md went with it', files, 'CLAUDE.md');

  ok('usage was written from the stream', fake.db.usage_windows.some((w) => w.window_type === 'five_hour' && w.pct === 42),
    JSON.stringify(fake.db.usage_windows));
  ok('the runner heartbeats as the cloud', fake.db.hosts.some((h) => h.name === 'cloud'));
  ok('it rang back to be stopped', cb.calls.at(-1)?.body.action === 'done' && cb.calls.at(-1)?.body.sandbox === 'cr-job-alpha');
  ok('with the secret', cb.calls.at(-1)?.auth === 'Bearer shh');

  // Second job on the same project: the same session carries on.
  r = await runRunner(fake, cb, ['--job', 'j2']);
  const j2 = fake.db.jobs.find((j) => j.id === 'j2');
  ok('a queued job is claimed by the runner itself', j2.status === 'done' && j2.claimed_by === 'cloud', `${j2.status}\n${r.out}`);
  const c2 = calls().at(-1);
  ok('the follow-up resumes the last session', c2.args[c2.args.indexOf('--resume') + 1] === j1.session_id, JSON.stringify(c2.args));
  has('and is told the repo may have moved', c2.stdin, 'A new request from the dashboard');
  has('it says it is continuing', fake.db.job_events.filter((e) => e.job_id === 'j2').map((e) => e.text).join(), 'Continuing this project\'s last session');

  // A session the machine has lost: start fresh, with the history.
  fake.db.jobs.push(job('j3'));
  r = await runRunner(fake, cb, ['--job', 'j3'], { FAKE_MODE: 'lost' });
  const j3 = fake.db.jobs.find((j) => j.id === 'j3');
  ok('a lost session falls back to a fresh one', j3.status === 'done', `${j3.status} ${j3.error}\n${r.out}`);
  has('and says so', fake.db.job_events.filter((e) => e.job_id === 'j3').map((e) => e.text).join(), 'That session is gone');
  has('the fresh run still knows the history', calls().at(-1).stdin, 'Request j2');

  // Stop from the dashboard.
  fake.db.jobs.push(job('j4'));
  const stopping = runRunner(fake, cb, ['--job', 'j4'], { FAKE_MODE: 'hang' });
  setTimeout(() => { fake.db.jobs.find((j) => j.id === 'j4').cancel_requested = true; }, 1200);
  r = await stopping;
  const j4 = fake.db.jobs.find((j) => j.id === 'j4');
  ok('a stop from the dashboard stops it', j4.status === 'cancelled', `${j4.status}\n${r.out}`);
  ok('and clears the request', j4.cancel_requested === false);

  // The subscription says no.
  fake.db.jobs.push(job('j5'));
  r = await runRunner(fake, cb, ['--job', 'j5'], { FAKE_MODE: 'limit' });
  const j5 = fake.db.jobs.find((j) => j.id === 'j5');
  ok('a usage limit pauses rather than fails', j5.status === 'paused', `${j5.status} ${j5.error}\n${r.out}`);
  ok('until just after the reset', Date.parse(j5.resume_at) > Date.now() + 50 * 60_000, j5.resume_at);
  ok('the limit reached the meters', fake.db.usage_windows.find((w) => w.window_type === 'five_hour')?.pct === 100);

  // The sandbox's session is about to end: hand over to a fresh one.
  fake.db.jobs.push(job('j6'));
  r = await runRunner(fake, cb, ['--job', 'j6'], { FAKE_MODE: 'hang', DEADLINE: String(Date.now() + 2_000), STOP_BEFORE_MS: '1000' });
  const j6 = fake.db.jobs.find((j) => j.id === 'j6');
  ok('near the deadline the job is paused to continue', j6.status === 'paused' && Date.parse(j6.resume_at) <= Date.now(), `${j6.status}\n${r.out}`);
  ok('and the runner asks to be continued', cb.calls.at(-1)?.body.action === 'continue' && cb.calls.at(-1)?.body.job === 'j6');

  // A continued job resumes its own session with "carry on".
  r = await runRunner(fake, cb, ['--job', 'j6', '--continue']);
  const c6 = calls().at(-1);
  ok('a continued job resumes its session', c6.args.includes('--resume'));
  has('and is told to carry on', c6.stdin, 'Carry on');
  ok('and finishes', fake.db.jobs.find((j) => j.id === 'j6').status === 'done');

  // A brand-new project with no GitHub repo wanted.
  fake.db.jobs.push(job('n1', { mode: 'new', project_slug: 'fresh-thing', repo_visibility: 'none' }));
  r = await runRunner(fake, cb, ['--job', 'n1']);
  const n1 = fake.db.jobs.find((j) => j.id === 'n1');
  ok('a new project is built from an empty folder', n1.status === 'done', `${n1.status} ${n1.error}\n${r.out}`);
  has('and kept in the cloud when no repo was wanted', fake.db.job_events.filter((e) => e.job_id === 'n1').map((e) => e.text).join(), 'Kept in the cloud workspace only');
  has('it was told it is new', readFileSync(claudeLog, 'utf8').split('\n').filter(Boolean).at(-1), 'fresh-thing');

  // A project that only exists on the PC.
  fake.db.projects.push({ name: 'pc-thing', full_name: null, is_local: true });
  fake.db.jobs.push(job('l1', { project_slug: 'pc-thing' }));
  r = await runRunner(fake, cb, ['--job', 'l1']);
  const l1 = fake.db.jobs.find((j) => j.id === 'l1');
  ok('a PC-only project fails with a reason', l1.status === 'error' && /only on your PC/.test(l1.error), `${l1.status} ${l1.error}`);

  // ── the Ask tab ──
  fake.db.chats.push({ id: 'c1', owner: 'u1' });
  fake.db.chat_messages.push(
    { id: 1, chat_id: 'c1', owner: 'u1', role: 'user', text: 'What is running?', status: 'done', created_at: at(1) },
    { id: 2, chat_id: 'c1', owner: 'u1', role: 'assistant', text: '', status: 'queued', created_at: at(2) },
  );
  r = await runRunner(fake, cb, ['--chat'], { FAKE_MODE: 'chat', CHAT_LINGER_MIN: '0.01', SANDBOX_NAME: 'cr-ask' });
  const m2 = fake.db.chat_messages.find((m) => m.id === 2);
  ok('the reply is answered', m2.status === 'done', `${m2.status} ${m2.error ?? ''}\n${r.out}`);
  ok('text after a tool call is its own paragraph', m2.text === 'Let me check your dashboard.\n\nAll quiet.', JSON.stringify(m2.text));
  lacks('a subagent\'s words are not the answer', m2.text, 'SUBAGENT');
  const cc = calls().at(-1);
  ok('the answer streamed', cc.args.includes('--include-partial-messages'));
  ok('the Ask tab can reach the dashboard tools', cc.hasSupabase && cc.owner === 'u1');
  ok('it runs in its own folder', cc.cwd.endsWith('assistant'));
  has('its memory file was seeded', readFileSync(join(tmp, 'home', 'assistant', 'CLAUDE.md'), 'utf8'), 'I work for Sam');
  const beat = fake.db.assistants.find((a) => a.owner === 'u1');
  ok('it answers as Claude', beat?.name === 'Claude');
  ok('and says it has gone to sleep', Date.now() - Date.parse(beat.last_seen) > 60_000);
  ok('streaming wrote the row more than once', fake.requests.filter((q) => q.method === 'PATCH' && q.path.startsWith('/rest/v1/chat_messages?id=eq.2')).length >= 2);

  fake.db.chat_messages.push(
    { id: 3, chat_id: 'c1', owner: 'u1', role: 'user', text: 'Anything new?', status: 'done', created_at: at(3) },
    { id: 4, chat_id: 'c1', owner: 'u1', role: 'assistant', text: '', status: 'queued', created_at: at(4) },
  );
  r = await runRunner(fake, cb, ['--chat'], { FAKE_MODE: 'chat', CHAT_LINGER_MIN: '0.01', SANDBOX_NAME: 'cr-ask' });
  const c4 = calls().at(-1);
  ok('the next message in a thread resumes its session', c4.args.includes('--resume'), JSON.stringify(c4.args));
  ok('and sends only the new message', c4.stdin === 'Anything new?', JSON.stringify(c4.stdin));
  ok('the follow-up is answered', fake.db.chat_messages.find((m) => m.id === 4).text.endsWith('Still here.'));

  fake.close();
  cb.close();
} finally {
  await rm(tmp, { recursive: true, force: true });
}

// ── the function: who may wake it ─────────────────────────────────────

{
  const fake = await startFake({});
  const saved = { ...process.env };
  Object.assign(process.env, {
    SUPABASE_URL: fake.url, SUPABASE_SERVICE_KEY: 'svc', OWNER_ID: 'u1', RUNNER_SECRET: 'shh',
    GH_TOKEN: 'gh', CLAUDE_CODE_OAUTH_TOKEN: 'tok', RUNNER_REPO: 'https://example.invalid/r.git',
    PC_RECHECK_MS: '300',
  });
  const fn = await import('../api/runner.js');
  // Never the real thing: from a linked checkout it would reach your account.
  const tried = [];
  fn.deps.Sandbox = {
    async getOrCreate(o) { tried.push(o.name); throw new Error('no sandboxes in tests'); },
    async get() { throw new Error('404 not found'); },
  };
  const post = (body, auth) => fn.POST(new Request('https://dash.example/api/runner', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  }));

  let res = await post({ action: 'wake' });
  ok('a wake with no session is refused', res.status === 401);
  res = await post({ action: 'wake' }, 'stranger-token');
  ok('so is someone else\'s', res.status === 401);
  res = await post({ action: 'wake' }, 'owner-token');
  const body = await res.json();
  ok('yours is let in', res.status === 200 && body.configured === true, JSON.stringify(body));
  ok('and with nothing waiting starts nothing', !body.started.length && !body.chat);
  res = await post({ action: 'done', sandbox: 'cr-job-x' }, 'wrong');
  ok('a sandbox without the secret is refused', res.status === 401);

  // A job sent just as the PC fell asleep: left for it, then looked at again.
  fake.db.jobs.push({ id: 'late', owner: 'u1', status: 'queued', mode: 'existing', project_slug: 'alpha', prompt: 'x', created_at: new Date().toISOString(), usage_cap_pct: 90 });
  fake.db.hosts.push({ name: 'DESKTOP', last_seen: new Date().toISOString() });
  res = await post({ action: 'wake' }, 'owner-token');
  const left = await res.json();
  ok('a wake with the PC awake leaves the job for it', left.pc === 'DESKTOP' && left.leftForPc.includes('late'), JSON.stringify(left));
  fake.db.hosts[0].last_seen = new Date(Date.now() - 60_000).toISOString();   // the PC falls asleep
  const before = fake.requests.length;
  for (let i = 0; i < 50 && !fake.db.job_events.some((e) => e.job_id === 'late'); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  ok('the function looks again on its own', fake.requests.length > before);
  // The stand-in refuses to start anything, which proves it tried.
  ok('and, the PC gone, tries to start it in the cloud',
    tried.includes('cr-job-alpha') && fake.db.job_events.some((e) => e.job_id === 'late' && /could not start a sandbox/.test(e.text)),
    JSON.stringify({ tried, events: fake.db.job_events }));
  ok('putting it back in the queue when it cannot', fake.db.jobs.find((j) => j.id === 'late').status === 'queued');

  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  res = await fn.GET(new Request('https://dash.example/api/runner'));
  const health = await res.json();
  ok('an unfinished setup names what is missing', !health.configured && health.missing.includes('CLAUDE_CODE_OAUTH_TOKEN'));
  lacks('and never a value', JSON.stringify(health), 'svc');
  res = await fn.GET(new Request('https://dash.example/api/runner?action=cron'));
  ok('the cron needs its secret', res.status === 401);

  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  fake.close();
}

// The real SDK is wired the way the stand-in is.
{
  const seen = [];
  const Sandbox = {
    async getOrCreate(o) { seen.push(o); return { expiresAt: new Date(Date.now() + 1000), runCommand: async (c) => seen.push(c) }; },
    async get() { return { status: 'running', stop: async () => seen.push('stop') }; },
  };
  const sbx = makeSandboxes({ Sandbox, env: { RUNNER_REPO: 'r', GH_TOKEN: 'g', SUPABASE_SERVICE_KEY: 'k' }, callback: 'https://d/api/runner' });
  await sbx.startJob({ slug: 'alpha', jobId: 'j1', continuing: true });
  ok('a project\'s sandbox is persistent and named for it', seen[0].name === 'cr-job-alpha' && seen[0].persistent);
  ok('the runner is started detached', seen[1].detached === true);
  ok('with the job and --continue', seen[1].args.slice(-3).join(' ') === 'j1 --continue' || seen[1].args.slice(-2).join(' ') === 'j1 --continue',
    JSON.stringify(seen[1].args));
  ok('and its deadline', Number(seen[1].env.DEADLINE) > Date.now());
  ok('secrets go to the command, not the sandbox', !seen[0].env && seen[1].env.SUPABASE_SERVICE_KEY === 'k');
  await sbx.stop('cr-job-alpha');
  ok('a stop stops it', seen.includes('stop'));
}

const total = pass + fails.length;
if (fails.length) {
  console.log(`\n  ${pass} of ${total} host checks passed, ${fails.length} failed:\n`);
  for (const f of fails) console.log(`   ✗ ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`\n  ${pass} host checks passed\n`);
