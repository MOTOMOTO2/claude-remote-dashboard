// The only file that knows what your hub actually is.
//
// The hub assumed here is Home Assistant on the Pi, reached over its REST
// API with a long-lived access token — the usual answer to "my Raspberry Pi
// smart home hub". Everything above this file speaks the small vocabulary in
// house.js instead (`on`, `off`, `level`, `temperature`…), so putting a
// different hub underneath is a new map in this one file and nothing else.
//
//   node bridge/ha.mjs            what it can see, as a table
//   node bridge/ha.mjs kitchen    the same, filtered
//
// Configure with HA_URL and HA_TOKEN (Home Assistant → your profile →
// Security → Long-lived access tokens). A token is a password for your
// house: it stays in bridge/.env, which is gitignored, and never reaches
// the browser.

import { pathToFileURL } from 'node:url';
import { loadDotEnv } from './env.mjs';
import { clampValue, kindOf } from '../house.js';

const env = process.env;

export const config = () => ({
  url: String(env.HA_URL ?? '').replace(/\/+$/, ''),
  token: env.HA_TOKEN ?? env.HOMEASSISTANT_TOKEN ?? '',
  name: env.HA_NAME || 'home assistant',
  /** Which sensors are worth a card. `all` keeps every one of them. */
  sensors: String(env.HA_SENSORS ?? '').trim().toLowerCase(),
  exclude: env.HA_EXCLUDE ? safeRegex(env.HA_EXCLUDE) : null,
  timeoutMs: Number(env.HA_TIMEOUT_MS ?? 8000),
});

function safeRegex(source) {
  try { return new RegExp(source, 'i'); } catch { return null; }
}

export const configured = () => Boolean(config().url && config().token);

/**
 * One request to the hub, with a timeout — a Pi that is off must not hang
 * us. `raw` is for /api/template, which answers in plain text.
 */
