// Your house, as rows. The Raspberry Pi hub is on your LAN and your phone is
// not, so this is the same relay the agents and the assistant already use:
// something on your network talks to the hub locally, mirrors what it sees
// into Supabase, and claims the commands you write from here.
//
// Pure — rows already in memory in, plain data out — so views.js only draws
// it, bridge/ha.mjs maps it onto Home Assistant services, and the smoke test
// can check all of it against fixed inputs.
//
// Two things can be down and they mean different things, so nothing here
// ever collapses them: a *relay* is the process that carries the house out,
// the *hub* is the Pi behind it. "waiting for your PC" and "the hub did not
// answer" are different problems with different fixes, and saying the wrong
// one wastes an evening.
//
// There can be more than one relay, which is the whole point of
// bridge/addon: the hub is on all the time and your PC is not, so a relay
// running on the hub itself is the one that makes this screen work when you
// are out. These functions take every heartbeat and pick the relay actually
// carrying the house, so an asleep PC alongside a live Pi reads as *online*
// rather than as a problem.

/** A hub heartbeat older than this and the relay is not there. Same as a host. */
export const FRESH_MS = 30_000;

const time = (iso) => Date.parse(iso ?? '') || 0;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const lower = (s) => String(s ?? '').toLowerCase();

// ── what a device is ──────────────────────────────────────────────────
// The kinds this app draws, in the order a person looks for them. Anything
// the hub reports outside this list is still stored and still listed, it
// just gets the plain treatment.

export const KINDS = {
  light: { label: 'Lights', one: 'light', icon: 'bulb' },
  switch: { label: 'Switches', one: 'switch', icon: 'plug' },
  fan: { label: 'Fans', one: 'fan', icon: 'fan' },
  climate: { label: 'Heating', one: 'thermostat', icon: 'thermometer' },
  cover: { label: 'Blinds & doors', one: 'cover', icon: 'blinds' },
  lock: { label: 'Locks', one: 'lock', icon: 'lock' },
  media_player: { label: 'Media', one: 'speaker', icon: 'speaker' },
  scene: { label: 'Scenes', one: 'scene', icon: 'wand' },
  script: { label: 'Scripts', one: 'script', icon: 'flow' },
  binary_sensor: { label: 'Contacts & motion', one: 'sensor', icon: 'pulse' },
  sensor: { label: 'Readings', one: 'sensor', icon: 'gauge' },
  other: { label: 'Everything else', one: 'device', icon: 'server' },
};

export const kindOf = (device) => {
  const k = lower(device?.kind) || lower(device?.entity_id).split('.')[0];
  return k in KINDS ? k : 'other';
};

export const kindLabel = (kind) => KINDS[kind]?.label ?? KINDS.other.label;
export const kindIcon = (kind) => KINDS[kind]?.icon ?? KINDS.other.icon;

/** Something you can switch, as opposed to something you can only read. */
const SWITCHABLE = new Set(['light', 'switch', 'fan', 'media_player']);
export const isControllable = (device) => {
  const k = kindOf(device);
  return SWITCHABLE.has(k) || k === 'cover' || k === 'lock' || k === 'climate'
    || k === 'scene' || k === 'script';
};

/**
 * Is it on? `is_on` is what the bridge worked out from the hub's own state
 * string; this falls back to reading that string so a row written by an
 * older bridge still draws correctly.
 */
export function isOn(device) {
  if (typeof device?.is_on === 'boolean') return device.is_on;
  const s = lower(device?.state);
  return s === 'on' || s === 'open' || s === 'unlocked' || s === 'playing'
    || s === 'heat' || s === 'cool' || s === 'heat_cool' || s === 'auto'
    || s === 'home' || s === 'detected';
}

/**
 * Unavailable is not off — a bulb at the wall and a bulb unplugged differ.
 * A scene or a script is the exception: it has no state of its own to be
 * unavailable in, and hubs report it as `unknown` until it is first used.
 */
export const isAway = (device) => {
  const k = kindOf(device);
  if (k === 'scene' || k === 'script') return false;
  const s = lower(device?.state);
  return s === 'unavailable' || s === 'unknown' || s === '';
};

