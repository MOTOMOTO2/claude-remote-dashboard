// What this phone keeps for itself: the outbox (things you sent with no
// signal) and the saved copy (what the screens last read). IndexedDB, because
// the outbox has to survive the app being killed mid-send, which
// localStorage is too small and too synchronous to promise.
//
// Where IndexedDB is missing or refuses to open — a private window, a
// locked-down browser, the test rig — the same calls run against a Map, so
// the app still works; it just forgets on reload, and `durable()` says so.

const DB_NAME = 'claude-remote';
const DB_VERSION = 1;
export const STORES = ['outbox', 'saved', 'meta'];

let dbPromise = null;
let fallback = typeof indexedDB === 'undefined';
const memory = new Map(STORES.map((s) => [s, new Map()]));

/** Whether what is written here outlives a reload. */
export const durable = () => !fallback;

/** A copy, so a caller mutating what it read can't change what is stored. */
const clone = (v) => (v === undefined ? v : structuredClone(v));

function open() {
  if (fallback) return Promise.resolve(null);
  dbPromise ??= new Promise((resolve) => {
    const giveUp = () => { fallback = true; dbPromise = null; resolve(null); };
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch { giveUp(); return; }
    req.onupgradeneeded = () => {
      for (const s of STORES) {
        if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // A newer build in another tab needs this one to let go.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = giveUp;
    req.onblocked = giveUp;
  });
  return dbPromise;
}

/**
 * Run one request in its own transaction and resolve when the transaction
 * has committed — not when the request succeeded, which is earlier, and is
 * not yet a promise that the write survives.
 */
async function run(store, mode, make) {
  const db = await open();
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(store, mode); } catch (err) { reject(err); return; }
    let value;
    const req = make(tx.objectStore(store));
    if (req) req.onsuccess = () => { value = req.result; };
    tx.oncomplete = () => resolve(value);
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

export async function get(store, key) {
  const db = await open();
  if (!db) return clone(memory.get(store).get(key));
  return run(store, 'readonly', (s) => s.get(key));
}

export async function all(store) {
  const db = await open();
  if (!db) return [...memory.get(store).values()].map(clone);
  return run(store, 'readonly', (s) => s.getAll());
}

export async function put(store, key, value) {
  const db = await open();
  if (!db) { memory.get(store).set(key, clone(value)); return; }
  await run(store, 'readwrite', (s) => s.put(value, key));
}

export async function del(store, key) {
  const db = await open();
  if (!db) { memory.get(store).delete(key); return; }
  await run(store, 'readwrite', (s) => s.delete(key));
}

/**
 * Read, change and write one record as a single step, so two senders racing
 * for the same outbox entry cannot both come away thinking they hold it.
 * `fn` gets the current value (or undefined) and returns the next one;
 * returning undefined deletes the record. Resolves to what was written.
 */
export async function update(store, key, fn) {
  const db = await open();
  if (!db) {
    const next = fn(clone(memory.get(store).get(key)));
    if (next === undefined) memory.get(store).delete(key);
    else memory.get(store).set(key, clone(next));
    return clone(next);
  }
  let next;
  await run(store, 'readwrite', (s) => {
    const req = s.get(key);
    // Synchronously inside the success callback, so the transaction is still
    // open for the write — no await between the read and the put.
    req.onsuccess = () => {
      next = fn(req.result);
      if (next === undefined) s.delete(key);
      else s.put(next, key);
    };
    return null;
  });
  return next;
}
