// The cloud half of claude-remote: what the PC runner does, without the PC.
//
// It runs inside a Vercel Sandbox that api/runner.js started for it, and does
// one thing before it exits:
//
//   node host/runner.mjs --job <id>              run one coding job
//   node host/runner.mjs --job <id> --continue   pick a paused one back up
//   node host/runner.mjs --chat                  answer the Ask tab, then linger
//
// Each project gets its own persistent sandbox, so its clone and Claude's
// sessions are still there next time. The Ask tab has one of its own.
// Everything you see on the dashboard is written to Supabase from here, in
// the same rows and words the PC runner uses, so the dashboard cannot tell
// the two apart (and does not need to).
//
// Memory, in the order it is tried (see host/memory.mjs):
//   1. CLAUDE.md in the repo, which every job is told to keep current;
//   2. the project's last session, resumed;
//   3. the project's earlier prompts and what came of them.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, loadDotEnv, NO_TABLE } from '../bridge/env.mjs';
import { runClaude, failure } from './claude.mjs';
import { makeGit, makeGitHub, gitAuthEnv } from './git.mjs';
import {
  clip, slugify, jobSystemPrompt, jobPrompt, describeTool, usageRow, resumeAt,
  hitLimit, lostSession, chatSystemPrompt, chatPrompt, seedMemory,
} from './memory.mjs';

loadDotEnv(new URL('.env', import.meta.url));

const env = process.env;
const APP = fileURLToPath(new URL('..', import.meta.url));
const HOME = env.HOME || homedir();

const CONFIG = {
  name: env.HOST_NAME || 'cloud',
  work: env.WORK_DIR || join(HOME, 'work'),
  state: env.STATE_DIR || join(HOME, '.runner'),
  assistant: env.ASSISTANT_DIR || join(HOME, 'assistant'),
  claude: env.CLAUDE_BIN || 'claude',
  ghToken: env.GH_TOKEN || env.GITHUB_TOKEN || '',
  ghOwner: env.GITHUB_OWNER || '',
  ghApi: env.GITHUB_API || 'https://api.github.com',
  repoUrl: env.REPO_URL || 'https://github.com/{owner}/{name}.git',
  callback: env.RUNNER_CALLBACK || '',
  secret: env.RUNNER_SECRET || '',
  sandbox: env.SANDBOX_NAME || '',
  deadline: Number(env.DEADLINE || 0),
  jobModel: env.JOB_MODEL || '',
  chatModel: env.CHAT_MODEL || '',
  sessionDays: Number(env.SESSION_DAYS || 7),
  lingerMs: Number(env.CHAT_LINGER_MIN || 5) * 60_000,
  ownerName: env.OWNER_NAME || '',
  assistantName: env.ASSISTANT_NAME || 'Claude',
};

const BEAT_MS = 10_000;
const WATCH_MS = Number(env.WATCH_MS || 3_000);
const FLUSH_MS = 400;
const EVENTS_MS = 700;
// A Hobby sandbox session ends at 45 minutes. Stop a little before, while
// there is time to save the session and hand over to a fresh one.
const STOP_BEFORE_MS = Number(env.STOP_BEFORE_MS || 4 * 60_000);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();

const sb = connect(env);
const { api } = sb;
const git = makeGit({ token: CONFIG.ghToken });
const github = makeGitHub({ token: CONFIG.ghToken, api: CONFIG.ghApi });

// ── small persistent state, on the sandbox's own disk ─────────────────

mkdirSync(CONFIG.state, { recursive: true });
const statePath = (name) => join(CONFIG.state, `${name}.json`);
const readState = (name) => {
  try { return JSON.parse(readFileSync(statePath(name), 'utf8')); } catch { return {}; }
};
const writeState = (name, value) => writeFileSync(statePath(name), JSON.stringify(value, null, 2));

// ── rows ──────────────────────────────────────────────────────────────

const enc = encodeURIComponent;

async function patchJob(id, patch) {
  return api(`/jobs?id=eq.${enc(id)}`, { method: 'PATCH', prefer: 'return=minimal', body: patch });
}

