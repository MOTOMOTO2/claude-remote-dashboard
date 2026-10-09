// Shared rig: the fixture data, and a jsdom window with the handful of
// browser APIs jsdom leaves out. Used by the smoke test and by the design
// preview in tools/preview.mjs, so both see the same app and the same data.

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { fake } from './fake-supabase.mjs';

export const root = new URL('..', import.meta.url);
export const file = (name) => readFileSync(new URL(name, root), 'utf8');

export const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/** A believable account: two live jobs, one failure, one untouched repo. */
export function seed() {
  fake.reset();

  fake.tables.jobs = [
    {
      id: 'j1', project_slug: 'alpha', prompt: 'build a snake game', status: 'running',
      created_at: iso(12), claimed_at: iso(11), effort: 'high', usage_cap_pct: 90,
      repo_url: 'https://github.com/me/alpha', num_turns: null, error: null,
    },
    {
      id: 'j2', project_slug: 'alpha', prompt: 'add a <script>alert(1)</script> high-score list',
      status: 'done', created_at: iso(240), claimed_at: iso(239), effort: 'high',
      usage_cap_pct: 90, num_turns: 14, repo_url: 'https://github.com/me/alpha',
      live_url: 'https://alpha.fly.dev/',
    },
    {
      id: 'j3', project_slug: 'beta', prompt: 'weather site for my city', status: 'error',
      created_at: iso(600), effort: 'max', usage_cap_pct: 50,
      error: 'npm install failed: ETARGET no matching version for vite@99',
    },
    {
      id: 'j4', project_slug: 'gamma', prompt: 'port the CLI to TypeScript', status: 'paused',
      created_at: iso(30), claimed_at: iso(29), resume_at: iso(-45), effort: 'high',
    },
  ];

  // The catalogue columns are what the host fills in from GitHub, the README
  // and Fly: one project live on Fly, one on Pages, one with markup in its
  // description, and one with nothing to say for itself.
  fake.tables.projects = [
    { name: 'alpha', full_name: 'me/alpha', is_local: true, private: true, pushed_at: iso(5),
      description: 'A snake game for the browser, with a high-score list.',
      language: 'JavaScript', live_url: 'https://alpha.fly.dev/', live_kind: 'fly' },
    { name: 'beta', full_name: 'me/beta', is_local: false, private: false, pushed_at: iso(60),
      description: 'Weather for <my> city', language: 'TypeScript', topics: ['forecast'] },
    { name: 'gamma', full_name: null, is_local: true, private: false, pushed_at: iso(90),
      description: null, language: null },
    { name: 'untouched-repo', full_name: 'me/untouched-repo', is_local: false, private: true,
      pushed_at: iso(900), description: 'Notes, kept in markdown.', language: 'TypeScript',
      stars: 3, live_url: 'https://me.github.io/untouched-repo/', live_kind: 'pages' },
  ];

  fake.tables.usage_windows = [
    { window_type: 'five_hour', pct: 42, resets_at: iso(-60) },
    { window_type: 'seven_day', pct: 88, resets_at: iso(-4000) },
    { window_type: 'seven_day_opus', pct: 65, resets_at: null },
  ];

  fake.tables.job_events = [
    { id: 1, job_id: 'j1', kind: 'status', text: 'cloning alpha' },
    { id: 2, job_id: 'j1', kind: 'tool', text: 'Edit src/game.js' },
    { id: 3, job_id: 'j2', kind: 'tool', text: 'Write README.md' },
    {
      id: 4, job_id: 'j2', kind: 'result',
      text: '## Done\n\nAdded a **high-score** list with `localStorage`.\n\n'
          + '- persists across reloads\n- shows the top 10\n\n```js\nconst best = 0;\n```',
    },
  ];

  fake.tables.hosts = [{ name: 'desk-pc', last_seen: new Date().toISOString() }];
  return fake;
}

/**
 * A window the app can run in. `screen` is the knob the caller turns to say
 * how wide we are and whether the system is dark — jsdom has no matchMedia.
 */
export function makeWindow({ width = 1200, dark = false, html = file('index.html') } = {}) {
  const dom = new JSDOM(html, {
    url: 'https://local.test/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const screen = { width, dark };

  window.matchMedia = (query) => ({
    media: query,
    get matches() {
      const max = query.match(/max-width:\s*(\d+)px/);
      const min = query.match(/min-width:\s*(\d+)px/);
      if (max) return screen.width <= Number(max[1]);
      if (min) return screen.width >= Number(min[1]);
      if (query.includes('prefers-color-scheme: dark')) return screen.dark;
      return false;
    },
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  });

  // jsdom does no layout, so it never implemented scrolling.
  window.Element.prototype.scrollTo = function scrollTo(opts, y) {
    this.scrollTop = typeof opts === 'number' ? (y ?? 0) : (opts?.top ?? this.scrollTop);
  };

  // Node 24 defines some of these itself (`navigator` is getter-only), so
  // every one goes on with defineProperty rather than assignment.
  const expose = (key, value) =>
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });

  for (const key of [
    'document', 'navigator', 'localStorage', 'history', 'matchMedia', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame',
    'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent',
  ]) {
    expose(key, typeof window[key] === 'function' ? window[key].bind(window) : window[key]);
  }
  expose('window', window);
  expose('location', window.location);

  // jsdom has no Notification API; this one records what was raised.
  window.notifications = [];
  function Notification(title, opts) { window.notifications.push({ title, ...opts }); }
  Notification.permission = 'default';
  Notification.requestPermission = async () => {
    Notification.permission = 'granted';
    return 'granted';
  };
  window.Notification = Notification;

  window.CONFIG = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'anon' };
  window.confirm = () => true;
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: async () => {} }, configurable: true,
  });

  return { dom, window, screen };
}

/** Long enough for a hashchange task, its microtasks, and the next frame. */
export const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
