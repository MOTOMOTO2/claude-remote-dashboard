// The PC half of "see my house from anywhere".
//
// The Pi is on your LAN. Your phone, on mobile data, is not — and opening a
// port so it could is a bad trade for something that unlocks your front
// door. So this does what the coding runner and the assistant bridge already
// do: it talks *outward* to Supabase, mirrors what the hub can see into a
// table only you can read, and claims the taps you make on the dashboard.
//
//   node bridge/house.mjs            mirror and obey, for ever
//   node bridge/house.mjs --once     one sync and whatever is queued, then stop
//   node bridge/house.mjs --try      just prove the hub answers, no Supabase
//
// It also runs inside `npm run bridge`, so one process on your PC covers the
// assistant and the house together and the logon task needs no changes.
//
//   HA_URL=http://homeassistant.local:8123
//   HA_TOKEN=...        (Home Assistant → profile → long-lived access token)
//
// Optional: HA_NAME, HA_SENSORS=all (keep every diagnostic sensor),
// HA_EXCLUDE (a regex of entity ids to skip), HA_POLL_MS.

import { pathToFileURL } from 'node:url';
import { loadDotEnv, connect } from './env.mjs';
import * as ha from './ha.mjs';
import { commandLabel, isAction } from '../house.js';

const BEAT_MS = 10_000;        // the dashboard calls the relay off after 30s
const CLAIM_MS = 1_200;        // how often to look for a tap to obey
const SETTLE_MS = 900;         // how long a hub takes to tell the truth again

const stamp = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One line per device, so an unchanged house costs no writes at all. */
const fingerprint = (d) =>
  `${d.state}|${d.is_on}|${d.area ?? ''}|${d.name}|${JSON.stringify(d.attrs ?? {})}`;

/**
 * Mirror the hub into Supabase and obey what the dashboard queues.
 *
 * @param api    the REST helper from env.mjs
 * @param owner  whose rows these are
 * @param log    where to say what happened
 * @param once   do one pass and stop, for tests and for `--once`
 */
