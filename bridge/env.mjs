// The two things every script in here needs: the .env next to this file, and
// a way to talk to Supabase as you.
//
// No SDK on purpose — these are small processes on your own machine making a
// handful of request shapes, and a dependency-free script is one less thing
// to keep current.

import { readFileSync } from 'node:fs';

/**
 * What `api` answers when the table is not in this Supabase project at all —
 * as opposed to there and empty, or there and written to with
 * `return=minimal`, both of which are ordinary and answer with nothing.
 * Collapsing those into one value made a successful write look like a
 * missing schema, which took the relay down on its first heartbeat.
 */
export const NO_TABLE = Symbol('no such table');

/** A .env next to this file, if you would rather not export variables. */
export function loadDotEnv(path = new URL('.env', import.meta.url)) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return false; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return true;
}

/**
 * Sign in the way the bridge does — the same bridge/.env, as you, under row
 * level security — and hand back the one function everything else calls.
 *
 * With the service-role key there is no session at all; with the anon key
 * the token lasts an hour and these processes run for weeks, so a 401 signs
 * in again rather than falling over.
 */
export function connect(env = process.env) {
  const url = String(env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const serviceKey = env.SUPABASE_SERVICE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const key = serviceKey || env.SUPABASE_ANON_KEY || env.SUPABASE_KEY || '';

  let token = serviceKey;
  const self = {
    url,
    key,
    owner: env.OWNER_ID ?? '',

    async signIn() {
      if (!url || !key) {
        throw new Error('bridge/.env has no SUPABASE_URL and key — run npm run bridge:setup.');
      }
      if (serviceKey) return self.owner;
      const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: key, 'content-type': 'application/json' },
        body: JSON.stringify({ email: env.SUPABASE_EMAIL, password: env.SUPABASE_PASSWORD }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(`Sign-in failed: ${body.error_description ?? body.msg ?? res.status}`);
      }
      token = body.access_token;
      self.owner = body.user?.id ?? self.owner;
      return self.owner;
    },

    async api(path, { method = 'GET', body, prefer, retry = true } = {}) {
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

      if (res.status === 401 && retry && !serviceKey) {
        await self.signIn();
        return self.api(path, { method, body, prefer, retry: false });
      }

      const text = await res.text();
      if (!res.ok) {
        // A table this account never made is "not set up", not a crash.
        if (/PGRST205|does not exist/.test(text)) return NO_TABLE;
        throw new Error(`${method} ${path.split('?')[0]} → ${res.status} ${text.slice(0, 200)}`);
      }
      // `return=minimal` is answered with no body at all, and that is a
      // success. Only NO_TABLE means the schema is not there.
      return text ? JSON.parse(text) : null;
    },

    /** Whose rows these are, when there is no session to read it from. */
    async findOwner(tables = ['chats', 'jobs', 'house_devices']) {
      if (self.owner) return self.owner;
      for (const table of tables) {
        const rows = await self.api(`/${table}?select=owner&limit=1`).catch(() => null);
        if (rows?.[0]?.owner) { self.owner = rows[0].owner; return self.owner; }
      }
      return '';
    },
  };

  return self;
}
