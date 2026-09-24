import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const cfg = window.CONFIG ?? {};
if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
  document.body.innerHTML =
    '<p style="padding:2rem;font-family:system-ui">Copy <code>config.example.js</code> to ' +
    '<code>config.js</code> and fill in your Supabase URL and anon key.</p>';
  throw new Error('missing config');
}

// Explicit about session persistence: the token is kept in localStorage and
// refreshed in the background, so you sign in once per device and stay in.
// (On iOS, a home-screen install has its own storage — signing in inside
// Safari does not carry over, so the first sign-in must happen in the app.)
const sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: 'claude-remote-auth',
  },
});
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** jobId -> job row */   const jobs = new Map();
/** jobId -> event rows */ const events = new Map();
let channels = [];

// ─────────────────────────────────────────────── formatting

function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function elapsed(from, to) {
  const s = Math.max(0, Math.floor(((to ? new Date(to) : Date.now()) - new Date(from)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

const money = (n) => (n == null ? '' : `$${Number(n).toFixed(2)}`);

// ─────────────────────────────────────────────── rendering

const ACTIVE = new Set(['queued', 'running']);

function jobCard(job, { live }) {
  const log = events.get(job.id) ?? [];
  const last = [...log].reverse().find((e) => e.kind === 'tool' || e.kind === 'status');

  const meta = live
    ? elapsed(job.claimed_at ?? job.created_at)
    : [job.num_turns ? `${job.num_turns} turns` : '', ago(job.created_at)].filter(Boolean).join(' · ');

  // Kept as a tooltip: on a subscription this is an estimate of what the work
  // would have cost on the API, not something you were charged.
  const costHint = job.cost_usd ? ` title="≈${money(job.cost_usd)} of API-equivalent usage"` : '';

  return `
    <article class="job" data-job="${job.id}">
      <div class="job-head">
        <span class="job-title">${esc(job.project_slug ?? 'naming…')}</span>
        <span class="job-status ${job.status}"><i class="dot"></i>${job.status}</span>
        <span class="job-meta"${costHint} data-elapsed="${live ? job.claimed_at ?? job.created_at : ''}">${esc(meta)}</span>
      </div>
      <p class="job-prompt">${esc(job.prompt)}</p>
      ${live && last ? `<p class="job-now">${esc(last.text)}</p>` : ''}
      ${live ? `<div class="log" data-log="${job.id}">${log.map(logLine).join('')}</div>` : ''}
      ${job.error ? `<p class="error">${esc(job.error)}</p>` : ''}
      <div class="job-actions">
        ${job.repo_url ? `<a href="${esc(job.repo_url)}" target="_blank" rel="noopener">repo &#8599;</a>` : ''}
        ${ACTIVE.has(job.status) && !job.cancel_requested
          ? `<button class="ghost" data-cancel="${job.id}">cancel</button>` : ''}
        ${job.cancel_requested && ACTIVE.has(job.status)
          ? '<span class="muted small">stopping…</span>' : ''}
      </div>
    </article>`;
}

const logLine = (e) => `<span class="l-${e.kind}">${esc(e.text)}</span>\n`;

function render() {
  const all = [...jobs.values()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const live = all.filter((j) => ACTIVE.has(j.status));
  const past = all.filter((j) => !ACTIVE.has(j.status));

  // Preserve scroll position of any log the user is reading.
  const scrolls = new Map();
  for (const el of document.querySelectorAll('[data-log]')) {
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    scrolls.set(el.dataset.log, atBottom ? null : el.scrollTop);
  }

  $('active-section').hidden = live.length === 0;
  $('active').innerHTML = live.map((j) => jobCard(j, { live: true })).join('');
  $('history').innerHTML = past.map((j) => jobCard(j, { live: false })).join('');
  $('history-empty').hidden = past.length > 0;

  for (const el of document.querySelectorAll('[data-log]')) {
    const prev = scrolls.get(el.dataset.log);
    el.scrollTop = prev == null ? el.scrollHeight : prev;
  }
}

/** Append one line without rebuilding the card, so the log doesn't flicker. */
function appendEvent(ev) {
  const list = events.get(ev.job_id) ?? [];
  list.push(ev);
  events.set(ev.job_id, list);

  const el = document.querySelector(`[data-log="${ev.job_id}"]`);
  if (!el) { render(); return; }

  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  el.insertAdjacentHTML('beforeend', logLine(ev));
  if (atBottom) el.scrollTop = el.scrollHeight;

  if (ev.kind === 'tool' || ev.kind === 'status') {
    const now = document.querySelector(`[data-job="${ev.job_id}"] .job-now`);
    if (now) now.textContent = ev.text;
  }
}

// Tick the elapsed clocks without a full re-render.
setInterval(() => {
  for (const el of document.querySelectorAll('[data-elapsed]')) {
    if (el.dataset.elapsed) el.textContent = elapsed(el.dataset.elapsed);
  }
}, 1000);

// ─────────────────────────────────────────────── data

async function loadJobs() {
  const { data, error } = await sb.from('jobs')
    .select('*').order('created_at', { ascending: false }).limit(50);
  if (error) return console.error(error);

  jobs.clear();
  for (const j of data) jobs.set(j.id, j);

  const liveIds = data.filter((j) => ACTIVE.has(j.status)).map((j) => j.id);
  if (liveIds.length) {
    const { data: evs } = await sb.from('job_events')
      .select('*').in('job_id', liveIds).order('id');
    events.clear();
    for (const e of evs ?? []) {
      const list = events.get(e.job_id) ?? [];
      list.push(e);
      events.set(e.job_id, list);
    }
  }
  render();
}

function subscribe() {
  channels.push(
    sb.channel('jobs-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, ({ new: row }) => {
        if (row?.id) { jobs.set(row.id, row); render(); }
      })
      .subscribe(),

    sb.channel('events-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'job_events' },
          ({ new: row }) => row && appendEvent(row))
      .subscribe(),
  );
}

async function pollHost() {
  const { data } = await sb.from('hosts').select('*').order('last_seen', { ascending: false }).limit(1);
  const host = data?.[0];
  const badge = $('host-badge');
  const fresh = host && Date.now() - new Date(host.last_seen) < 30_000;

  badge.classList.toggle('online', Boolean(fresh));
  badge.classList.toggle('offline', !fresh);
  $('host-name').textContent = host
    ? (fresh ? host.name : `${host.name} · off`)
    : 'no desktop';
  badge.title = fresh
    ? 'Desktop is online — jobs run now'
    : 'Desktop is offline — jobs will queue until it boots';
}

const WINDOW_LABEL = {
  five_hour: 'session · 5 hours',
  seven_day: 'week · 7 days',
  seven_day_opus: 'week · Opus',
  seven_day_sonnet: 'week · Sonnet',
  seven_day_overage_included: 'week · incl. overage',
  overage: 'overage',
};

// Session and week first; anything else the SDK reports follows.
const WINDOW_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

function resetLabel(iso) {
  if (!iso) return '';
  const at = new Date(iso);
  if (at <= new Date()) return '';
  const hrs = (at - Date.now()) / 36e5;
  const when = hrs < 24
    ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : at.toLocaleDateString([], { weekday: 'short', hour: 'numeric' });
  return `resets ${when}`;
}

/** Only known after a job has run — readings come from the agent's own stream. */
async function pollUsage() {
  const box = $('usage');
  const { data, error } = await sb.from('usage_windows').select('*');
  if (error || !data?.length) { box.hidden = true; return; }

  const rows = data
    .filter((r) => r.pct != null)
    .sort((a, b) => {
      const ai = WINDOW_ORDER.indexOf(a.window_type), bi = WINDOW_ORDER.indexOf(b.window_type);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });

  if (!rows.length) { box.hidden = true; return; }
  box.hidden = false;

  box.innerHTML = rows.map((r) => {
    const pct = Number(r.pct);
    const tone = pct >= 85 ? 'full' : pct >= 60 ? 'warn' : '';
    return `
      <div class="usage-row ${tone}">
        <div class="usage-head">
          <span>${esc(WINDOW_LABEL[r.window_type] ?? r.window_type)}</span>
          <span class="usage-pct">${pct.toFixed(0)}%</span>
        </div>
        <div class="usage-bar"><i style="width:${Math.min(100, pct)}%"></i></div>
        <p class="muted small">${esc(resetLabel(r.resets_at))}&nbsp;</p>
      </div>`;
  }).join('');
}

/**
 * Every GitHub repo on the account, plus anything already in the workspace.
 * Repos that aren't local yet are offered too — the host clones them on
 * first use — but the local ones come first because they start instantly.
 */
async function loadProjects() {
  const sel = $('project-slug');
  const { data, error } = await sb.from('projects')
    .select('name,full_name,is_local,private,pushed_at')
    .order('pushed_at', { ascending: false, nullsFirst: false });

  if (error || !data?.length) {
    sel.innerHTML = '<option value="" disabled selected>none found — is the desktop online?</option>';
    return;
  }

  const local = data.filter((p) => p.is_local);
  const remote = data.filter((p) => !p.is_local);
  const opt = (p) => `<option value="${esc(p.name)}">${esc(p.name)}${p.private ? '' : ' ·  public'}</option>`;

  sel.innerHTML =
    (local.length ? `<optgroup label="on your desktop">${local.map(opt).join('')}</optgroup>` : '') +
    (remote.length ? `<optgroup label="GitHub — cloned on first use">${remote.map(opt).join('')}</optgroup>` : '');
}

// ─────────────────────────────────────────────── actions

$('mode').addEventListener('change', (e) => {
  const existing = e.target.value === 'existing';
  $('slug-field').hidden = !existing;
  $('visibility-field').hidden = existing;
});

$('new-job').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('send');
  btn.disabled = true;

  const mode = $('mode').value;
  const note = $('compose-note');

  // Fail here rather than letting the host reject it a minute later.
  if (mode === 'existing' && !$('project-slug').value) {
    note.textContent = 'No existing projects yet — build one with "new" first.';
    note.className = 'error';
    note.hidden = false;
    btn.disabled = false;
    return;
  }

  const { data: { user } } = await sb.auth.getUser();

  const { error } = await sb.from('jobs').insert({
    owner: user.id,
    prompt: $('prompt').value.trim(),
    mode,
    project_slug: mode === 'existing' ? $('project-slug').value : null,
    repo_visibility: mode === 'existing' ? 'none' : $('visibility').value,
    effort: $('effort').value,
    usage_cap_pct: Number($('usage-cap').value),
  });

  if (error) {
    note.textContent = error.message;
    note.className = 'error';
  } else {
    $('prompt').value = '';
    note.textContent = $('host-badge').classList.contains('online')
      ? 'Queued — your desktop is picking it up.'
      : 'Queued — it will run when your desktop comes online.';
    note.className = 'muted small';
  }
  note.hidden = false;
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
    const k = '__cr_probe__';
    localStorage.setItem(k, '1');
    const ok = localStorage.getItem(k) === '1';
    localStorage.removeItem(k);
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
    $('storage-warning').hidden = storageWorks();
    return;
  }

  await Promise.all([loadJobs(), loadProjects(), pollUsage()]);
  subscribe();
  pollHost();
  hostTimer = setInterval(() => { pollHost(); pollUsage(); }, 10_000);
}

// Restore explicitly before deciding what to show, so a stored session never
// flashes the sign-in form on the way in.
(async () => {
  const { data: { session } } = await sb.auth.getSession();
  await applySession(session);
  sb.auth.onAuthStateChange((_evt, s) => applySession(s));
})();

// Realtime drops on mobile when the tab sleeps; resync on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('app').hidden) {
    loadJobs(); pollHost(); pollUsage(); loadProjects();
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