export function startHouse({ api, owner, log = () => {}, once = false } = {}) {
  const name = () => ha.config().name;
  const seen = new Map();          // entity_id -> fingerprint of the last write
  const known = new Set();         // what the table currently holds
  let primed = false;              // whether we have read that set once
  let missing = false;             // the tables are not in this project yet
  let stop = false;

  /** Say hello, and say in the same row whether the Pi answered us. */
  const beat = async ({ reachable, devices, error }) => {
    if (missing) return;
    const row = await api('/house_hubs', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: {
        owner,
        name: name(),
        kind: 'home-assistant',
        devices,
        reachable,
        error: error ? String(error).slice(0, 300) : null,
        last_seen: stamp(),
      },
    }).catch((e) => { log(`hub heartbeat failed: ${e.message}`); return undefined; });
    // A null body is PostgREST saying the table is not there.
    if (row === null) notSetUp();
  };

  const notSetUp = () => {
    if (missing) return;
    missing = true;
    log('the house tables are not in your Supabase project yet — paste bridge/schema.sql');
  };

  /**
   * What the table already holds, read once. Without it, a device unpaired
   * while this process was not running would sit on the dashboard for ever.
   */
  async function prime() {
    if (primed) return;
    primed = true;
    const rows = await api('/house_devices?select=entity_id').catch(() => undefined);
    if (rows === null) { notSetUp(); return; }
    for (const r of rows ?? []) known.add(r.entity_id);
  }

  /** What the hub can see, written back only where it has changed. */
  async function sync() {
    await prime();
    let devices;
    try {
      devices = await ha.devices();
    } catch (e) {
      await beat({ reachable: false, devices: seen.size, error: e.message });
      log(`hub unreachable: ${e.message}`);
      return null;
    }

    const changed = devices.filter((d) => seen.get(d.entity_id) !== fingerprint(d));
    const now = new Set(devices.map((d) => d.entity_id));

    if (changed.length && !missing) {
      const written = await api('/house_devices', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: changed.map((d) => ({ ...d, owner, updated_at: stamp() })),
      }).catch((e) => { log(`could not write ${changed.length} devices: ${e.message}`); return undefined; });
      if (written === null) notSetUp();
      else if (written !== undefined) {
        for (const d of changed) seen.set(d.entity_id, fingerprint(d));
      }
    }

    // Something unpaired from the hub should not sit on the dashboard for ever.
    const gone = [...known].filter((id) => !now.has(id) && /^[\w.]+$/.test(id));
    if (gone.length && !missing) {
      const list = gone.map((id) => `"${id}"`).join(',');
      // The owner filter matters with the service-role key, where there is no
      // row-level security to add it for us.
      await api(`/house_devices?owner=eq.${owner}&entity_id=in.(${list})`, { method: 'DELETE' })
        .catch((e) => log(`could not drop ${gone.length} gone devices: ${e.message}`));
      for (const id of gone) seen.delete(id);
    }
    known.clear();
    for (const id of now) known.add(id);

    await beat({ reachable: true, devices: devices.length, error: null });
    return devices.length;
  }

  /** The oldest tap waiting, claimed so two relays cannot both run it. */
  async function claim() {
    if (missing) return null;
    const queued = await api('/house_commands?status=eq.queued&order=created_at.asc&limit=1');
    if (queued === null) { notSetUp(); return null; }
    const next = queued?.[0];
    if (!next) return null;

    // The status filter is the lock: a second relay gets an empty array.
    const taken = await api(`/house_commands?id=eq.${next.id}&status=eq.queued`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: { status: 'running', updated_at: stamp() },
    });
    return taken?.[0] ?? null;
  }

  async function obey(cmd) {
    const said = commandLabel(cmd);
    log(said);
    const finish = (patch) => api(`/house_commands?id=eq.${cmd.id}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { ...patch, updated_at: stamp() },
    }).catch((e) => log(`could not close that command: ${e.message}`));

    if (!isAction(cmd.action)) {
      await finish({ status: 'error', error: `"${cmd.action}" is not something I know how to do.` });
      return;
    }

    try {
      await ha.call({ entity_id: cmd.entity_id, action: cmd.action, value: cmd.value });
      await finish({ status: 'done', error: null });
      // Lights report their new brightness a moment after the call returns,
      // so the screen gets the truth rather than the state we just left.
      await sleep(SETTLE_MS);
      await sync();
    } catch (e) {
      log(`that failed: ${e.message}`);
      await finish({ status: 'error', error: String(e.message ?? e).slice(0, 300) });
      await beat({ reachable: !/unreachable|no answer/i.test(e.message), devices: seen.size, error: e.message });
    }
  }

  async function loop() {
    const pollMs = Number(process.env.HA_POLL_MS ?? BEAT_MS);
    let lastSync = 0;
    for (;;) {
      if (stop) return;
      try {
        if (Date.now() - lastSync >= pollMs) {
          lastSync = Date.now();
          await sync();
        }
        const cmd = await claim();
        if (cmd) await obey(cmd);
        if (once) return;
        if (!cmd) await sleep(CLAIM_MS);
      } catch (e) {
        log(`house loop: ${e.message}`);
        await sleep(5_000);
      }
    }
  }

  const done = loop();
  return { done, stop: () => { stop = true; }, sync };
}

// ── run it on its own ─────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadDotEnv();
  const args = process.argv.slice(2);
  const die = (msg) => { process.stderr.write(`\n  ${msg}\n\n`); process.exit(1); };
  const log = (...a) => console.log(stamp().slice(11, 19), ...a);

  if (!ha.configured()) {
    die('Set HA_URL and HA_TOKEN in bridge/.env first.\n'
      + '  HA_URL=http://homeassistant.local:8123\n'
      + '  HA_TOKEN=  (Home Assistant → your profile → Security → long-lived access token)');
  }

  if (args.includes('--try')) {
    try {
      const who = await ha.hello();
      const devices = await ha.devices();
      const rooms = new Set(devices.map((d) => d.area).filter(Boolean));
      process.stdout.write(`\n  ${who.name}${who.version ? ` · Home Assistant ${who.version}` : ''}`
        + ` answered.\n  ${devices.length} devices worth showing`
        + `${rooms.size ? `, in ${rooms.size} rooms` : ', no rooms set'}.\n\n`
        + '  Your hub works — start the bridge.\n\n');
      process.exit(0);
    } catch (e) {
      die(`That failed: ${e.message}`);
    }
  }

  const sb = connect();
  if (!sb.url) die('SUPABASE_URL is not set. Run npm run bridge:setup.');
  await sb.signIn().catch((e) => die(e.message));
  const owner = await sb.findOwner();
  if (!owner) {
    die('Could not work out which account this is. Open the dashboard once, or set OWNER_ID.');
  }

  log(`house relay up — ${ha.config().url} as "${ha.config().name}"`);
  const house = startHouse({ api: sb.api, owner, log, once: args.includes('--once') });
  await house.done;
  process.exit(0);
}