/** Update a row keyed by one column, or insert it if it is not there yet. */
async function upsertBy(table, key, row) {
  const rows = await api(`/${table}?${key}=eq.${enc(row[key])}`, {
    method: 'PATCH', prefer: 'return=representation', body: row,
  });
  if (rows === NO_TABLE) return;
  if (!rows?.length) await api(`/${table}`, { method: 'POST', prefer: 'return=minimal', body: row });
}

const heartbeat = () => upsertBy('hosts', 'name', { name: CONFIG.name, last_seen: stamp() })
  .catch((e) => log(`heartbeat failed: ${e.message}`));

async function recordUsage(info) {
  const row = usageRow(info);
  if (row) await upsertBy('usage_windows', 'window_type', row).catch(() => {});
  return row;
}

/** Job log lines, batched: one insert a second rather than one per tool call. */
function eventLog(jobId) {
  let pending = [];
  let timer = null;
  const flush = async () => {
    clearTimeout(timer);
    timer = null;
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    await api('/job_events', { method: 'POST', prefer: 'return=minimal', body: batch })
      .catch((e) => log(`could not write the log: ${e.message}`));
  };
  const add = (kind, text) => {
    if (!String(text ?? '').trim()) return;
    pending.push({ job_id: jobId, kind, text: clip(text, 4000) });
    if (!timer) timer = setTimeout(flush, EVENTS_MS);
  };
  return { add, flush };
}

/** Ask the function that started this sandbox to stop it, or hand over. */
async function callHome(action, extra = {}) {
  if (!CONFIG.callback) return;
  await fetch(CONFIG.callback, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${CONFIG.secret}` },
    body: JSON.stringify({ action, sandbox: CONFIG.sandbox, ...extra }),
    signal: AbortSignal.timeout(20_000),
  }).catch((e) => log(`callback ${action} failed: ${e.message}`));
}

// ── environment for Claude ────────────────────────────────────────────

/**
 * What Claude's own process gets. The runner's keys stay with the runner;
 * git gets your GitHub token as a header so clones and fetches just work.
 */
function claudeEnv({ forChat = false } = {}) {
  const out = { ...env, ...gitAuthEnv(CONFIG.ghToken), GIT_TERMINAL_PROMPT: '0' };
  delete out.RUNNER_SECRET;
  delete out.GH_TOKEN;
  delete out.GITHUB_TOKEN;
  if (!forChat) {
    // A coding job never needs the dashboard's database.
    for (const k of Object.keys(out)) if (k.startsWith('SUPABASE_')) delete out[k];
  } else {
    out.OWNER_ID = sb.owner;
  }
  return out;
}

const repoUrl = (owner, name) => CONFIG.repoUrl.replace('{owner}', owner).replace('{name}', name);

async function githubOwner() {
  if (CONFIG.ghOwner) return CONFIG.ghOwner;
  const me = await github.user().catch(() => null);
  CONFIG.ghOwner = me?.login ?? '';
  return CONFIG.ghOwner;
}

/** Where a project's code is: its GitHub repo, or nowhere this runner can reach. */
async function locate(slug) {
  const rows = await api(`/projects?name=eq.${enc(slug)}&select=name,full_name,is_local`)
    .catch(() => null);
  const listed = Array.isArray(rows) ? rows : [];
  const full = listed.find((r) => r.full_name)?.full_name;
  if (full) {
    const [owner, name] = full.split('/');
    return { url: repoUrl(owner, name) };
  }
  if (listed.length && listed.every((r) => r.is_local)) return { localOnly: true };
  const owner = await githubOwner();
  return owner ? { url: repoUrl(owner, slug) } : { localOnly: true };
}

// ── one coding job ────────────────────────────────────────────────────

async function pastOn(slug, notId) {
  const jobs = await api(`/jobs?project_slug=eq.${enc(slug)}&id=neq.${enc(notId)}`
    + '&status=in.(done,error)&select=id,prompt,status,error,created_at'
    + '&order=created_at.desc&limit=6').catch(() => null);
  if (!Array.isArray(jobs) || !jobs.length) return [];
  const ids = jobs.map((j) => enc(j.id)).join(',');
  const results = await api(`/job_events?job_id=in.(${ids})&kind=eq.result&select=job_id,text`)
    .catch(() => null);
  const byJob = new Map((Array.isArray(results) ? results : []).map((r) => [String(r.job_id), r.text]));
  return jobs.reverse().map((j) => ({ ...j, result: byJob.get(String(j.id)) ?? '' }));
}

async function runJob(id, { continuing = false } = {}) {
  let job = (await api(`/jobs?id=eq.${enc(id)}&select=*`))?.[0];
  if (!job) { log(`no job ${id}`); return 'missing'; }

  if (job.status === 'queued' || (continuing && job.status === 'paused')) {
    const taken = await api(`/jobs?id=eq.${enc(id)}&status=eq.${job.status}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: { status: 'running', claimed_by: CONFIG.name, claimed_at: stamp(), resume_at: null, error: null },
    });
    if (!taken?.length) { log(`job ${id} was taken by someone else`); return 'taken'; }
    job = taken[0];
  } else if (job.status !== 'running') {
    log(`job ${id} is ${job.status}; nothing to do`);
    return 'skipped';
  }

  const ev = eventLog(job.id);
  await heartbeat();
  const beat = setInterval(heartbeat, BEAT_MS);
  try {
    return await work(job, ev, { continuing });
  } catch (e) {
    log(`job ${id} failed: ${e.message}`);
    ev.add('error', e.message);
    await patchJob(job.id, { status: 'error', error: clip(e.message, 500), finished_at: stamp() })
      .catch(() => {});
    return 'error';
  } finally {
    clearInterval(beat);
    await ev.flush();
  }
}