const attrs = (device) => (device?.attrs && typeof device.attrs === 'object' ? device.attrs : {});

/** The word on the card: what the hub says, tidied for a human. */
export function stateWord(device) {
  if (isAway(device)) return 'unavailable';
  const k = kindOf(device);
  const a = attrs(device);
  const s = String(device?.state ?? '').replace(/_/g, ' ');
  if (k === 'sensor') {
    const unit = a.unit ? `${a.unit}` : '';
    return unit ? `${s}${unit.startsWith('°') ? '' : ' '}${unit}` : s;
  }
  if (k === 'climate') {
    const target = num(a.temperature);
    return target == null ? s : `${s} · ${target}°`;
  }
  return s;
}

/**
 * The second line: the detail that makes the state useful. Brightness for a
 * light, the room temperature for a thermostat, what is playing on a
 * speaker, how long a contact has been as it is.
 */
export function detailLine(device) {
  const k = kindOf(device);
  const a = attrs(device);
  const bits = [];

  if (k === 'light' && isOn(device) && num(a.level) != null) bits.push(`${Math.round(a.level)}%`);
  if (k === 'light' && a.color) bits.push(String(a.color));
  if (k === 'climate') {
    const now = num(a.current_temperature);
    const target = num(a.temperature);
    if (now != null) bits.push(`now ${now}°`);
    if (target != null) bits.push(`set ${target}°`);
    if (a.hvac_action) bits.push(String(a.hvac_action));
  }
  if (k === 'media_player' && a.media_title) bits.push(String(a.media_title));
  if (k === 'fan' && num(a.level) != null && isOn(device)) bits.push(`${Math.round(a.level)}%`);
  if (k === 'cover' && num(a.level) != null) bits.push(`${Math.round(a.level)}% open`);
  if (k === 'sensor' && a.device_class) bits.push(String(a.device_class));
  if (num(a.battery) != null && num(a.battery) <= 25) bits.push(`battery ${Math.round(a.battery)}%`);

  return bits.join(' · ');
}

// ── what you can do to it ─────────────────────────────────────────────
// One small vocabulary, shared by the three things that speak it: this
// screen, your assistant's tools, and the bridge that turns it into a Home
// Assistant service call. Adding a hub later means a new map in ha.mjs, not
// a new word here.

export const ACTIONS = ['on', 'off', 'toggle', 'open', 'close', 'stop',
  'lock', 'unlock', 'run', 'level', 'temperature'];

export const isAction = (a) => ACTIONS.includes(String(a ?? '').toLowerCase());

/** Actions that carry a number, and the range that number has to be in. */
export const RANGE = {
  level: { min: 0, max: 100, unit: '%' },
  temperature: { min: 5, max: 32, unit: '°' },
};

/** The buttons one card gets. The first is the one a tap on the card runs. */
export function actionsFor(device) {
  const k = kindOf(device);
  const on = isOn(device);
  if (k === 'scene' || k === 'script') {
    return [{ action: 'run', label: k === 'scene' ? 'set' : 'run', icon: 'spark' }];
  }
  if (k === 'lock') {
    return on
      ? [{ action: 'lock', label: 'lock', icon: 'lock' }]
      : [{ action: 'unlock', label: 'unlock', icon: 'unlock' }];
  }
  if (k === 'cover') {
    return [
      on ? { action: 'close', label: 'close', icon: 'down' }
        : { action: 'open', label: 'open', icon: 'up' },
      { action: 'stop', label: 'stop', icon: 'stop' },
    ];
  }
  if (k === 'climate') {
    // `inline` keeps these off the card itself: a thumb landing anywhere on
    // a thermostat and silently making the flat warmer is not a tap anyone
    // meant, so all three are buttons you have to aim at.
    return [
      { action: 'temperature', label: 'warmer', icon: 'up', step: +0.5, inline: true },
      { action: 'temperature', label: 'cooler', icon: 'down', step: -0.5, inline: true },
      on ? { action: 'off', label: 'off', icon: 'stop', inline: true }
        : { action: 'on', label: 'on', icon: 'spark', inline: true },
    ];
  }
  if (SWITCHABLE.has(k)) {
    return [on
      ? { action: 'off', label: 'turn off', icon: 'stop' }
      : { action: 'on', label: 'turn on', icon: 'spark' }];
  }
  return [];
}

