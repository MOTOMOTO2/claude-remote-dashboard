// The cloud runner's front door, as one Vercel Function.
//
//   POST {action:"wake"}      from the dashboard, signed in as you: start
//                             whatever is waiting (jobs, Ask-tab replies)
//   POST {action:"done"}      from a sandbox, with RUNNER_SECRET: stop me,
//                             then start whatever is waiting
//   POST {action:"continue"}  from a sandbox that is out of session time:
//                             stop me, and start me again to carry on
//   POST {action:"dispatch"}  from the Ask sandbox after an answer, which may
//                             have queued a job: start whatever is waiting
//   GET  ?action=cron         Vercel's daily cron, with CRON_SECRET
//   GET                       whether this deployment is set up, and with what
//   GET ?check=1              and whether Supabase and GitHub accept the keys
//
// It holds no state of its own. Supabase is the queue, exactly as it is for
// the PC runner; this only decides what to start and starts it, then
// returns. The work happens in Vercel Sandboxes (see host/sandboxes.mjs).

import { timingSafeEqual } from 'node:crypto';
import { Sandbox } from '@vercel/sandbox';
import { waitUntil } from '@vercel/functions';
import { dispatch } from '../host/dispatch.mjs';
import { makeSandboxes } from '../host/sandboxes.mjs';
import { makeGitHub } from '../host/git.mjs';

// Every setting trimmed: a value pasted or piped in with a line break on the
// end looks set, and then quietly fails every comparison it is used in.
const env = new Proxy(process.env, {
  get: (all, key) => (typeof all[key] === 'string' ? all[key].trim() : all[key]),
});

/**
 * What talks to Vercel. The tests swap in a stand-in here: run from inside a
 * linked checkout, the real SDK finds your Vercel login by itself and would
 * start real sandboxes.
 */
export const deps = { Sandbox };

/** What has to be set for the cloud runner to work at all. */
const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'OWNER_ID', 'RUNNER_SECRET', 'GH_TOKEN'];
const missing = () => [
  ...REQUIRED.filter((k) => !env[k]),
  ...(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY ? [] : ['CLAUDE_CODE_OAUTH_TOKEN']),
];

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

