import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const cfg = window.CONFIG ?? {};
if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
  document.body.innerHTML =
    '<p style="padding:2rem;font-family:system-ui">Copy <code>config.example.js</code> to ' +
    '<code>config.js</code> and fill in your Supabase URL and anon key.</p>';
  throw new Error('missing config');
}

// The session is kept in localStorage and refreshed in the background, so you
// sign in once per device. On iOS a home-screen install has its own storage,
// separate from Safari — the first sign-in has to happen inside the app.
const sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: 'claude-remote-auth',
  },
});

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ─────────────────────────────────────────────── state

/** jobId -> job row */    const jobs = new Map();
/** jobId -> event rows */ const events = new Map();
let projects = [];
let usage = [];
let channels = [];
let route = { view: 'new' };

const ACTIVE = new Set(['queued', 'running', 'paused']);
const isActive = (j) => ACTIVE.has(j.status);

// ─────────────────────────────────────────────── formatting

function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function elapsed(from) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(from)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

const clock = (iso) => new Date(iso)
  .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// ─────────────────────────────────────────────── routing

function readHash() {
  const h = location.hash.replace(/^#\/?/, '');
  if (h.startsWith('p/')) return { view: 'project', slug: decodeURIComponent(h.slice(2)) };
  if (h.startsWith('j/')) return { view: 'pending', jobId: h.slice(2) };
  return { view: 'new' };
}

const go = (hash) => { location.hash = hash; };

window.addEventListener('hashchange', () => {
  route = readHash();
  closeDrawer();
  renderView();
});

// ─────────────────────────────────────────────── drawer

function openDrawer() {
  $('drawer').hidden = false;
  $('scrim').hidden = false;
  $('menu-open').setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => $('drawer').classList.add('open'));
}

function closeDrawer() {
  $('drawer').classList.remove('open');
  $('scrim').hidden = true;
  $('menu-open').setAttribute('aria-expanded', 'false');
  setTimeout(() => {
    if (!$('drawer').classList.contains('open')) $('drawer').hidden = true;
  }, 200);
}

$('menu-open').addEventListener('click', openDrawer);
$('menu-close').addEventListener('click', closeDrawer);
$('scrim').addEventListener('click', closeDrawer);
$('new-project').addEventListener('click', () => go('#/new'));

/**
 * Projects that have actually been worked on read as chats, with their latest
 * message as a preview. Repos with no history sit below as things you could
 * start a chat on — the host clones them on first use.
 */
function renderDrawer() {
  const latest = new Map();
  for (const j of jobs.values()) {
    if (!j.project_slug) continue;
    const cur = latest.get(j.project_slug);
    if (!cur || new Date(j.created_at) > new Date(cur.created_at)) {
      latest.set(j.project_slug, j);
    }
  }

  const chats = [...latest.entries()]
    .sort((a, b) => new Date(b[1].created_at) - new Date(a[1].created_at));
  const chatSlugs = new Set(latest.keys());
  const untouched = projects.filter((p) => !chatSlugs.has(p.name));

  const row = (slug, sub, badge) => `
    <a class="drawer-item ${route.slug === slug ? 'current' : ''}"
       href="#/p/${encodeURIComponent(slug)}">
      <span class="di-top">
        <span class="di-name">${esc(slug)}</span>
        ${badge ?? ''}
      </span>
      ${sub ? `<span class="di-sub">${esc(sub)}</span>` : ''}
    </a>`;

  $('drawer-list').innerHTML =
    (chats.length
      ? '<p class="drawer-label">Chats</p>' + chats.map(([slug, j]) => row(
          slug,
          j.prompt,
          isActive(j)
            ? `<span class="di-badge ${j.status}">${j.status}</span>`
            : `<span class="di-when">${ago(j.created_at)}</span>`,
        )).join('')
      : '') +
    (untouched.length
      ? '<p class="drawer-label">Your repos</p>' + untouched.map((p) => row(
          p.name, '', p.is_local ? '' : '<span class="di-when">clone</span>',
        )).join('')
      : '') +
    (!chats.length && !untouched.length
      ? '<p class="drawer-label">No projects yet — start one above.</p>'
      : '');
}