/** A light you can dim, as opposed to one that is only ever on or off. */
export const isDimmable = (device) =>
  (kindOf(device) === 'light' || kindOf(device) === 'fan') && attrs(device).dimmable !== false;

/** Clamp a number onto whatever the action will accept. */
export function clampValue(action, value) {
  const range = RANGE[action];
  const n = num(value);
  if (!range || n == null) return null;
  return Math.min(range.max, Math.max(range.min, Math.round(n * 2) / 2));
}

/** What the thermostat should be set to for one nudge up or down. */
export function nudged(device, step) {
  const a = attrs(device);
  const from = num(a.temperature) ?? num(a.current_temperature) ?? 20;
  return clampValue('temperature', from + step);
}

/** The sentence a queued command writes while it is in flight. */
export function commandLabel({ action, value, name } = {}) {
  const who = name ? `${name}` : 'it';
  const v = num(value);
  switch (action) {
    case 'on': return `turning ${who} on`;
    case 'off': return `turning ${who} off`;
    case 'toggle': return `switching ${who}`;
    case 'open': return `opening ${who}`;
    case 'close': return `closing ${who}`;
    case 'stop': return `stopping ${who}`;
    case 'lock': return `locking ${who}`;
    case 'unlock': return `unlocking ${who}`;
    case 'run': return `running ${who}`;
    case 'level': return `setting ${who} to ${v ?? '?'}%`;
    case 'temperature': return `setting ${who} to ${v ?? '?'}°`;
    default: return `working on ${who}`;
  }
}

// ── the hub, and the relays in front of it ─────────────────

/**
 * Where a relay runs, which is really the question "what has to be awake for
 * my house to be reachable?". A relay on the hub itself answers *nothing
 * extra* — the hub is already on — and that is the difference between a
 * house you can reach from the bus and one you can reach from the sofa.
 */
export const RELAY_HOSTS = {
  hub: {
    label: 'on the hub',
    long: 'on the hub itself',
    note: 'The hub is already on all the time, so nothing else has to be.',
  },
  pc: {
    label: 'on your PC',
    long: 'on your PC',
    note: 'Reachable for as long as the PC is awake.',
  },
};

export const relayHost = (row) => (row?.host === 'hub' ? 'hub' : 'pc');
export const relayHostLabel = (host) => RELAY_HOSTS[host]?.label ?? RELAY_HOSTS.pc.label;

const relayId = (row) => String(row?.relay ?? '').trim() || 'relay';

/**
 * Which relay to believe. A relay that can see the hub beats one that cannot,
 * a relay on the hub beats one on a PC, and an explicit priority beats both —
 * so a Pi and a desktop both relaying never flap between two answers.
 */
const rank = (r) => [
  Number(r.reachable) || 0,
  Number(r.priority ?? (relayHost(r) === 'hub' ? 10 : 0)) || 0,
  relayHost(r) === 'hub' ? 1 : 0,
];

const better = (a, b) => {
  const [x, y] = [rank(a), rank(b)];
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
  // Same on every count: the id, so two relays never disagree about which
  // of them is the one being drawn.
  return relayId(a) < relayId(b);
};

/**
 * Every heartbeat, as something a screen can list: who it is, where it runs,
 * whether it is alive, and whether the hub answered *it* — the live ones
 * first, and the one carrying the house first of those.
 */
export function relays(hubs, now = Date.now()) {
  const rows = (Array.isArray(hubs) ? hubs : [hubs]).filter(Boolean);
  const list = rows.map((row) => {
    const online = time(row.last_seen) > 0 && now - time(row.last_seen) < FRESH_MS;
    return {
      id: relayId(row),
      name: row.name || 'your hub',
      kind: row.kind || null,
      host: relayHost(row),
      where: relayHostLabel(relayHost(row)),
      online,
      // A dead relay tells you nothing about the hub, so it claims nothing.
      reachable: online && row.reachable !== false,
      mirroring: row.mirroring === true,
      priority: Number(row.priority ?? (relayHost(row) === 'hub' ? 10 : 0)) || 0,
      devices: Number(row.devices ?? 0) || 0,
      lastSeen: row.last_seen ?? null,
      error: row.error || null,
    };
  });

  return list.sort((a, b) => (Number(b.online) - Number(a.online))
    || (better(a, b) ? -1 : better(b, a) ? 1 : 0)
    || a.id.localeCompare(b.id));
}

