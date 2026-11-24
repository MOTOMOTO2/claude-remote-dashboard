// The outbox: what you sent, kept on this phone until Supabase has it.
//
// Every write that matters — a job, a message to your assistant, a field
// report — is put here first and only removed once the server has answered
// for it. That order is what makes "no signal" a non-event: the thing is safe
// the moment you press send, and the network is a detail that happens later.
//
// Ported from Field Reports (offline-sync-pwa/web/src/lib/outbox.ts), with
// one change: an entry carries a `kind`, and whoever flushes supplies the
// sender for each kind, so one queue serves every screen. No DOM, no
// Supabase — the store and the senders are handed in.

import * as idb from './idb.js';

/** How long one sender may hold an entry before another may take it over. */
export const LEASE_MS = 30_000;

/** Server trouble is retried this many times before the entry needs a person. */
export const MAX_ATTEMPTS = 8;

const STORE = 'outbox';

export function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // Old browsers only: good enough to be unique on one phone.
  const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
}

/** Exponential backoff with jitter, capped so a long outage still retries. */
export function backoffMs(attempts, random = Math.random) {
  const base = Math.min(2 ** Math.max(0, attempts - 1) * 2_000, 5 * 60_000);
  return Math.round(base * (0.75 + random() * 0.5));
}

/** A failed fetch, as supabase-js reports one: no HTTP status at all. */
export function isNetworkError(res) {
  if (!res?.error) return false;
  if (res.status === 0) return true;
  return !res.error.code && /failed to fetch|networkerror|load failed|network request failed|fetch failed/i
    .test(String(res.error.message ?? ''));
}

/**
 * What one answer from Supabase means for an entry.
 *
 *   sent       — it landed
 *   duplicate  — it had already landed: a retry whose first try got through
 *                but whose answer was lost on the way back (unique key, 23505)
 *   offline    — no network at all; stop, the rest would fail the same way
 *   retry      — the server or the session is having a moment; back off
 *   reject     — it will never be accepted as it is; a person has to look
 */
export function classify(res) {
  const err = res?.error;
  if (!err) return 'sent';
  if (isNetworkError(res)) return 'offline';
  if (err.code === '23505') return 'duplicate';
  const status = Number(res.status) || 0;
  // 401 is an access token that expired while the phone was offline; the
  // client refreshes it on its own, so the next try usually goes through.
  if (status === 401 || status === 408 || status === 429 || status >= 500) return 'retry';
  if (/jwt/i.test(String(err.message ?? ''))) return 'retry';
  if (status >= 400 || err.code) return 'reject';
  return 'retry';
}

/** The sentence a rejected entry shows. */
export function describe(err) {
  const msg = String(err?.message ?? err ?? 'unknown error');
  if (err?.code === 'PGRST205' || err?.code === '42P01' || /does not exist|could not find the table/i.test(msg)) {
    return `The table isn't in Supabase yet — run bridge/schema.sql. (${msg})`;
  }
  if (err?.code === '42501' || /row-level security/i.test(msg)) {
    return `Supabase refused it for this account. (${msg})`;
  }
  return msg;
}

/**
 * One outbox over one store. `store` is anything with idb.js's shape, so the
 * tests can hand in a Map and the clock can be turned by hand.
 */