// ─────────────────────────────────────────────── usage meters

const WINDOW_LABEL = {
  five_hour: 'session · 5 hours',
  seven_day: 'week · 7 days',
  seven_day_opus: 'week · Opus',
  seven_day_sonnet: 'week · Sonnet',
  seven_day_overage_included: 'week · incl. overage',
  overage: 'overage',
};
const WINDOW_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

function usageHtml() {
  const rows = usage
    .filter((r) => r.pct != null)
    .sort((a, b) => {
      const ai = WINDOW_ORDER.indexOf(a.window_type);
      const bi = WINDOW_ORDER.indexOf(b.window_type);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  if (!rows.length) return '';

  return rows.map((r) => {
    const pct = Number(r.pct);
    const tone = pct >= 85 ? 'full' : pct >= 60 ? 'warn' : '';
    const resets = r.resets_at && new Date(r.resets_at) > new Date()
      ? `resets ${clock(r.resets_at)}` : '';
    return `
      <div class="usage-row ${tone}">
        <div class="usage-head">
          <span>${esc(WINDOW_LABEL[r.window_type] ?? r.window_type)}</span>
          <span class="usage-pct">${pct.toFixed(0)}%</span>
        </div>
        <div class="usage-bar"><i style="width:${Math.min(100, pct)}%"></i></div>
        <p class="muted">${esc(resets)}&nbsp;</p>
      </div>`;
  }).join('');
}

function renderUsage() {
  const html = usageHtml();
  for (const id of ['usage-new', 'usage-drawer']) {
    $(id).innerHTML = html;
    $(id).hidden = !html;
  }
}

// ─────────────────────────────────────────────── thread

const logLine = (e) => `<span class="l-${e.kind}">${esc(e.text)}</span>\n`;

/** The agent's reply: its closing summary, or the live log while it works. */
function replyHtml(job) {
  const log = events.get(job.id) ?? [];
  const result = [...log].reverse().find((e) => e.kind === 'result');
  const last = [...log].reverse().find((e) => e.kind === 'tool' || e.kind === 'status');
  const live = isActive(job);

  const timer = live && job.status !== 'paused'
    ? `<span class="msg-time" data-elapsed="${job.claimed_at ?? job.created_at}">${elapsed(job.claimed_at ?? job.created_at)}</span>`
    : job.num_turns ? `<span class="msg-time">${job.num_turns} turns</span>` : '';

  const paused = job.status === 'paused' ? `
    <p class="job-paused">Usage limit reached. This picks up automatically where
      it left off${job.resume_at ? ` at ${clock(job.resume_at)}` : ''} — nothing
      for you to do.</p>` : '';

  const body = result
    ? `<div class="msg-body">${esc(result.text)}</div>`
    : live && last ? `<p class="msg-now">${esc(last.text)}</p>` : '';

  const logBlock = !log.length ? '' : live
    ? `<div class="log" data-log="${job.id}">${log.map(logLine).join('')}</div>`
    : `<details class="log-fold"><summary>show log</summary>
         <div class="log">${log.map(logLine).join('')}</div></details>`;

  return `
    <div class="msg agent">
      <div class="msg-status ${job.status}">
        <i class="dot"></i><span>${job.status}</span>${timer}
      </div>
      ${paused}
      ${body}
      ${logBlock}
      ${job.error ? `<p class="error">${esc(job.error)}</p>` : ''}
      <div class="msg-actions">
        ${job.repo_url ? `<a href="${esc(job.repo_url)}" target="_blank" rel="noopener">repo &#8599;</a>` : ''}
        ${live && !job.cancel_requested ? `<button class="ghost" data-cancel="${job.id}">cancel</button>` : ''}
        ${job.cancel_requested && live ? '<span class="muted small">stopping…</span>' : ''}
      </div>
    </div>`;
}

function renderThread() {
  const mine = [...jobs.values()]
    .filter((j) => j.project_slug === route.slug)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  // Keep the reading position of any log the user is scrolled into.
  const scrolls = new Map();
  for (const el of document.querySelectorAll('[data-log]')) {
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    scrolls.set(el.dataset.log, atBottom ? null : el.scrollTop);
  }

  $('thread').innerHTML = mine.length
    ? mine.map((job) => `
        <div class="turn">
          <div class="msg you">${esc(job.prompt)}</div>
          ${replyHtml(job)}
        </div>`).join('')
    : `<p class="muted centered-note">Nothing here yet. Send a message to start
         working on <strong>${esc(route.slug)}</strong> — it gets cloned to your
         desktop on first use.</p>`;

  for (const el of document.querySelectorAll('[data-log]')) {
    const prev = scrolls.get(el.dataset.log);
    el.scrollTop = prev == null ? el.scrollHeight : prev;
  }
}

/** Append a log line in place, so a running job's log doesn't flicker. */
function appendEvent(ev) {
  const list = events.get(ev.job_id) ?? [];
  list.push(ev);
  events.set(ev.job_id, list);

  const job = jobs.get(ev.job_id);
  if (!job || job.project_slug !== route.slug) return;

  const el = document.querySelector(`[data-log="${ev.job_id}"]`);
  if (!el) { renderView(); return; }

  // A closing summary changes the card's shape, so rebuild for that one.
  if (ev.kind === 'result') { renderView(); return; }

  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  el.insertAdjacentHTML('beforeend', logLine(ev));
  if (atBottom) el.scrollTop = el.scrollHeight;

  if (ev.kind === 'tool' || ev.kind === 'status') {
    const now = el.closest('.msg')?.querySelector('.msg-now');
    if (now) now.textContent = ev.text;
  }
}

setInterval(() => {
  for (const el of document.querySelectorAll('[data-elapsed]')) {
    el.textContent = elapsed(el.dataset.elapsed);
  }
}, 1000);

// ─────────────────────────────────────────────── views

function renderView() {
  const project = route.view === 'project';
  const pending = route.view === 'pending';

  $('chat-view').hidden = !project;
  $('new-view').hidden = project || pending;
  $('compose').hidden = pending;
  $('visibility-wrap').hidden = project;

  $('view-title').textContent = project ? route.slug
    : pending ? 'starting…' : 'New project';

  $('prompt').placeholder = project
    ? `message ${route.slug}…`
    : 'create a simple mario game';

  if (project) {
    renderThread();

    // Carry this project's last settings forward so follow-ups match.
    const last = [...jobs.values()]
      .filter((j) => j.project_slug === route.slug)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    if (last) {
      $('effort').value = last.effort;
      $('usage-cap').value = String(last.usage_cap_pct ?? 90);
    }
  }

  // A brand-new project has no slug until the host names it; once it does,
  // slide over to the real chat.
  if (pending) {
    const job = jobs.get(route.jobId);
    if (job?.project_slug) go(`#/p/${encodeURIComponent(job.project_slug)}`);
  }

  renderDrawer();
  renderUsage();
}

// ─────────────────────────────────────────────── data

async function loadAll() {
  const [jobRes, projRes, useRes] = await Promise.all([
    sb.from('jobs').select('*').order('created_at', { ascending: false }).limit(200),
    sb.from('projects').select('name,full_name,is_local,private,pushed_at')
      .order('pushed_at', { ascending: false, nullsFirst: false }),
    sb.from('usage_windows').select('*'),
  ]);

  if (jobRes.error) console.error(jobRes.error);
  jobs.clear();
  for (const j of jobRes.data ?? []) jobs.set(j.id, j);

  projects = projRes.data ?? [];
  usage = useRes.data ?? [];

  // Events for everything we might draw: open jobs, plus this whole thread.
  const ids = (jobRes.data ?? [])
    .filter((j) => isActive(j) || j.project_slug === route.slug)
    .map((j) => j.id);

  events.clear();
  if (ids.length) {
    const { data } = await sb.from('job_events').select('*').in('job_id', ids).order('id');
    for (const e of data ?? []) {
      const list = events.get(e.job_id) ?? [];
      list.push(e);
      events.set(e.job_id, list);
    }
  }
  renderView();
}

function subscribe() {
  channels.push(
    sb.channel('jobs-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, ({ new: row }) => {
        if (row?.id) { jobs.set(row.id, row); renderView(); }
      })
      .subscribe(),

    sb.channel('events-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'job_events' },
          ({ new: row }) => row && appendEvent(row))
      .subscribe(),

    sb.channel('usage-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'usage_windows' }, async () => {
        const { data } = await sb.from('usage_windows').select('*');
        usage = data ?? [];
        renderUsage();
      })
      .subscribe(),
  );
}