async function work(job, ev, { continuing }) {
  const isNew = job.mode === 'new';
  let slug = job.project_slug;
  if (!slug) {
    slug = slugify(job.prompt);
    await patchJob(job.id, { project_slug: slug });
  }
  const dir = join(CONFIG.work, slug);

  ev.add('status', continuing
    ? `Picked back up in the cloud (${CONFIG.name})`
    : `Started in the cloud (${CONFIG.name})`);

  // ── the code ──
  if (isNew) {
    await git.init(dir);
  } else {
    const where = await locate(slug);
    if (where.localOnly) {
      throw new Error(`${slug} is only on your PC, not on GitHub, so the cloud runner cannot `
        + 'reach it. Push it to GitHub, or run this while your PC is on.');
    }
    const how = await git.prepare(dir, where.url);
    if (how !== 'pulled' && how !== 'cloned') ev.add('status', `Workspace: ${how}`);
  }

  // ── memory ──
  const sessions = readState('sessions');
  const known = sessions[slug];
  const fresh = known && Date.now() - known.at < CONFIG.sessionDays * 86_400_000;
  let resume = continuing ? (job.session_id || known?.id) : (fresh ? known.id : null);
  const past = resume ? [] : await pastOn(slug, job.id);
  if (!continuing) {
    ev.add('status', resume
      ? 'Continuing this project\'s last session'
      : past.length
        ? `New session, with ${past.length} earlier request${past.length > 1 ? 's' : ''} for context`
        : existsSync(join(dir, 'CLAUDE.md')) ? 'New session; CLAUDE.md has the project notes' : 'New session');
  }

  const system = jobSystemPrompt({
    slug, isNew: isNew && !continuing, owner: CONFIG.ownerName, host: CONFIG.name, today: stamp().slice(0, 10),
  });

  // ── the run ──
  let stopReason = null;
  let limit = null;
  let savedSession = job.session_id;

  const attempt = (resumeId) => {
    const prompt = jobPrompt({
      prompt: job.prompt, past: resumeId ? [] : past, resumed: Boolean(resumeId) && !continuing, continuing,
    });
    const run = runClaude({
      bin: CONFIG.claude,
      prompt,
      cwd: dir,
      env: claudeEnv(),
      system,
      resume: resumeId,
      model: CONFIG.jobModel || undefined,
      effort: job.effort,
      onMessage: (msg) => {
        if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id
          && msg.session_id !== savedSession) {
          savedSession = msg.session_id;
          patchJob(job.id, { session_id: savedSession }).catch(() => {});
        }
        if (msg.type === 'assistant') {
          const sub = Boolean(msg.parent_tool_use_id);
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'text' && !sub) ev.add('assistant', block.text);
            if (block.type === 'tool_use') ev.add('tool', `${sub ? '↳ ' : ''}${describeTool(block.name, block.input)}`);
          }
        }
        if (msg.type === 'rate_limit_event' && msg.rate_limit_info) {
          const info = msg.rate_limit_info;
          recordUsage(info).then((row) => {
            const cap = Number(job.usage_cap_pct ?? 100);
            if (info.status === 'rejected') limit = info;
            else if (row && cap < 100 && row.pct >= cap && !stopReason) {
              limit = info;
              stopReason = 'cap';
              ev.add('status', `Usage is at ${row.pct}% of the ${row.window_type.replace('_', '-')} window, `
                + `over this job's ${cap}% cap. Pausing.`);
              run.stop();
            }
          });
        }
        if (msg.type === 'system' && msg.subtype === 'api_retry'
          && ['rate_limit', 'overloaded', 'server_error'].includes(msg.error)) {
          ev.add('status', `The API said ${msg.error.replace('_', ' ')}; trying again in `
            + `${Math.round((msg.retry_delay_ms ?? 0) / 1000)}s`);
        }
      },
    });

    // Stop when you ask, and before the sandbox's session runs out.
    const watch = setInterval(async () => {
      if (stopReason) return;
      if (CONFIG.deadline && Date.now() > CONFIG.deadline - STOP_BEFORE_MS) {
        stopReason = 'deadline';
        run.stop();
        return;
      }
      const row = (await api(`/jobs?id=eq.${enc(job.id)}&select=cancel_requested`).catch(() => null))?.[0];
      if (row?.cancel_requested) { stopReason = 'cancel'; run.stop(); }
    }, WATCH_MS);
    return run.done.finally(() => clearInterval(watch));
  };

  let out = await attempt(resume);
  if (resume && !stopReason && lostSession(failure(out))) {
    ev.add('status', 'That session is gone; starting a fresh one with the project\'s history');
    resume = null;
    past.push(...await pastOn(slug, job.id));
    out = await attempt(null);
  }
  savedSession = out.sessionId || savedSession;
  if (savedSession) {
    sessions[slug] = { id: savedSession, at: Date.now() };
    writeState('sessions', sessions);
  }
  await ev.flush();

  const turns = out.result?.num_turns ?? null;
  const cost = out.result?.total_cost_usd ?? null;
  const why = failure(out);

  // ── how it ended ──
  if (stopReason === 'cancel') {
    ev.add('status', 'Stopped from the dashboard');
    const patch = { session_id: savedSession, num_turns: turns, finished_at: stamp(), cancel_requested: false };
    await patchJob(job.id, { ...patch, status: 'cancelled' })
      .catch(() => patchJob(job.id, { ...patch, status: 'error', error: 'Stopped from the dashboard' }));
    return 'cancelled';
  }

  if (stopReason === 'deadline') {
    ev.add('status', 'This sandbox session is nearly out of time; carrying on in a fresh one');
    await ev.flush();
    await patchJob(job.id, { status: 'paused', resume_at: stamp(), session_id: savedSession, num_turns: turns });
    return 'continue';
  }

  if (stopReason === 'cap' || (out.result?.is_error && (limit || hitLimit(why)))) {
    const at = resumeAt(limit);
    ev.add('status', `Paused for the usage limit; picks up again after ${at.slice(11, 16)} UTC`);
    await patchJob(job.id, { status: 'paused', resume_at: at, session_id: savedSession, num_turns: turns });
    return 'paused';
  }

  if (!out.result || out.result.is_error) {
    ev.add('error', why);
    await patchJob(job.id, {
      status: 'error', error: clip(why, 500), session_id: savedSession, num_turns: turns,
      cost_usd: cost, finished_at: stamp(),
    });
    return 'error';
  }

  // ── it worked: put it on GitHub ──
  const summary = String(out.result.result ?? '').trim() || out.texts.at(-1) || 'Done.';
  const patch = {
    status: 'done', error: null, session_id: savedSession, num_turns: turns, cost_usd: cost,
    finished_at: stamp(),
  };
  try {
    await git.commitLeftovers(dir, `Work from the dashboard: ${clip(job.prompt.replace(/\s+/g, ' '), 60)}`);
    if (isNew && !(await git.hasRemote(dir)) && job.repo_visibility !== 'none') {
      const owner = await githubOwner();
      const repo = await github.create(slug, {
        isPrivate: job.repo_visibility !== 'public',
        description: clip(job.prompt.replace(/\s+/g, ' '), 300),
      });
      await git.addRemote(dir, repoUrl(repo.owner?.login ?? owner, repo.name ?? slug));
      patch.repo_url = repo.html_url ?? `https://github.com/${owner}/${slug}`;
    }
    if (await git.hasRemote(dir) && await git.hasCommits(dir)) {
      const branch = await git.push(dir);
      ev.add('status', `Pushed to ${branch}`);
    } else if (isNew && job.repo_visibility === 'none') {
      ev.add('status', 'Kept in the cloud workspace only: you chose no GitHub repo');
    }
  } catch (e) {
    ev.add('error', `The work is done but did not reach GitHub: ${e.message}`);
  }
  ev.add('result', summary);
  await ev.flush();
  await patchJob(job.id, patch);
  return 'done';
}