const same = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};
const bearer = (request) => (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');

/** PostgREST as the service role. Only this function and the sandboxes hold it. */
async function api(path, { method = 'GET', body, prefer } = {}) {
  const url = env.SUPABASE_URL.replace(/\/+$/, '');
  const res = await fetch(`${url}/rest/v1${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'content-type': 'application/json',
      ...(prefer ? { prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} → ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const short = (id) => String(id ?? '').slice(0, 8) || '(none)';

/**
 * The dashboard's session token, checked with Supabase, and it has to be
 * you. Says why not, for the logs: a refusal is otherwise invisible.
 */
async function whoIsAsking(token) {
  if (!token) return { ok: false, why: 'no session token was sent' };
  const url = env.SUPABASE_URL.replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_SERVICE_KEY, authorization: `Bearer ${token}` },
    });
  } catch (e) {
    return { ok: false, why: `could not reach Supabase auth: ${e.message}` };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, why: `Supabase auth said ${res.status}: ${text.slice(0, 160)}` };
  }
  const user = await res.json().catch(() => null);
  if (!user?.id) return { ok: false, why: 'Supabase auth returned no user' };
  if (user.id !== env.OWNER_ID) {
    return { ok: false, why: `signed in as ${short(user.id)}…, but OWNER_ID is ${short(env.OWNER_ID)}…` };
  }
  return { ok: true };
}

/** One line per decision, so "nothing happened" always has a reason in the logs. */
function report(action, did) {
  const bits = [
    did.started?.length ? `started ${did.started.map((s) => `${s.id}→${s.slug}`).join(', ')}` : '',
    did.resumed?.length ? `resumed ${did.resumed.join(', ')}` : '',
    did.recovered?.length ? `recovered ${did.recovered.join(', ')}` : '',
    did.chat ? 'started the Ask sandbox' : '',
    did.pc ? `PC awake (${did.pc})` : '',
    did.skipped?.length ? `left ${did.skipped.map((s) => `${s.id} (${s.why})`).join(', ')}` : '',
  ].filter(Boolean);
  console.log(`[runner] ${action}: ${bits.join('; ') || 'nothing waiting'}`);
}

function tools(request) {
  const origin = env.RUNNER_CALLBACK_ORIGIN
    || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : new URL(request.url).origin);
  const sandboxes = makeSandboxes({ Sandbox: deps.Sandbox, env, callback: `${origin}/api/runner` });
  return {
    sandboxes,
    run: () => dispatch({
      api,
      owner: env.OWNER_ID,
      sandboxes,
      github: makeGitHub({ token: env.GH_TOKEN }),
      ghOwner: env.GITHUB_OWNER ?? '',
      me: env.HOST_NAME || 'cloud',
      assistantName: env.ASSISTANT_NAME || 'Claude',
      pcFirst: env.PC_FIRST !== '0',
      log: (...a) => console.log('[dispatch]', ...a),
    }),
  };
}

/** How long a job left for the PC is given before the cloud looks again. */
const RECHECK_MS = Number(env.PC_RECHECK_MS || 40_000);

/**
 * A job was just left for the PC because it checked in recently. If the PC
 * went to sleep in those last few seconds it will never claim it, and with
 * the app closed nothing else would come back to look. So look once more,
 * after the PC's heartbeat would have gone stale: if the PC has taken it,
 * or is still awake, nothing happens; if it is gone, the cloud takes it.
 */
function recheck(t, did) {
  if (!did?.leftForPc?.length) return;
  waitUntil(new Promise((resolve) => setTimeout(resolve, RECHECK_MS))
    .then(() => t.run())
    .then((again) => report('recheck', again))
    .catch((e) => console.log('[dispatch] recheck', e.message)));
}

/**
 * Whether the keys that are set actually work. A key that is present but
 * wrong looks exactly like a working one until the first job, so this asks
 * Supabase and GitHub. Says what is wrong, never what the value is.
 */
async function problems() {
  const out = [];
  const url = env.SUPABASE_URL.replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_KEY;
  const said = async (res) => {
    const text = await res.text().catch(() => '');
    try { return JSON.parse(text).message ?? text.slice(0, 120); } catch { return text.slice(0, 120); }
  };
  const db = await fetch(`${url}/rest/v1/jobs?select=id&limit=1`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
  if (!db.ok) {
    out.push(`Supabase rejects SUPABASE_SERVICE_KEY (${db.status}: ${await said(db)}). `
      + 'Use the secret key (sb_secret_…) from Settings → API keys.');
  } else {
    const user = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(env.OWNER_ID)}`, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
    }).catch(() => null);
    if (!user?.ok) out.push(`OWNER_ID is not a user of this Supabase project (${user?.status ?? 'no answer'}).`);
  }
  const gh = await fetch('https://api.github.com/user', {
    headers: { authorization: `Bearer ${env.GH_TOKEN}`, 'user-agent': 'claude-remote-runner' },
  }).catch(() => null);
  if (!gh?.ok) out.push(`GitHub rejects GH_TOKEN (${gh?.status ?? 'no answer'}).`);
  const claude = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (claude && !claude.startsWith('sk-ant-')) {
    out.push('CLAUDE_CODE_OAUTH_TOKEN does not look like a token from `claude setup-token` (sk-ant-…).');
  }
  return out;
}

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const action = params.get('action');
  const gaps = missing();
  if (action === 'cron') {
    if (!env.CRON_SECRET || !same(bearer(request), env.CRON_SECRET)) return json({ ok: false }, 401);
    if (gaps.length) return json({ ok: false, configured: false });
    const did = await tools(request).run();
    report('cron', did);
    return json({ ok: true, ...did });
  }
  // Names only, never values: enough to tell you what is left to set.
  if (params.has('check') && !gaps.length) {
    const wrong = await problems();
    return json({ ok: !wrong.length, configured: true, missing: [], problems: wrong });
  }
  return json({ ok: gaps.length === 0, configured: gaps.length === 0, missing: gaps });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const action = body?.action ?? 'wake';
  const gaps = missing();
  if (gaps.length) return json({ ok: false, configured: false, missing: gaps });

  if (action === 'wake') {
    const who = await whoIsAsking(bearer(request));
    if (!who.ok) {
      console.log(`[runner] wake refused: ${who.why}`);
      return json({ ok: false, configured: true, refused: who.why }, 401);
    }
    const t = tools(request);
    const did = await t.run();
    report('wake', did);
    recheck(t, did);
    return json({ ok: true, configured: true, ...did });
  }

  // Everything else comes from inside a sandbox.
  if (!same(bearer(request), env.RUNNER_SECRET)) {
    console.log(`[runner] ${action} refused: wrong or missing RUNNER_SECRET`);
    return json({ ok: false }, 401);
  }
  const t = tools(request);
  const name = String(body.sandbox ?? '');
  if ((action === 'done' || action === 'continue') && name.startsWith('cr-')) {
    // A stop snapshots the disk, which is what the next run resumes from.
    await t.sandboxes.stop(name).catch((e) => console.log('[runner] stop', name, e.message));
  }
  if (action === 'done' || action === 'continue' || action === 'dispatch') {
    const did = await t.run();
    report(`${action} from ${name || 'a sandbox'}`, did);
    recheck(t, did);
    return json({ ok: true, ...did });
  }
  return json({ ok: false, error: `unknown action ${action}` }, 400);
}
