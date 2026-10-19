// The half of "see my house from anywhere" that runs on your own network.
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
//
// ── where to run it ──────────────────────────────────────
//
// On your PC this works, but only while the PC is awake — which is exactly
// not the case when you are out of the house and want the lights. So the
// same file also runs *on the hub*, where it needs nothing to be awake that
// is not already: see bridge/addon (a Home Assistant add-on) and
// bridge/install-on-pi.sh (systemd). Point HA_URL at loopback there and
// this process works out for itself that it is the one on the hub.
//
// Several relays at once is the intended setup, not a clash. Each writes its
// own heartbeat, so the dashboard can say which one is carrying the house;
// each can claim a tap, so whichever is awake obeys it; but only one of them
// — the leader, the one that can see the hub, on the hub, highest priority
// — mirrors devices, because two relays with different HA_EXCLUDE settings
// would otherwise spend the evening deleting each other's rows.
//
//   HOUSE_RELAY=kitchen-pi        this relay's id    (default: hostname)
//   HOUSE_RELAY_HOST=hub|pc       where it runs      (default: guessed)
//   HOUSE_RELAY_PRIORITY=10       who wins           (default: hub 10, pc 0)

import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadDotEnv, connect } from './env.mjs';
import * as ha from './ha.mjs';
import { commandLabel, isAction, FRESH_MS } from '../house.js';

const BEAT_MS = 10_000;        // the dashboard calls the relay off after 30s
const CLAIM_MS = 1_200;        // how often to look for a tap to obey
const SETTLE_MS = 900;         // how long a hub takes to tell the truth again

const stamp = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One line per device, so an unchanged house costs no writes at all. */
const fingerprint = (d) =>
  `${d.state}|${d.is_on}|${d.area ?? ''}|${d.name}|${JSON.stringify(d.attrs ?? {})}`;

// ── which relay this is ────────────────────────────────

const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\]|::1|supervisor|hassio|homeassistant)$/i;

/**
 * Is this process on the hub itself? Asking the user would be one more thing
 * to get wrong, and the answer is already in HA_URL: you only reach a hub
 * over loopback — or over the add-on's `supervisor` host — when you are on
 * it. HOUSE_RELAY_HOST overrides, for a setup this guess does not fit.
 */
export function relayHostOf(url = ha.config().url, env = process.env) {
  const said = String(env.HOUSE_RELAY_HOST ?? '').trim().toLowerCase();
  if (said === 'hub' || said === 'pc') return said;
  let host = '';
  try { host = new URL(url).hostname; } catch { host = ''; }
  return LOOPBACK.test(host) ? 'hub' : 'pc';
}

/** This relay's name in the table, and how much the dashboard believes it. */
export function relayIdentity(env = process.env) {
  const host = relayHostOf(ha.config().url, env);
  const id = String(env.HOUSE_RELAY ?? '').trim()
    || (host === 'hub' ? `hub-${hostname() || 'pi'}` : hostname())
    || 'relay';
  // `HOUSE_RELAY_PRIORITY=` with nothing after it is a line somebody meant
  // to fill in, not a request for priority zero — and Number('') is 0.
  const said = String(env.HOUSE_RELAY_PRIORITY ?? '').trim();
  const asked = said === '' ? Number.NaN : Number(said);
  return {
    relay: id.slice(0, 60),
    host,
    priority: Number.isFinite(asked) ? asked : (host === 'hub' ? 10 : 0),
  };
}

/**
 * Does relay `a` beat relay `b` for the job of mirroring? Deliberately a
 * total order with no ties — two relays that disagreed about who leads would
 * both write, and two that each deferred would leave the screen frozen.
 */