// ── the Ask tab ───────────────────────────────────────────────────────

async function assistantBeat(stale = false) {
  await api('/assistants', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: {
      owner: sb.owner,
      name: CONFIG.assistantName,
      model: CONFIG.chatModel ? `Claude Code · ${CONFIG.chatModel}` : 'Claude Code',
      // Going to sleep says so at once, so the dashboard wakes us for the
      // next message rather than waiting for this heartbeat to go stale.
      last_seen: stale ? new Date(Date.now() - 3_600_000).toISOString() : stamp(),
    },
  }).catch((e) => log(`assistant heartbeat failed: ${e.message}`));
}

async function claimMessage() {
  const queued = await api(`/chat_messages?role=eq.assistant&status=eq.queued&owner=eq.${enc(sb.owner)}`
    + '&order=created_at.asc&limit=1');
  const next = Array.isArray(queued) ? queued[0] : null;
  if (!next) return null;
  const taken = await api(`/chat_messages?id=eq.${enc(next.id)}&status=eq.queued`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: { status: 'streaming', text: '', error: null, model: 'Claude', updated_at: stamp() },
  });
  return taken?.[0] ?? null;
}

async function answer(row) {
  const all = await api(`/chat_messages?chat_id=eq.${enc(row.chat_id)}&order=created_at.asc&limit=200`);
  const messages = (Array.isArray(all) ? all : [])
    .filter((m) => String(m.id) !== String(row.id))
    .filter((m) => m.role === 'user' || m.status === 'done');

  const chats = readState('chats');
  let resume = chats[row.chat_id]?.id ?? null;

  let text = '';
  let written = '';
  let lastFlush = 0;
  let stop = false;
  let current = null;
  let freshBlock = false;

  const flush = async (force = false) => {
    if (!force && (text === written || Date.now() - lastFlush < FLUSH_MS)) return;
    written = text;
    lastFlush = Date.now();
    const rows = await api(`/chat_messages?id=eq.${enc(row.id)}`, {
      method: 'PATCH', prefer: 'return=representation', body: { text, updated_at: stamp() },
    }).catch(() => null);
    if (rows?.[0]?.cancel_requested && !stop) { stop = true; current?.stop(); }
  };
  let pending = Promise.resolve();
  const queueFlush = () => { pending = pending.then(() => flush()).catch(() => {}); };

  const attempt = (resumeId) => {
    current = runClaude({
      bin: CONFIG.claude,
      prompt: chatPrompt({ messages, resumed: Boolean(resumeId) }),
      cwd: CONFIG.assistant,
      env: claudeEnv({ forChat: true }),
      system: chatSystemPrompt({
        owner: CONFIG.ownerName,
        tools: `node ${join(APP, 'bridge', 'tools.mjs')}`,
        work: CONFIG.work,
        github: CONFIG.ghOwner,
        host: CONFIG.name,
      }),
      resume: resumeId,
      model: CONFIG.chatModel || undefined,
      partial: true,
      onMessage: (msg) => {
        if (msg.type === 'rate_limit_event') recordUsage(msg.rate_limit_info);
        if (msg.type !== 'stream_event' || msg.parent_tool_use_id) return;
        const e = msg.event ?? {};
        if (e.type === 'content_block_start' && e.content_block?.type === 'text') freshBlock = true;
        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
          // Text written after a tool call is a new paragraph, not more of the last one.
          if (freshBlock && text.trim()) text += '\n\n';
          freshBlock = false;
          text += e.delta.text;
          queueFlush();
        }
      },
    });
    return current.done;
  };

  let out = await attempt(resume);
  if (resume && !stop && !text && lostSession(failure(out))) {
    resume = null;
    out = await attempt(null);
  }
  await pending;
  if (out.sessionId) {
    chats[row.chat_id] = { id: out.sessionId, at: Date.now() };
    writeState('chats', chats);
  }

  const why = failure(out);
  if (!stop && (!out.result || out.result.is_error) && !text.trim()) {
    await api(`/chat_messages?id=eq.${enc(row.id)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { status: 'error', error: clip(why, 500), cancel_requested: false, updated_at: stamp() },
    }).catch(() => {});
    log(`chat failed: ${why}`);
    return;
  }
  const final = text.trim() || String(out.result?.result ?? '').trim() || '*(no answer)*';
  await api(`/chat_messages?id=eq.${enc(row.id)}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: {
      text: stop ? `${final}\n\n*(stopped)*` : final,
      status: 'done',
      cancel_requested: false,
      updated_at: stamp(),
    },
  });
  log(stop ? 'stopped' : `answered · ${final.length} characters`);
}