/**
 * Where the house actually is. Four shapes, because collapsing them is the
 * one thing that makes this screen useless:
 *
 *   never     nothing has ever checked in — the setup card
 *   relay-off every relay is asleep; commands will wait
 *   hub-off   a relay is up but the Pi did not answer it
 *   ok        both halves are there
 *
 * Takes one heartbeat row or all of them. With several, the best one is the
 * answer — a PC that went to sleep hours ago must not make a live Pi look
 * broken — and the rest ride along in `relays` for the screen to list.
 */
export function hubPresence(hubs, now = Date.now()) {
  const all = relays(hubs, now);
  if (!all.length) {
    return {
      known: false, relayOnline: false, hubOnline: false,
      name: 'your hub', kind: null, devices: 0, lastSeen: null, error: null,
      relays: [], relay: null, host: null, onHub: false, needsPc: false, online: 0,
    };
  }

  // Alive and answering, else alive, else whatever last said anything.
  const best = all.find((r) => r.reachable) ?? all.find((r) => r.online) ?? all[0];
  const online = all.filter((r) => r.online).length;

  return {
    known: true,
    relayOnline: best.online,
    hubOnline: best.reachable,
    name: best.name,
    kind: best.kind,
    devices: best.devices || all.reduce((n, r) => Math.max(n, r.devices), 0),
    // The freshest word from anything, so "last heard" is not a dead relay's.
    lastSeen: all.reduce((latest, r) => (time(r.lastSeen) > time(latest) ? r.lastSeen : latest),
      best.lastSeen),
    error: best.error,
    relays: all,
    relay: best.id,
    host: best.host,
    onHub: best.host === 'hub',
    /** No relay on the hub, so being reachable costs you a PC left awake. */
    needsPc: all.every((r) => r.host !== 'hub'),
    online,
  };
}

export function hubState(who) {
  if (!who?.known) {
    return {
      kind: 'never',
      label: 'no hub yet',
      note: 'Nothing has checked in. Put a relay next to the hub — on the hub itself, '
        + 'or on your PC — and this screen fills itself in.',
    };
  }
  if (!who.relayOnline) {
    const asleep = who.needsPc
      ? 'The relay on your PC is not running, so the house cannot be reached from here. '
      : 'No relay is checking in, so the house cannot be reached from here. ';
    return {
      kind: 'relay-off',
      label: who.needsPc ? 'waiting for your PC' : 'no relay running',
      note: `${asleep}Anything you tap waits in the queue and runs when one is back.`
        + (who.needsPc
          ? ' A relay on the hub itself would not need the PC at all — see bridge/addon.'
          : ''),
    };
  }
  if (!who.hubOnline) {
    return {
      kind: 'hub-off',
      label: 'hub not answering',
      note: `The relay ${who.relays.find((r) => r.online)?.where ?? 'on your PC'} is up but `
        + `${who.name} did not answer it${who.error ? `: ${who.error}` : ''}. `
        + 'Check the Pi is on and on the same network.',
    };
  }
  return {
    kind: 'ok',
    label: 'online',
    note: `${who.name} is answering, relayed ${RELAY_HOSTS[who.host]?.long ?? 'on your PC'}. `
      + `Taps take effect now. ${RELAY_HOSTS[who.host]?.note ?? ''}`.trim(),
  };
}

// ── grouping and counting ─────────────────────────────────────────────

const UNPLACED = 'No room set';

const byName = (a, b) => String(a.name ?? a.entity_id).localeCompare(String(b.name ?? b.entity_id));

/**
 * The house, by room. Rooms with something switched on come first — the
 * question this screen answers most often is "what did I leave on?".
 */