export function outranks(a, b) {
  const pri = (r) => Number(r.priority ?? (r.host === 'hub' ? 10 : 0)) || 0;
  if (pri(a) !== pri(b)) return pri(a) > pri(b);
  const onHub = (r) => (r.host === 'hub' ? 1 : 0);
  if (onHub(a) !== onHub(b)) return onHub(a) > onHub(b);
  return String(a.relay ?? '') < String(b.relay ?? '');
}

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
  const me = relayIdentity();
  const seen = new Map();          // entity_id -> fingerprint of the last write
  const known = new Set();         // what the table currently holds
  let primed = false;              // whether we have read that set once
  let missing = false;             // the tables are not in this project yet
  let leading = true;              // whether we are the one mirroring devices
  let saidRole = '';               // so the log says it once, not every beat
  let stop = false;

  /** Say hello, and say in the same row whether the Pi answered *us*. */
  const beat = async ({ reachable, devices, error, mirroring = leading }) => {
    if (missing) return;
    const row = await api('/house_hubs', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: {
        owner,
        relay: me.relay,
        host: me.host,
        priority: me.priority,
        mirroring,
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

  /**
   * Should this relay be the one writing devices? Yes unless another relay
   * is alive, can see the hub, and outranks us — on the hub beats on a PC,
   * and an explicit HOUSE_RELAY_PRIORITY beats both. A relay that cannot see
   * the hub never leads, which is the failover: the add-on restarting hands
   * the mirror to the PC for a minute rather than freezing the screen.
   *
   * Exported so the test can check the rule without a second process.
   */
  async function decideLead(reachable) {
    if (!reachable) return false;
    if (missing) return true;
    const rows = await api(`/house_hubs?owner=eq.${owner}&select=relay,host,priority,reachable,last_seen`)
      .catch((e) => { log(`could not read the other relays: ${e.message}`); return undefined; });
    if (rows === null) { notSetUp(); return true; }
    // Could not ask: mirror anyway. A stale screen is worse than two writers.
    if (rows === undefined) return true;

    const now = Date.now();
    return !rows.some((r) => r.relay !== me.relay
      && r.reachable !== false
      && now - (Date.parse(r.last_seen ?? '') || 0) < FRESH_MS
      && outranks(r, me));
  }

  /** Say what we settled on, once, so the log is readable on a long run. */
  const sayRole = () => {
    const role = leading ? 'mirroring' : 'standing by';
    if (role === saidRole) return;
    saidRole = role;
    log(leading
      ? `this relay (${me.relay}, ${me.host}) is mirroring the house`
      : `another relay is mirroring; ${me.relay} is standing by and will still obey taps`);
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

  /** Write these devices, whoever asked for them. */
  async function write(list) {
    if (!list.length || missing) return false;
    const written = await api('/house_devices', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: list.map((d) => ({ ...d, owner, updated_at: stamp() })),
    }).catch((e) => { log(`could not write ${list.length} devices: ${e.message}`); return undefined; });
    if (written === null) { notSetUp(); return false; }
    if (written === undefined) return false;
    for (const d of list) seen.set(d.entity_id, fingerprint(d));
    return true;
  }

  /**
   * What the hub can see, written back only where it has changed.
   *
   * `touched` is the entity a tap just changed. A standby relay writes those
   * rows and nothing else: the screen has to show what your tap did straight
   * away, but a relay that is not the leader has no business deciding which
   * devices exist.
   */
  async function sync({ touched = [] } = {}) {
    let devices;
    try {
      devices = await ha.devices();
    } catch (e) {
      leading = false;
      await beat({ reachable: false, devices: seen.size, error: e.message, mirroring: false });
      log(`hub unreachable: ${e.message}`);
      return null;
    }

    leading = await decideLead(true);
    await beat({ reachable: true, devices: devices.length, error: null });
    sayRole();

    if (!leading) {
      await write(devices.filter((d) => touched.includes(d.entity_id)));
      return devices.length;
    }

    await prime();
    const changed = devices.filter((d) => seen.get(d.entity_id) !== fingerprint(d));
    const now = new Set(devices.map((d) => d.entity_id));
    await write(changed);

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
      await sync({ touched: [cmd.entity_id] });
    } catch (e) {
      log(`that failed: ${e.message}`);
      await finish({ status: 'error', error: String(e.message ?? e).slice(0, 300) });
      const reachable = !/unreachable|no answer/i.test(e.message);
      if (!reachable) leading = false;
      await beat({ reachable, devices: seen.size, error: e.message, mirroring: reachable && leading });
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
      const me = relayIdentity();
      process.stdout.write(`\n  ${who.name}${who.version ? ` · Home Assistant ${who.version}` : ''}`
        + ` answered.\n  ${devices.length} devices worth showing`
        + `${rooms.size ? `, in ${rooms.size} rooms` : ', no rooms set'}.\n`
        + `  This relay is "${me.relay}", ${me.host === 'hub' ? 'on the hub itself'
          : 'on this PC'}, priority ${me.priority}.\n\n`
        + '  Your hub works — start the bridge.\n'
        + (me.host === 'pc'
          ? '  On a PC the house is reachable only while this machine is awake.\n'
            + '  bridge/addon runs the same relay on the hub, which always is.\n\n'
          : '\n'));
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

  const me = relayIdentity();
  log(`house relay up — ${ha.config().url} as "${ha.config().name}"`);
  log(`this relay is "${me.relay}", ${me.host === 'hub' ? 'on the hub' : 'on this PC'}`
    + `, priority ${me.priority}`);
  const house = startHouse({ api: sb.api, owner, log, once: args.includes('--once') });
  await house.done;
  process.exit(0);
}
