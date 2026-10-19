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

import { loadDotEnv, connect } from './env.mjs';
import * as ha from './ha.mjs';
import {
  kindOf, isOn, isAway, isControllable, stateWord, detailLine, rooms, summary,
  isAction, clampValue, commandLabel, ACTIONS,
} from '../house.js';

loadDotEnv();

const sb = connect();
const { api } = sb;
const signIn = () => sb.signIn();

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
          owner: sb.owner,
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

  house_status: {
    description: 'The smart home hub: which lights and switches are on, how warm each room is, '
      + 'and whether doors and locks are shut. Give a room or a kind to see everything in it; '
      + 'with neither, it reports what is on and what is worth knowing.',
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string', description: 'A room name, e.g. "kitchen". Optional.' },
        kind: { type: 'string', description: 'light, switch, fan, climate, cover, lock, media_player, sensor. Optional.' },
      },
    },
    note: 'looking at the house',
    async run({ room, kind } = {}) {
      const { devices, from } = await readHouse();
      if (!devices.length) return houseMissing(from);
      const narrow = Boolean(room || kind);
      const picked = findDevices(devices, { room, kind });
      if (narrow && !picked.length) {
        return `Nothing in the house matches${room ? ` room "${room}"` : ''}`
          + `${kind ? ` kind "${kind}"` : ''}. Rooms: ${roomNames(devices).join(', ') || 'none set'}.`;
      }

      const s = summary(devices);
      const head = `${from} · ${s.devices} devices. ${s.sentence}.`
        + (s.away ? ` ${s.away} not answering.` : '');
      const out = [head, ''];

      for (const r of rooms(narrow ? picked : devices)) {
        // Unfiltered, a house of 200 devices is unreadable: say what is on
        // and what is being measured, and let a follow-up ask for a room.
        const show = narrow ? r.devices : r.devices.filter(worthSaying);
        if (!show.length) continue;
        out.push(`${r.area}${r.on ? ` — ${r.on} on` : ''}`);
        for (const d of show.slice(0, 60)) out.push(`  ${describe(d)}`);
      }
      if (!narrow) {
        out.push('', `Rooms: ${roomNames(devices).join(', ') || 'none set'}. `
          + 'Ask again with a room to see everything in it.');
      }
      return out.join('\n');
    },
  },

  house_control: {
    description: 'Switch something in the house on or off, lock or unlock it, open or close it, '
      + 'dim a light, or set a thermostat. Only when the user\'s latest message asks for it. '
      + 'Name the device, or give a room (and optionally a kind) to act on all of them at once.',
    parameters: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'on, off, toggle, open, close, stop, lock, unlock, run, level, temperature.' },
        device: { type: 'string', description: 'What to act on, as the hub names it, e.g. "kitchen ceiling".' },
        room: { type: 'string', description: 'A room, to act on everything in it. Defaults to lights unless a kind is given.' },
        kind: { type: 'string', description: 'Narrow a room to light, switch, fan, climate, cover, lock or media_player.' },
        value: { type: 'number', description: 'Brightness 0-100 for "level", degrees for "temperature".' },
      },
    },
    acts: true,
    note: 'changing something in the house',
    async run({ action, device, room, kind, value } = {}) {
      const act = String(action ?? '').toLowerCase();
      if (!isAction(act)) throw new Error(`"${action}" is not something I can do. Try: ${ACTIONS.join(', ')}.`);
      if (!device && !room) throw new Error('Say what to change: a device name, or a room.');
      if ((act === 'level' || act === 'temperature') && clampValue(act, value) == null) {
        throw new Error(`"${act}" needs a number — 0-100 for level, degrees for temperature.`);
      }
      if (!ha.configured()) {
        throw new Error('This PC has no hub configured. Set HA_URL and HA_TOKEN in bridge/.env.');
      }

      const { devices } = await readHouse();
      if (!devices.length) throw new Error(houseMissing('the hub'));

      // A bare room means the lights: "turn off the kitchen" never means the
      // fridge, and acting on everything in a room would be a nasty surprise.
      const assumed = !device && room && !kind && act !== 'run' ? 'light' : kind;
      let targets = findDevices(devices, { device, room, kind: assumed });
      targets = targets.filter((d) => !isAway(d));

      if (!targets.length) {
        // A near miss is worth naming, and so is a total miss: a small model
        // given nothing to go on will invent a device name and try again.
        const near = findDevices(devices, { device }).map((d) => d.name);
        const some = (near.length ? near : devices.filter(isControllable).map((d) => d.name))
          .slice(0, 6);
        throw new Error(`Nothing here matches ${device ? `"${device}"` : `room "${room}"`}`
          + `${assumed ? ` (${assumed}s)` : ''}.`
          + `${some.length ? ` Did you mean: ${some.join(', ')}?` : ''}`);
      }
      // Several things with one name is fine when they are the same sort of
      // thing ("the kitchen lights"); mixing a lamp and a lock is not.
      const kinds = new Set(targets.map(kindOf));
      if (targets.length > 1 && kinds.size > 1) {
        throw new Error(`"${device ?? room}" matches ${targets.length} different kinds of thing `
          + `(${[...kinds].join(', ')}). Say which, or add a kind.`);
      }
      if (targets.length > 12) {
        throw new Error(`That would change ${targets.length} things at once. Narrow it down.`);
      }

      const done = [];
      const failed = [];
      for (const d of targets) {
        const cmd = { entity_id: d.entity_id, action: act, value: value ?? null, name: d.name };
        try {
          await ha.call(cmd);
          done.push(d);
          await record(cmd, { status: 'done' });
        } catch (e) {
          failed.push(`${d.name}: ${e.message}`);
          await record(cmd, { status: 'error', error: e.message });
        }
      }

      // Nothing changed at all is a failure, not a report: say so loudly
      // enough that the next attempt is a different one.
      if (!done.length) throw new Error(failed.join('; '));

      const what = commandLabel({ action: act, value, name: done.map((d) => d.name).join(', ') });
      const after = await settled(done);
      return [
        done.length ? `Done — ${what}.` : 'Nothing changed.',
        after,
        failed.length ? `Failed: ${failed.join('; ')}` : '',
        assumed === 'light' && !kind ? '(Took "the room" to mean its lights.)' : '',
      ].filter(Boolean).join('\n');
    },
  },
};