async function pollHost() {
  const { data } = await sb.from('hosts').select('*')
    .order('last_seen', { ascending: false }).limit(1);
  const host = data?.[0];
  const badge = $('host-badge');
  const fresh = host && Date.now() - new Date(host.last_seen) < 30_000;

  badge.classList.toggle('online', Boolean(fresh));
  badge.classList.toggle('offline', !fresh);
  $('host-name').textContent = host ? (fresh ? host.name : `${host.name} · off`) : 'no desktop';
  badge.title = fresh
    ? 'Desktop is online — jobs run now'
    : 'Desktop is offline — jobs will queue until it boots';
}

// ─────────────────────────────────────────────── compose

const textarea = $('prompt');

function autoGrow() {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
}
textarea.addEventListener('input', autoGrow);

$('compose').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = textarea.value.trim();
  if (!prompt) return;

  const btn = $('send');
  const note = $('compose-note');
  btn.disabled = true;

  const project = route.view === 'project';
  const { data: { user } } = await sb.auth.getUser();

  const { data, error } = await sb.from('jobs').insert({
    owner: user.id,
    prompt,
    mode: project ? 'existing' : 'new',
    project_slug: project ? route.slug : null,
    repo_visibility: project ? 'none' : $('visibility').value,
    effort: $('effort').value,
    usage_cap_pct: Number($('usage-cap').value),
  }).select('id').single();

  if (error) {
    note.textContent = error.message;
    note.className = 'error';
    note.hidden = false;
  } else {
    textarea.value = '';
    autoGrow();
    note.hidden = true;
    // Follow the new project until the host names it.
    if (!project) go(`#/j/${data.id}`);
  }
  btn.disabled = false;
});