export function rooms(devices = []) {
  const byArea = new Map();
  for (const d of devices) {
    const area = String(d.area ?? '').trim() || UNPLACED;
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push(d);
  }

  return [...byArea.entries()]
    .map(([area, list]) => {
      const sorted = [...list].sort((a, b) => {
        const ka = Object.keys(KINDS).indexOf(kindOf(a));
        const kb = Object.keys(KINDS).indexOf(kindOf(b));
        return (ka - kb) || byName(a, b);
      });
      const lit = sorted.filter((d) => isOn(d) && isControllable(d));
      return {
        area,
        placed: area !== UNPLACED,
        devices: sorted,
        on: lit.length,
        lights: sorted.filter((d) => kindOf(d) === 'light' && isOn(d)).length,
        away: sorted.filter(isAway).length,
      };
    })
    .sort((a, b) => (Number(b.on > 0) - Number(a.on > 0))
      || Number(a.placed === false) - Number(b.placed === false)
      || a.area.localeCompare(b.area));
}

/** One line for the home screen, and the hero figure above it. */
export function summary(devices = []) {
  const lights = devices.filter((d) => kindOf(d) === 'light');
  const lit = lights.filter(isOn);
  const open = devices.filter((d) => kindOf(d) === 'cover' && isOn(d));
  // A lock reports `unlocked` as its on-state, so an unlocked door is the
  // one that is "on" — the opposite of the reading a glance would give it.
  const unlocked = devices.filter((d) => kindOf(d) === 'lock' && isOn(d) && !isAway(d));
  const away = devices.filter(isAway);

  // Indoors beats outdoors for the one temperature a card has room for.
  const temps = devices
    .filter((d) => kindOf(d) === 'climate' && num(attrs(d).current_temperature) != null)
    .map((d) => num(attrs(d).current_temperature))
    .concat(devices
      .filter((d) => kindOf(d) === 'sensor' && lower(attrs(d).device_class) === 'temperature')
      .map((d) => num(d.state))
      .filter((n) => n != null));
  const temperature = temps.length
    ? Math.round((temps.reduce((a, b) => a + b, 0) / temps.length) * 10) / 10
    : null;

  const bits = [];
  if (lights.length) bits.push(lit.length ? `${lit.length} of ${lights.length} lights on` : 'lights all off');
  if (temperature != null) bits.push(`${temperature}°`);
  if (open.length) bits.push(`${open.length} open`);
  if (unlocked.length) bits.push(`${unlocked.length} unlocked`);
  if (!bits.length && devices.length) bits.push(`${devices.length} devices`);

  return {
    devices: devices.length,
    lights: lights.length,
    lit: lit.length,
    on: devices.filter((d) => isOn(d) && isControllable(d)).length,
    open: open.length,
    unlocked: unlocked.length,
    away: away.length,
    temperature,
    sentence: bits.join(' · ') || 'nothing reported yet',
  };
}

/** Everything lit that a tap could turn off — what "all lights off" means. */
export const litLights = (devices = []) =>
  devices.filter((d) => kindOf(d) === 'light' && isOn(d) && !isAway(d));

// ── commands in flight ────────────────────────────────────────────────

export const isQueued = (c) => c?.status === 'queued' || c?.status === 'running';

/**
 * entity_id -> the newest command still in flight for it, so a card can say
 * "turning off…" rather than silently showing the old state for two seconds.
 */
export function pendingBy(commands = []) {
  const map = new Map();
  for (const c of commands) {
    if (!isQueued(c) || !c.entity_id) continue;
    const held = map.get(c.entity_id);
    if (!held || time(c.created_at) >= time(held.created_at)) map.set(c.entity_id, c);
  }
  return map;
}

/** The last few things that happened, newest first — the activity list. */
export function recent(commands = [], n = 8) {
  return [...commands]
    .sort((a, b) => time(b.created_at) - time(a.created_at))
    .slice(0, n);
}

/** Openers for a house nobody has asked anything about yet. */
export const HOUSE_ASKS = [
  { icon: 'bulb', text: 'Which lights are on in the house right now?' },
  { icon: 'thermometer', text: 'How warm is it at home, and is the heating on?' },
  { icon: 'lock', text: 'Is everything locked and shut downstairs?' },
  { icon: 'wand', text: 'Turn off all the lights except the hallway.' },
];