// ── the house, for the two tools above ────────────────────────────────

const norm = (s) => String(s ?? '').toLowerCase().replace(/[_.\-]+/g, ' ').replace(/\s+/g, ' ').trim();

/** What people call the kinds, as the kinds house.js uses. */
const KIND_WORDS = {
  light: 'light', lights: 'light', lamp: 'light', lamps: 'light', bulb: 'light',
  switch: 'switch', switches: 'switch', plug: 'switch', socket: 'switch',
  fan: 'fan', fans: 'fan',
  climate: 'climate', thermostat: 'climate', heating: 'climate', heater: 'climate',
  cover: 'cover', covers: 'cover', blind: 'cover', blinds: 'cover', curtain: 'cover',
  curtains: 'cover', shutter: 'cover', garage: 'cover',
  lock: 'lock', locks: 'lock', door: 'lock',
  media_player: 'media_player', media: 'media_player', speaker: 'media_player', tv: 'media_player',
  scene: 'scene', scenes: 'scene', script: 'script', scripts: 'script',
  sensor: 'sensor', sensors: 'sensor', reading: 'sensor', readings: 'sensor',
  binary_sensor: 'binary_sensor', contact: 'binary_sensor', motion: 'binary_sensor',
};

const askedKind = (kind) => KIND_WORDS[norm(kind).replace(/ /g, '_')] ?? KIND_WORDS[norm(kind)] ?? null;

/**
 * The hub first, the mirror second. Your assistant runs on the same PC as
 * the relay, so asking the hub directly is both faster and fresher — but a
 * PC where only the dashboard is set up can still answer from the table.
 */
async function readHouse() {
  if (ha.configured()) {
    try {
      return { devices: await ha.devices(), from: ha.config().name };
    } catch (e) {
      const rows = await api('/house_devices?select=*&limit=400').catch(() => null);
      if (rows?.length) return { devices: rows, from: `the dashboard's last look (the hub itself: ${e.message})` };
      throw e;
    }
  }
  const rows = await api('/house_devices?select=*&limit=400').catch(() => null);
  return { devices: rows ?? [], from: "the dashboard's copy" };
}

const houseMissing = (from) => `No smart home devices are known yet (${from}). `
  + 'Set HA_URL and HA_TOKEN in bridge/.env and run: node bridge/house.mjs --try';

const roomNames = (devices) =>
  [...new Set(devices.map((d) => d.area).filter(Boolean))].sort();

/** Unfiltered, only say the things someone would actually want told. */
const worthSaying = (d) => {
  const k = kindOf(d);
  if (isAway(d)) return false;
  if (k === 'sensor' || k === 'climate' || k === 'lock') return true;
  if (k === 'scene' || k === 'script') return false;
  return isOn(d);
};

const describe = (d) => {
  const detail = detailLine(d);
  return `- ${d.name} (${kindOf(d)}): ${stateWord(d)}${detail ? ` · ${detail}` : ''}`;
};

function findDevices(all, { device, room, kind } = {}) {
  let pool = all;
  const want = kind ? askedKind(kind) : null;
  if (want) pool = pool.filter((d) => kindOf(d) === want);
  if (room) {
    const r = norm(room);
    pool = pool.filter((d) => norm(d.area).includes(r) || r.includes(norm(d.area) || '\u0000'));
  }
  if (!device) return pool;

  const q = norm(device);
  const exact = pool.filter((d) => norm(d.name) === q || norm(d.entity_id) === q);
  if (exact.length) return exact;
  const starts = pool.filter((d) => norm(d.name).startsWith(q));
  if (starts.length) return starts;
  // Every word somewhere in the name, room or id: "kitchen lights" finds the
  // two bulbs the hub calls "Kitchen ceiling" and "Kitchen under-cupboard".
  const words = q.split(' ').filter(Boolean);
  const hay = (d) => `${norm(d.name)} ${norm(d.area)} ${norm(d.entity_id)} ${kindOf(d)}s`;
  return pool.filter((d) => words.every((w) => hay(d).includes(w)));
}

/** Put it on the dashboard's activity list too, so the house has one story. */
const record = (cmd, { status, error = null }) =>
  api('/house_commands', {
    method: 'POST',
    prefer: 'return=minimal',
    body: {
      owner: sb.owner,
      entity_id: cmd.entity_id,
      name: cmd.name ?? null,
      action: cmd.action,
      value: cmd.value ?? null,
      source: 'assistant',
      status,
      error: error ? String(error).slice(0, 300) : null,
      updated_at: new Date().toISOString(),
    },
  }).catch(() => null);

/** Read back what actually happened — a hub can refuse politely. */
async function settled(devices) {
  if (!devices.length) return '';
  await new Promise((r) => setTimeout(r, 900));
  const lines = [];
  for (const d of devices.slice(0, 6)) {
    const now = await ha.stateOf(d.entity_id).catch(() => null);
    if (now) lines.push(describe(ha.toDevice(now, new Map([[d.entity_id, d.area]]))));
  }
  return lines.join('\n');
}

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