export function createOutbox({ store = idb, now = Date.now, random = Math.random } = {}) {
  const list = async (owner = null) => {
    const entries = await store.all(STORE);
    return entries
      .filter((e) => owner == null || e.owner === owner)
      .sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));
  };

  /**
   * Keep something to send. Durable when this resolves. `after` names
   * another entry this one cannot go before: a report on a site that was
   * itself added with no signal.
   */
  async function add({ id = newId(), kind, owner, title = '', payload = {}, after = null }) {
    const t = now();
    const entry = {
      id, kind, owner, title, payload, after,
      createdAt: t,
      state: 'waiting',
      attempts: 0,
      nextAttemptAt: t,
      leaseUntil: 0,
      lastError: null,
    };
    await store.put(STORE, id, entry);
    return entry;
  }

  const has = async (id) => Boolean(await store.get(STORE, id));
  const discard = (id) => store.del(STORE, id);

  /** Put a parked entry back in line and forget its backoff. */
  const retry = (id) => store.update(STORE, id, (e) => (e
    ? { ...e, state: 'waiting', attempts: 0, nextAttemptAt: now(), leaseUntil: 0, lastError: null }
    : e));

  async function retryAll(owner = null) {
    const t = now();
    for (const e of await list(owner)) {
      if (e.state === 'failed' || e.nextAttemptAt > t) await retry(e.id);
    }
  }

  async function counts(owner = null) {
    const all = await list(owner);
    return {
      waiting: all.filter((e) => e.state === 'waiting').length,
      failed: all.filter((e) => e.state === 'failed').length,
    };
  }

  const release = (id) => store.update(STORE, id, (e) => (e ? { ...e, leaseUntil: 0 } : e));
  const park = (id, message) => store.update(STORE, id, (e) => (e
    ? { ...e, state: 'failed', leaseUntil: 0, lastError: message }
    : e));

  /**
   * Send whatever is due, oldest first. `send(entry)` returns a supabase-js
   * style answer ({ data, error, status }). Safe to run from two tabs at
   * once: an entry is leased before it is sent, and the server dedupes on
   * the entry's id anyway.
   */
  async function flush({ owner = null, send }) {
    const result = { sent: [], duplicates: [], failed: [], later: [], blocked: [], offline: false };
    const queue = await list(owner);

    for (const entry of queue) {
      const startedAt = now();
      if (entry.state !== 'waiting' || entry.nextAttemptAt > startedAt) continue;
      // Behind something that hasn't gone yet: a report whose site is still
      // on this phone would only be refused for pointing at nothing.
      if (entry.after && await has(entry.after)) { result.blocked.push(entry); continue; }

      // Claim it. The check and the lease happen in one transaction, so of
      // two senders racing for one entry exactly one comes out holding it.
      let claimed = false;
      await store.update(STORE, entry.id, (current) => {
        if (!current || current.state !== 'waiting' || current.leaseUntil > startedAt) return current;
        claimed = true;
        return { ...current, leaseUntil: startedAt + LEASE_MS };
      });
      if (!claimed) continue;

      let res;
      try {
        res = await send(entry);
      } catch (err) {
        // A sender that throws is a bug or a surprise, not a dead network:
        // retry it later rather than stop the whole queue.
        res = { error: { message: String(err?.message ?? err) }, status: 500 };
      }

      const outcome = classify(res);
      if (outcome === 'offline') {
        await release(entry.id);
        result.offline = true;
        break;
      }
      if (outcome === 'sent' || outcome === 'duplicate') {
        await store.del(STORE, entry.id);
        (outcome === 'sent' ? result.sent : result.duplicates).push({ entry, res });
        continue;
      }

      const message = describe(res.error);
      if (outcome === 'reject') {
        await park(entry.id, message);
        result.failed.push(entry);
        continue;
      }

      const attempts = entry.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await park(entry.id, `${message} (gave up after ${attempts} tries)`);
        result.failed.push(entry);
        continue;
      }
      const retryAt = now() + backoffMs(attempts, random);
      await store.update(STORE, entry.id, (e) => (e
        ? { ...e, attempts, nextAttemptAt: retryAt, leaseUntil: 0, lastError: message }
        : e));
      result.later.push(entry);
    }

    return result;
  }

  return { add, list, has, discard, retry, retryAll, counts, flush };
}

/** A store with idb.js's shape, kept in memory — for tests and previews. */
export function memoryStore() {
  const maps = new Map();
  const m = (s) => (maps.has(s) ? maps.get(s) : maps.set(s, new Map()).get(s));
  const clone = (v) => (v === undefined ? v : structuredClone(v));
  return {
    get: async (s, k) => clone(m(s).get(k)),
    all: async (s) => [...m(s).values()].map(clone),
    put: async (s, k, v) => { m(s).set(k, clone(v)); },
    del: async (s, k) => { m(s).delete(k); },
    update: async (s, k, fn) => {
      const next = fn(clone(m(s).get(k)));
      if (next === undefined) m(s).delete(k);
      else m(s).set(k, clone(next));
      return clone(next);
    },
  };
}