async function haFetch(path, { method = 'GET', body, raw = false } = {}) {
  const { url, token, timeoutMs } = config();
  if (!url) throw new Error('HA_URL is not set.');
  if (!token) throw new Error('HA_TOKEN is not set.');

  const stop = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(`${url}/api${path}`, {
      method,
      signal: stop,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    const why = e.name === 'TimeoutError' || e.name === 'AbortError'
      ? `no answer in ${Math.round(timeoutMs / 1000)}s`
      : e.cause?.code ?? e.message;
    throw new Error(`${url} unreachable (${why})`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error('HA_TOKEN was rejected — make a new long-lived access token.');
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} /api${path} → ${res.status} ${text.slice(0, 160)}`);
  if (raw) return text;
  return text ? JSON.parse(text) : null;
}

/**
 * What to call the house on the dashboard. HA_NAME wins; otherwise the hub's
 * own location name, asked for once and then remembered — "home assistant"
 * is the name of a program, not of anybody's flat.
 */
let learnedName = '';
export async function houseName() {
  if (env.HA_NAME) return env.HA_NAME;
  if (!learnedName) {
    learnedName = await haFetch('/config')
      .then((c) => String(c?.location_name ?? '').trim())
      .catch(() => '');
  }
  return learnedName || config().name;
}

/** Hello, and what version. The check `--try` and the setup script both run. */
export async function hello() {
  const body = await haFetch('/');
  const conf = await haFetch('/config').catch(() => null);
  return {
    ok: true,
    message: body?.message ?? 'running',
    name: conf?.location_name || config().name,
    version: conf?.version ?? null,
    unit: conf?.unit_system?.temperature ?? '°C',
  };
}

// ── what it can see ───────────────────────────────────────────────────

/** Domains worth a card, and the kind each one is drawn as. */
const KIND_OF_DOMAIN = {
  light: 'light',
  switch: 'switch',
  input_boolean: 'switch',
  humidifier: 'switch',
  siren: 'switch',
  fan: 'fan',
  climate: 'climate',
  water_heater: 'climate',
  cover: 'cover',
  lock: 'lock',
  media_player: 'media_player',
  scene: 'scene',
  script: 'script',
  binary_sensor: 'binary_sensor',
  sensor: 'sensor',
};

/**
 * The readings a house screen is for, as opposed to the hundred diagnostic
 * sensors a real Home Assistant install also has (wifi strength, uptime,
 * update available…). `HA_SENSORS=all` keeps the lot.
 */
const SENSOR_CLASSES = new Set(['temperature', 'humidity', 'illuminance', 'power',
  'energy', 'co2', 'carbon_dioxide', 'pm25', 'battery', 'pressure']);
const BINARY_CLASSES = new Set(['door', 'window', 'garage_door', 'opening', 'motion',
  'occupancy', 'presence', 'moisture', 'smoke', 'gas', 'safety', 'problem', 'lock']);

const ON_STATES = new Set(['on', 'open', 'opening', 'unlocked', 'playing', 'home',
  'detected', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only', 'cleaning']);

const round = (n, dp = 0) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

/** Everything about one entity that this dashboard will actually draw. */
export function toDevice(entity, areas = new Map()) {
  const entityId = String(entity?.entity_id ?? '');
  const domain = entityId.split('.')[0];
  const a = entity?.attributes ?? {};
  const kind = KIND_OF_DOMAIN[domain] ?? 'other';
  const state = String(entity?.state ?? '');

  const attrs = {};
  if (kind === 'light') {
    if (a.brightness != null) attrs.level = round((Number(a.brightness) / 255) * 100);
    const modes = Array.isArray(a.supported_color_modes) ? a.supported_color_modes : [];
    attrs.dimmable = modes.length > 0 && !(modes.length === 1 && modes[0] === 'onoff');
  }
  if (kind === 'fan' && a.percentage != null) attrs.level = round(a.percentage);
  if (kind === 'cover' && a.current_position != null) attrs.level = round(a.current_position);
  if (kind === 'climate') {
    if (a.current_temperature != null) attrs.current_temperature = round(a.current_temperature, 1);
    if (a.temperature != null) attrs.temperature = round(a.temperature, 1);
    if (a.hvac_action) attrs.hvac_action = String(a.hvac_action);
  }
  if (kind === 'media_player') {
    if (a.media_title) attrs.media_title = String(a.media_title).slice(0, 90);
    if (a.volume_level != null) attrs.level = round(Number(a.volume_level) * 100);
  }
  if (a.unit_of_measurement) attrs.unit = String(a.unit_of_measurement);
  if (a.device_class) attrs.device_class = String(a.device_class);
  if (a.battery_level != null) attrs.battery = round(a.battery_level);

  return {
    entity_id: entityId,
    name: String(a.friendly_name || entityId.split('.')[1] || entityId).replace(/_/g, ' '),
    area: areas.get(entityId) ?? null,
    kind,
    state: state.slice(0, 60),
    is_on: ON_STATES.has(state.toLowerCase()),
    attrs,
  };
}

/** Whether this entity earns a row, given how noisy a real install is. */
export function worthKeeping(device, { sensors = '', exclude = null } = {}) {
  if (!device.entity_id.includes('.')) return false;
  if (exclude?.test(device.entity_id)) return false;
  if (device.kind === 'other') return false;
  if (sensors === 'all') return true;
  const cls = String(device.attrs?.device_class ?? '').toLowerCase();
  if (device.kind === 'sensor') return SENSOR_CLASSES.has(cls);
  if (device.kind === 'binary_sensor') return BINARY_CLASSES.has(cls);
  return true;
}

/**
 * Which room each entity is in. `/api/states` does not carry areas, but the
 * template endpoint can be asked for them in one request — and a hub too old
 * to answer it just leaves every device unplaced rather than failing.
 */
const AREA_TEMPLATE = `{% for s in states %}{{ s.entity_id }}|{{ area_name(s.entity_id) or '' }}
{% endfor %}`;

export async function areas() {
  const map = new Map();
  const text = await haFetch('/template', {
    method: 'POST', raw: true, body: { template: AREA_TEMPLATE },
  }).catch(() => null);
  for (const line of String(text ?? '').split('\n')) {
    const [id, area] = line.split('|');
    if (id && area && area.trim()) map.set(id.trim(), area.trim());
  }
  return map;
}

/** Every device worth drawing, with its room, in one round trip each. */
export async function devices() {
  const cfg = config();
  const [states, where] = await Promise.all([haFetch('/states'), areas()]);
  return (Array.isArray(states) ? states : [])
    .map((e) => toDevice(e, where))
    .filter((d) => worthKeeping(d, cfg));
}

// ── doing something about it ──────────────────────────────────────────

/**
 * One of house.js's words, as the Home Assistant service call it means.
 * Returns null when that word means nothing for that device — a scene has no
 * "off", and saying so beats posting a call the hub will reject.
 */
export function serviceFor({ entity_id: entityId, action, value }) {
  const domain = String(entityId ?? '').split('.')[0];
  const kind = kindOf({ entity_id: entityId, kind: KIND_OF_DOMAIN[domain] });
  const data = { entity_id: entityId };
  const at = (service, extra) => ({ domain, service, data: { ...data, ...extra } });

  switch (action) {
    case 'on':
      if (kind === 'media_player') return at('media_play');
      if (kind === 'scene' || kind === 'script') return at('turn_on');
      return at('turn_on');
    case 'off':
      if (kind === 'media_player') return at('media_pause');
      if (kind === 'scene') return null;
      return at('turn_off');
    case 'toggle':
      if (kind === 'scene') return at('turn_on');
      if (kind === 'media_player') return at('media_play_pause');
      return at('toggle');
    case 'run':
      return at('turn_on');
    case 'open':
      return kind === 'cover' ? at('open_cover') : at('turn_on');
    case 'close':
      return kind === 'cover' ? at('close_cover') : at('turn_off');
    case 'stop':
      if (kind === 'cover') return at('stop_cover');
      if (kind === 'media_player') return at('media_stop');
      return at('turn_off');
    case 'lock':
      return kind === 'lock' ? at('lock') : null;
    case 'unlock':
      return kind === 'lock' ? at('unlock') : null;
    case 'level': {
      const pct = clampValue('level', value);
      if (pct == null) return null;
      if (kind === 'light') return at('turn_on', { brightness_pct: pct });
      if (kind === 'fan') return at('set_percentage', { percentage: pct });
      if (kind === 'cover') return at('set_cover_position', { position: pct });
      if (kind === 'media_player') return at('volume_set', { volume_level: pct / 100 });
      return null;
    }
    case 'temperature': {
      const t = clampValue('temperature', value);
      if (t == null || kind !== 'climate') return null;
      return at('set_temperature', { temperature: t });
    }
    default:
      return null;
  }
}

/** Do it. Returns the entities Home Assistant says it changed. */
export async function call(command) {
  const spec = serviceFor(command);
  if (!spec) {
    throw new Error(`"${command.action}" is not something ${command.entity_id} can do.`);
  }
  const changed = await haFetch(`/services/${spec.domain}/${spec.service}`, {
    method: 'POST',
    body: spec.data,
  });
  return Array.isArray(changed) ? changed : [];
}

/** One entity, read back — how a command confirms it actually landed. */
export const stateOf = (entityId) => haFetch(`/states/${encodeURIComponent(entityId)}`);

// ── run it on its own ─────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadDotEnv();
  const filter = process.argv.slice(2).join(' ').toLowerCase();
  try {
    const who = await hello();
    const all = await devices();
    const shown = filter
      ? all.filter((d) => `${d.name} ${d.area} ${d.entity_id}`.toLowerCase().includes(filter))
      : all;
    process.stdout.write(`\n  ${who.name}${who.version ? ` · ${who.version}` : ''} — `
      + `${all.length} devices${filter ? `, ${shown.length} matching "${filter}"` : ''}\n\n`);
    for (const d of shown.slice(0, 200)) {
      process.stdout.write(`  ${(d.area ?? '—').padEnd(14).slice(0, 14)} `
        + `${d.name.padEnd(28).slice(0, 28)} ${d.state}\n`);
    }
    process.stdout.write('\n');
  } catch (e) {
    process.stderr.write(`\n  ${e.message}\n\n`);
    process.exit(1);
  }
}