async function chatLoop() {
  mkdirSync(CONFIG.assistant, { recursive: true });
  const memory = join(CONFIG.assistant, 'CLAUDE.md');
  if (!existsSync(memory)) {
    await githubOwner();
    writeFileSync(memory, seedMemory({ owner: CONFIG.ownerName, github: CONFIG.ghOwner }));
  }
  await assistantBeat();
  const beat = setInterval(() => assistantBeat(), BEAT_MS);
  let idleSince = Date.now();
  try {
    for (;;) {
      if (CONFIG.deadline && Date.now() > CONFIG.deadline - 2 * 60_000) break;
      const row = await claimMessage().catch((e) => { log(`could not look: ${e.message}`); return null; });
      if (row) {
        await answer(row).catch((e) => log(`answer failed: ${e.message}`));
        idleSince = Date.now();
        // Claude may have queued a job with queue_job: get it started now
        // rather than at the next time the dashboard happens to be opened.
        await callHome('dispatch');
        continue;
      }
      if (Date.now() - idleSince > CONFIG.lingerMs) {
        // Say we are going before going, then look once more: a message
        // that landed in between would otherwise wait for the next wake.
        clearInterval(beat);
        await assistantBeat(true);
        const late = await claimMessage().catch(() => null);
        if (!late) break;
        await assistantBeat();
        await answer(late).catch((e) => log(`answer failed: ${e.message}`));
        idleSince = Date.now();
        continue;
      }
      await sleep(1_500);
    }
  } finally {
    clearInterval(beat);
    await assistantBeat(true);
  }
}

// ── entry ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const jobAt = args.indexOf('--job');

await sb.signIn();
await sb.findOwner();
if (!sb.owner) {
  console.error('Could not tell whose dashboard this is: set OWNER_ID.');
  process.exit(1);
}

if (jobAt >= 0) {
  const id = args[jobAt + 1];
  const outcome = await runJob(id, { continuing: args.includes('--continue') });
  log(`job ${id}: ${outcome}`);
  await callHome(outcome === 'continue' ? 'continue' : 'done', { job: id, outcome });
} else if (args.includes('--chat')) {
  await chatLoop();
  await callHome('done', { chat: true });
} else {
  console.error('Usage: node host/runner.mjs --job <id> [--continue] | --chat');
  process.exit(2);
}
process.exit(0);
