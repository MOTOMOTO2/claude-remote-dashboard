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

const env = process.env;

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

/** The dashboard's session token, checked with Supabase, and it has to be you. */
async function signedInAsOwner(token) {
  if (!token) return false;
  const url = env.SUPABASE_URL.replace(/\/+$/, '');
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_SERVICE_KEY, authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!res?.ok) return false;
  const user = await res.json().catch(() => null);
  return Boolean(user?.id) && user.id === env.OWNER_ID;
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
    .catch((e) => console.log('[dispatch] recheck', e.message)));
}

export async function GET(request) {
  const action = new URL(request.url).searchParams.get('action');
  const gaps = missing();
  if (action === 'cron') {
    if (!env.CRON_SECRET || !same(bearer(request), env.CRON_SECRET)) return json({ ok: false }, 401);
    if (gaps.length) return json({ ok: false, configured: false });
    return json({ ok: true, ...(await tools(request).run()) });
  }
  // Names only, never values: enough to tell you what is left to set.
  return json({ ok: gaps.length === 0, configured: gaps.length === 0, missing: gaps });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const action = body?.action ?? 'wake';
  const gaps = missing();
  if (gaps.length) return json({ ok: false, configured: false, missing: gaps });

  if (action === 'wake') {
    if (!(await signedInAsOwner(bearer(request)))) return json({ ok: false, configured: true }, 401);
    const t = tools(request);
    const did = await t.run();
    recheck(t, did);
    return json({ ok: true, configured: true, ...did });
  }

  // Everything else comes from inside a sandbox.
  if (!same(bearer(request), env.RUNNER_SECRET)) return json({ ok: false }, 401);
  const t = tools(request);
  const name = String(body.sandbox ?? '');
  if ((action === 'done' || action === 'continue') && name.startsWith('cr-')) {
    // A stop snapshots the disk, which is what the next run resumes from.
    await t.sandboxes.stop(name).catch((e) => console.log('[runner] stop', name, e.message));
  }
  if (action === 'done' || action === 'continue' || action === 'dispatch') {
    const did = await t.run();
    recheck(t, did);
    return json({ ok: true, ...did });
  }
  return json({ ok: false, error: `unknown action ${action}` }, 400);
}