document.addEventListener('click', async (e) => {
  const id = e.target.dataset?.cancel;
  if (!id) return;
  e.target.disabled = true;
  const { error } = await sb.from('jobs').update({ cancel_requested: true }).eq('id', id);
  if (error) console.error(error);
});

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('auth-error');
  err.hidden = true;
  const { error } = await sb.auth.signInWithPassword({
    email: $('email').value.trim(),
    password: $('password').value,
  });
  if (error) { err.textContent = error.message; err.hidden = false; }
});

$('sign-out').addEventListener('click', () => sb.auth.signOut());

// ─────────────────────────────────────────────── boot

let hostTimer = null;

/**
 * If storage is blocked, Supabase writes the session and it silently vanishes,
 * so every launch looks like a fresh sign-in with no error anywhere. Test it
 * directly and say so, rather than letting it look like a broken login.
 */
function storageWorks() {
  try {
    localStorage.setItem('__cr_probe__', '1');
    const ok = localStorage.getItem('__cr_probe__') === '1';
    localStorage.removeItem('__cr_probe__');
    return ok;
  } catch {
    return false;
  }
}

async function applySession(session) {
  const signedIn = Boolean(session);
  $('booting').hidden = true;
  $('app').hidden = !signedIn;
  $('auth').hidden = signedIn;

  for (const c of channels) sb.removeChannel(c);
  channels = [];
  clearInterval(hostTimer);

  if (!signedIn) {
    closeDrawer();
    $('storage-warning').hidden = storageWorks();
    return;
  }

  route = readHash();
  await loadAll();
  subscribe();
  pollHost();
  hostTimer = setInterval(pollHost, 10_000);
}

(async () => {
  const { data: { session } } = await sb.auth.getSession();
  await applySession(session);
  sb.auth.onAuthStateChange((_evt, s) => applySession(s));
})();

// Realtime drops when iOS sleeps the tab; resync on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('app').hidden) { loadAll(); pollHost(); }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
