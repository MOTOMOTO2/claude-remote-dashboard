// Your dashboard, as tools your own assistant can call.
//
// personal-code-assistant runs this as its PCA_TOOLS provider — and anything
// else that speaks the same two commands can:
//
//   node bridge/tools.mjs list            every tool, as a JSON array
//   node bridge/tools.mjs call <name>     arguments as JSON on stdin, the
//                                         result on stdout, a failure on
//                                         stderr with a non-zero exit
//
// It signs in exactly as the bridge does — the same bridge/.env, as you,
// under row-level security — so it can see and do what you can from the
// dashboard and nothing more. One tool acts (queue_job); the rest only read.

import { readFileSync } from 'node:fs';

function loadDotEnv(path = new URL('.env', import.meta.url)) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv();

const env = process.env;
const url = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const serviceKey = env.SUPABASE_SERVICE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const key = serviceKey || env.SUPABASE_ANON_KEY || env.SUPABASE_KEY || '';

let token = '';
let owner = env.OWNER_ID ?? '';

async function signIn() {
  if (!url || !key) throw new Error('bridge/.env has no SUPABASE_URL and key — run npm run bridge:setup.');
  if (serviceKey) return;
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'content-type': 'application/json' },
    body: JSON.stringify({ email: env.SUPABASE_EMAIL, password: env.SUPABASE_PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Sign-in failed: ${body.error_description ?? body.msg ?? res.status}`);
  token = body.access_token;
  owner = body.user?.id ?? owner;
}

async function api(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${url}/rest/v1${path}`, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${token || key}`,
      'content-type': 'application/json',
      ...(prefer ? { prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // A table this account never made is "not set up", not a crash.
    if (/PGRST205|does not exist/.test(text)) return null;
    throw new Error(`${method} ${path.split('?')[0]} → ${res.status} ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : null;
}

// ── wording ───────────────────────────────────────────────────────────

const ago = (iso, now = Date.now()) => {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - new Date(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 90 * 60) return `${Math.round(s / 60)}m ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const until = (iso, now = Date.now()) => {
  const s = Math.round((new Date(iso) - now) / 1000);
  if (!iso || s <= 0) return 'now';
  return s < 90 * 60 ? `in ${Math.round(s / 60)}m` : `in ${Math.round(s / 3600)}h`;
};
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const where = (j) => j.project_slug ?? 'new project';
const line = (j) => `- [${j.id}] ${where(j)} — "${clip(j.prompt, 90)}"`;

// ── the tools ─────────────────────────────────────────────────────────

const TOOLS = {
  dashboard_status: {
    description: 'What the dashboard shows right now: whether the PC runner is online, coding jobs '
      + 'running, queued or paused, the most recent finished and failed ones, and usage windows.',
    parameters: { type: 'object', properties: {} },
    note: 'checking your dashboard',
    async run() {
      const [jobs, usage, hosts] = await Promise.all([
        api('/jobs?select=id,prompt,project_slug,status,created_at,claimed_at,error,live_url&order=created_at.desc&limit=40'),
        api('/usage_windows?select=window_type,pct,resets_at'),
        api('/hosts?select=name,last_seen&order=last_seen.desc&limit=1'),
      ]);
      const out = [];
      const host = hosts?.[0];
      if (!host) out.push('PC runner: has never checked in.');
      else {
        const fresh = Date.now() - new Date(host.last_seen) < 30_000;
        out.push(`PC runner: ${fresh ? 'online' : 'offline'} (${host.name}, last seen ${ago(host.last_seen)}).`);
      }
      const all = jobs ?? [];
      for (const status of ['running', 'paused', 'queued']) {
        const some = all.filter((j) => j.status === status);
        if (some.length) out.push(`${status[0].toUpperCase()}${status.slice(1)} (${some.length}):`, ...some.map(line));
      }
      const finished = all.filter((j) => j.status === 'done' || j.status === 'error').slice(0, 8);
      if (finished.length) {
        // Counted here, because a small model reading the list miscounts it.
        const failed = finished.filter((j) => j.status === 'error').length;
        const latest = all.find((j) => j.status === 'error');
        if (latest) out.push(`Latest failure: ${line(latest)} (${ago(latest.created_at)}): ${clip(latest.error, 160) || 'no reason given'}`);
        out.push(`Most recent finished (${finished.length}: ${finished.length - failed} done, ${failed} failed):`,
          ...finished.map((j) => `${line(j)} ${j.status === 'error'
          ? `FAILED: ${clip(j.error, 120) || 'no reason given'}` : `done${j.live_url ? `, live at ${j.live_url}` : ''}`} (${ago(j.created_at)})`));
      }
      if (!all.length) out.push('No jobs yet.');
      if (usage?.length) {
        out.push(`Usage: ${usage.map((u) => `${u.window_type} ${Math.round(u.pct)}% (resets ${until(u.resets_at)})`).join(', ')}.`);
      }
      return out.join('\n');
    },
  },

  job_details: {
    description: 'One coding job in detail: its prompt, status, error, and the last things it did. '
      + 'Give a job id from dashboard_status, or a project name for its latest job.',
    parameters: {
      type: 'object',
      required: ['job'],
      properties: { job: { type: 'string', description: 'A job id, or a project name.' } },
    },
    note: 'looking at that job',
    async run({ job }) {
      const q = String(job ?? '').trim();
      if (!q) throw new Error('Say which job: an id, or a project name.');
      const cols = 'id,prompt,project_slug,status,created_at,claimed_at,error,num_turns,live_url,repo_url';
      let rows = /^[0-9a-f-]{1,40}$/i.test(q)
        ? await api(`/jobs?select=${cols}&id=eq.${encodeURIComponent(q)}&limit=1`).catch(() => null)
        : null;
      if (!rows?.length) {
        rows = await api(`/jobs?select=${cols}&project_slug=eq.${encodeURIComponent(q)}&order=created_at.desc&limit=1`);
      }
      const j = rows?.[0];
      if (!j) return `No job matches "${q}".`;
      const events = await api(`/job_events?select=kind,text&job_id=eq.${encodeURIComponent(j.id)}&order=id.desc&limit=15`) ?? [];
      return [
        `[${j.id}] ${where(j)} — ${j.status}, queued ${ago(j.created_at)}${j.num_turns ? `, ${j.num_turns} turns` : ''}`,
        `Prompt: ${clip(j.prompt, 600)}`,
        j.error ? `Error: ${clip(j.error, 600)}` : '',
        j.live_url ? `Live at: ${j.live_url}` : '',
        j.repo_url ? `Repo: ${j.repo_url}` : '',
        events.length ? 'Last things it did, newest first:' : 'Nothing logged yet.',
        ...events.map((e) => `- ${e.kind}: ${clip(e.text, 200)}`),
      ].filter(Boolean).join('\n');
    },
  },

  list_projects: {
    description: 'Every project the dashboard knows: name, what it is, language, and where it is live.',
    parameters: { type: 'object', properties: {} },
    note: 'listing your projects',
    async run() {
      const rows = await api('/projects?select=name,description,language,live_url,pushed_at&order=pushed_at.desc.nullslast&limit=100');
      if (!rows?.length) return 'The dashboard has no projects listed yet (the PC runner fills them in).';
      return rows.map((p) => `- ${p.name}${p.language ? ` (${p.language})` : ''}: ${clip(p.description, 140) || 'no description'}`
        + `${p.live_url ? ` — live at ${p.live_url}` : ''}`).join('\n');
    },
  },

  queue_job: {
    description: 'Start a coding job on this PC, exactly as the dashboard\'s New screen does. Only when the '
      + 'user\'s latest message asks for it. Give a project name to work on an existing project; leave it '
      + 'out to start a brand-new one.',
    parameters: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'What the job should do, written as the instruction to the coding agent.' },
        project: { type: 'string', description: 'An existing project\'s name. Leave out for a new project.' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'Defaults to high.' },
      },
    },
    acts: true,
    note: 'queueing a job',
    async run({ prompt, project, effort }) {
      const text = String(prompt ?? '').trim();
      if (text.length < 8) throw new Error('A job needs a real instruction, not a word or two.');
      let slug = String(project ?? '').trim() || null;
      if (slug) {
        const known = await api('/projects?select=name&limit=500') ?? [];
        const exact = known.find((p) => p.name.toLowerCase() === slug.toLowerCase());
        if (!exact) {
          const near = known.filter((p) => p.name.toLowerCase().includes(slug.toLowerCase())).map((p) => p.name);
          throw new Error(`No project called "${slug}".${near.length ? ` Did you mean: ${near.slice(0, 5).join(', ')}?` : ''}`);
        }
        slug = exact.name;
      }
      const level = ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : 'high';
      // The same row the New screen writes, with its defaults.
      const rows = await api('/jobs', {
        method: 'POST',
        prefer: 'return=representation',
        body: {
          owner,
          prompt: text,
          mode: slug ? 'existing' : 'new',
          project_slug: slug,
          repo_visibility: slug ? 'none' : 'private',
          effort: level,
          usage_cap_pct: 90,
        },
      });
      const job = rows?.[0];
      if (!job) throw new Error('The dashboard did not take the job.');
      return `Queued job [${job.id}] ${slug ? `on ${slug}` : 'for a new project'}, effort ${level}: "${clip(text, 200)}". `
        + 'It is on the dashboard now and starts when the PC runner picks it up.';
    },
  },
};

// ── the protocol ──────────────────────────────────────────────────────

const [command, name] = process.argv.slice(2);

if (command === 'list') {
  console.log(JSON.stringify(Object.entries(TOOLS).map(([n, t]) => ({
    name: n,
    description: t.description,
    parameters: t.parameters,
    live: true,
    acts: Boolean(t.acts),
    note: t.note,
  }))));
  process.exit(0);
}

if (command !== 'call' || !TOOLS[name]) {
  console.error(command === 'call'
    ? `There is no tool called ${name}. Run: node bridge/tools.mjs list`
    : 'Usage: node bridge/tools.mjs list | call <name>   (arguments as JSON on stdin)');
  process.exit(2);
}

let input = '';
if (!process.stdin.isTTY) {
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
}
let args = {};
try { args = input.trim() ? JSON.parse(input) : {}; } catch { /* no arguments */ }

try {
  await signIn();
  process.stdout.write(`${await TOOLS[name].run(args)}\n`);
  process.exit(0);
} catch (e) {
  console.error(e.message ?? String(e));
  process.exit(1);
}
