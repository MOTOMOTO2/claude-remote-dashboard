// Rendering. Every function here reads `state` and writes DOM — no queries,
// no fetches. Called whenever the store says something changed.

import { $, esc, ago, elapsed, clock, when, stamp, plural, clip, firstLine } from './util.js';
import { md } from './md.js';
import { icon, setBadge } from './ui.js';
import { route, projectHref } from './router.js';
import {
  state, isActive, jobList, newest, oldest, threadOf, latestOf,
  projectOf, projectGone, eventsOf, lastActivity, resultOf,
} from './store.js';

// ── bits shared by several views ──────────────────────────────────────

const STATE_WORD = {
  queued: 'queued', running: 'running', paused: 'paused',
  done: 'done', error: 'failed', cancelled: 'cancelled',
};

/** State is always a dot plus a word, so colour is never the only channel. */
const stateTag = (status, live = false) => `
  <span class="state" data-status="${esc(status)}">
    <i class="dot${live ? ' live' : ''}"></i>${esc(STATE_WORD[status] ?? status)}
  </span>`;

const githubUrl = (p) => (p?.full_name ? `https://github.com/${p.full_name}` : null);

/** What a job is doing this second, or what it was asked to do. */
function subtitle(job) {
  const act = job.status === 'running' ? lastActivity(job.id) : null;
  return clip(act ? act.text : job.prompt, 110);
}

function timing(job) {
  if (job.status === 'paused') {
    return job.resume_at ? `resumes ${clock(job.resume_at)}` : 'waiting';
  }
  if (job.status === 'queued') return 'waiting for desktop';
  if (job.status === 'running') {
    const from = job.claimed_at ?? job.created_at;
    return `<span data-elapsed="${esc(from)}">${elapsed(from)}</span>`;
  }
  return `<span data-ago="${esc(job.created_at)}">${ago(job.created_at)}</span>`;
}

const jobRow = (job) => `
  <a class="row${job.status === 'running' ? ' live' : ''}" data-status="${esc(job.status)}"
     href="${projectHref(job.project_slug)}">
    <span class="row-top">
      <span class="row-name">${esc(job.project_slug ?? 'naming…')}</span>
      ${stateTag(job.status, job.status === 'running')}
      <span class="row-when" title="${esc(stamp(job.created_at))}">${timing(job)}</span>
    </span>
    <span class="row-sub">${esc(subtitle(job))}</span>
  </a>`;

// ── topbar ────────────────────────────────────────────────────────────

export function renderTopbar() {
  const titles = {
    home: 'claude‑remote',
    project: route.slug ?? '',
    pending: 'Starting…',
    new: 'New project',
  };
  $('view-title').textContent = titles[route.view] ?? '';

  let sub = '';
  if (route.view === 'home') {
    const count = state.projects.length
      || new Set(jobList().map((j) => j.project_slug).filter(Boolean)).size;
    sub = count ? plural(count, 'project') : '';
  } else if (route.view === 'project') {
    const p = projectOf(route.slug);
    const n = threadOf(route.slug).length;
    sub = [
      p?.full_name ?? (p?.is_local ? 'on your desktop' : ''),
      n ? plural(n, 'message') : 'no messages yet',
    ].filter(Boolean).join(' · ');
  } else if (route.view === 'pending') {
    sub = 'waiting for your desktop to name it';
  }
  $('view-sub').textContent = sub;

  const pill = $('host-badge');
  const { host, hostFresh } = state;
  pill.classList.toggle('online', hostFresh);
  pill.classList.toggle('offline', !hostFresh);
  $('host-name').textContent = host ? (hostFresh ? host.name : `${host.name} · off`) : 'no desktop';
}

export function hostExplainer() {
  if (!state.host) return 'No desktop has ever checked in. Start the runner on your PC.';
  if (state.hostFresh) return `${state.host.name} is online — jobs start right away.`;
  return `${state.host.name} last checked in ${ago(state.host.last_seen)} ago. `
    + 'Jobs will queue until it boots.';
}

// ── sidebar ───────────────────────────────────────────────────────────

let filter = '';
export const setFilter = (q) => { filter = q.trim().toLowerCase(); };

export function renderSidebar() {
  const match = (s) => !filter || String(s ?? '').toLowerCase().includes(filter);

  // One entry per project that has been worked on, newest activity first,
  // with anything still running floated to the top.
  const chats = [...new Set(jobList().map((j) => j.project_slug).filter(Boolean))]
    .map((slug) => ({ slug, job: latestOf(slug) }))
    .filter(({ slug, job }) => match(slug) || match(job?.prompt))
    .sort((a, b) => (Number(isActive(b.job)) - Number(isActive(a.job)))
      || newest(a.job, b.job));

  const touched = new Set(chats.map((c) => c.slug));
  const repos = state.projects
    .filter((p) => !jobList().some((j) => j.project_slug === p.name))
    .filter((p) => match(p.name));

  const item = (slug, sub, trail) => `
    <a class="list-item${route.slug === slug ? ' current' : ''}" href="${projectHref(slug)}">
      <span class="li-top">
        <span class="li-name">${esc(slug)}</span>
        ${trail ?? ''}
      </span>
      ${sub ? `<span class="li-sub">${esc(sub)}</span>` : ''}
    </a>`;

  const chatTrail = ({ slug, job }) => {
    if (isActive(job)) {
      return `<span class="tag" data-status="${esc(job.status)}">
                <i class="dot"></i>${esc(STATE_WORD[job.status])}
              </span>`;
    }
    if (projectGone(slug)) return '<span class="tag gone">gone</span>';
    if (job.status === 'error') return `<span class="tag" data-status="error">failed</span>`;
    return `<span class="li-when" data-ago="${esc(job.created_at)}">${ago(job.created_at)}</span>`;
  };

  const group = (label, count, body) => `
    <p class="list-label">${esc(label)}<span class="count">${count}</span></p>${body}`;

  const parts = [];
  if (chats.length) {
    parts.push(group('Chats', chats.length,
      chats.map((c) => item(c.slug, firstLine(c.job.prompt), chatTrail(c))).join('')));
  }
  if (repos.length) {
    parts.push(group('Your repos', repos.length, repos.map((p) => item(
      p.name,
      p.full_name && p.full_name !== p.name ? p.full_name : '',
      p.is_local ? '' : '<span class="li-when">clone</span>',
    )).join('')));
  }
  if (!parts.length) {
    parts.push(`<p class="list-label">${filter ? 'No matches' : 'No projects yet'}</p>`);
  }

  $('project-list').innerHTML = parts.join('');
}

// ── usage meters ──────────────────────────────────────────────────────

const WINDOW_LABEL = {
  five_hour: 'Session · 5 hours',
  seven_day: 'Week · all models',
  seven_day_opus: 'Week · Opus',
  seven_day_sonnet: 'Week · Sonnet',
  seven_day_overage_included: 'Week · incl. overage',
  overage: 'Overage',
};
const WINDOW_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

/**
 * A ratio against a limit is a meter, not a chart. The fill carries severity
 * and the track is a lighter step of the same ramp, so the state reads across
 * the whole bar — and the percentage is always written out beside it.
 */
function usageHtml() {
  const rows = state.usage
    .filter((r) => r.pct != null)
    .sort((a, b) => {
      const ai = WINDOW_ORDER.indexOf(a.window_type);
      const bi = WINDOW_ORDER.indexOf(b.window_type);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });

  return rows.map((r) => {
    const pct = Math.max(0, Number(r.pct));
    const tone = pct >= 85 ? 'full' : pct >= 60 ? 'warn' : '';
    const resets = r.resets_at && new Date(r.resets_at) > new Date()
      ? `resets ${clock(r.resets_at)}` : '';
    return `
      <div class="meter ${tone}">
        <div class="meter-head">
          <span class="meter-name">${esc(WINDOW_LABEL[r.window_type] ?? r.window_type)}</span>
          <span class="meter-pct">${pct.toFixed(0)}%</span>
          <span class="meter-reset">${esc(resets)}</span>
        </div>
        <div class="meter-track">
          <i class="meter-fill" style="width:${Math.min(100, pct)}%"></i>
        </div>
      </div>`;
  }).join('');
}

export function renderUsage() {
  const inner = usageHtml();
  for (const id of ['usage-home', 'usage-new', 'usage-side']) {
    const el = $(id);
    el.innerHTML = inner;
    el.hidden = !inner;
  }
  // Home already leads with these; no need to print them twice.
  $('usage-side').hidden = !inner || route.view === 'home';
  $('usage-empty').hidden = Boolean(inner);
}

// ── home ──────────────────────────────────────────────────────────────

export function renderHome() {
  const all = jobList();
  const active = all.filter(isActive).sort(oldest);
  const running = active.filter((j) => j.status === 'running');
  const paused = active.filter((j) => j.status === 'paused');
  const queued = active.filter((j) => j.status === 'queued');
  const finished = all.filter((j) => j.status === 'done');
  const failed = all.filter((j) => j.status === 'error');

  const bare = !all.length && !state.projects.length && !state.loading;
  $('home-empty').hidden = !bare;
  for (const id of ['active-block', 'usage-block', 'glance-block', 'recent-block']) {
    $(id).hidden = bare;
  }

  // One hero figure per view: what is happening right now.
  $('hero-value').textContent = String(running.length);
  $('hero-label').textContent = running.length === 1 ? 'agent running' : 'agents running';
  $('hero-eyebrow').textContent = state.loading ? 'Loading…' : 'Right now';

  const chip = (status, text) => `
    <span class="stat-chip" data-status="${esc(status)}"><i class="dot"></i>${text}</span>`;
  const chips = [];
  if (paused.length) chips.push(chip('paused', `<b>${paused.length}</b> paused for usage`));
  if (queued.length) chips.push(chip('queued', `<b>${queued.length}</b> waiting on desktop`));
  if (!active.length && !bare) {
    chips.push(`<span class="stat-chip">Nothing in progress</span>`);
  }
  if (!state.hostFresh && !bare) {
    chips.push(`<span class="stat-chip" data-status="paused"><i class="dot"></i>desktop offline</span>`);
  }
  $('hero-chips').innerHTML = chips.join('');

  $('active-block').hidden = bare || !active.length;
  $('active-count').textContent = active.length ? String(active.length) : '';
  $('active-list').innerHTML = state.loading && !active.length
    ? '<div class="skel skel-row"></div>'
    : active.map(jobRow).join('');

  $('kpi-projects').textContent = String(state.projects.length || new Set(
    all.map((j) => j.project_slug).filter(Boolean)).size);
  $('kpi-done').textContent = String(finished.length);
  $('kpi-failed').textContent = String(failed.length);
  $('kpi-failed').closest('.tile').classList.toggle('flag', failed.length > 0);

  const recent = all.filter((j) => !isActive(j)).sort(newest).slice(0, 5);
  $('recent-block').hidden = bare || !recent.length;
  $('recent-list').innerHTML = recent.map(jobRow).join('');

  setBadge(running.length);
}

// ── project chat ──────────────────────────────────────────────────────

const logLine = (e) => `<span class="l-${esc(e.kind)}">${esc(e.text)}</span>\n`;

/** The agent's side of one turn: status, summary or live activity, log. */
function replyHtml(job) {
  const log = eventsOf(job.id);
  const result = resultOf(job.id);
  const act = lastActivity(job.id);
  const live = isActive(job);

  const trailer = job.status === 'running'
    ? `<span class="msg-clock" data-elapsed="${esc(job.claimed_at ?? job.created_at)}">${
        elapsed(job.claimed_at ?? job.created_at)}</span>`
    : job.status === 'paused' && job.resume_at
      ? `<span class="msg-clock">resumes ${esc(clock(job.resume_at))}</span>`
      : job.num_turns
        ? `<span class="msg-clock">${job.num_turns} turns</span>`
        : `<span class="msg-clock">${esc(when(job.created_at))}</span>`;

  const paused = job.status === 'paused' ? `
    <p class="note" data-status="paused">Usage limit reached. This picks up
      automatically where it left off${job.resume_at ? ` at ${esc(clock(job.resume_at))}` : ''}
      — nothing for you to do.</p>` : '';

  const body = result
    ? `<div class="msg-body md">${md(result.text)}</div>`
    : live && act
      ? `<p class="msg-now">${icon('sliders')}<span>${esc(clip(act.text, 140))}</span></p>`
      : '';

  const logBlock = !log.length ? '' : live
    ? `<div class="log" data-log="${esc(job.id)}">${log.map(logLine).join('')}</div>`
    : `<details class="fold"><summary>${plural(log.length, 'log line')}</summary>
         <div class="log">${log.map(logLine).join('')}</div></details>`;

  const actions = [
    job.repo_url
      ? `<a class="btn tiny ghost" href="${esc(job.repo_url)}" target="_blank" rel="noopener">
           ${icon('link')}repo</a>`
      : '',
    result ? `<button class="btn tiny ghost" data-copy-summary="${esc(job.id)}">
                ${icon('copy')}copy</button>` : '',
    log.length ? `<button class="btn tiny ghost" data-copy-log="${esc(job.id)}">
                    ${icon('copy')}log</button>` : '',
    live && !job.cancel_requested
      ? `<button class="btn tiny ghost" data-cancel="${esc(job.id)}">${icon('stop')}stop</button>`
      : '',
    live && job.cancel_requested ? '<span class="muted small">stopping…</span>' : '',
    !live ? `<button class="btn tiny ghost" data-retry="${esc(job.id)}">
               ${icon('retry')}run again</button>` : '',
  ].filter(Boolean).join('');

  return `
    <div class="msg agent${live ? ' live' : ''}" data-status="${esc(job.status)}">
      <div class="msg-head">${stateTag(job.status, job.status === 'running')}${trailer}</div>
      ${paused}
      ${body}
      ${logBlock}
      ${job.error ? `<p class="note bad" data-status="error">${esc(job.error)}</p>` : ''}
      <div class="msg-actions">${actions}</div>
    </div>`;
}

export function renderChat() {
  const slug = route.slug;
  const mine = threadOf(slug);
  const p = projectOf(slug);
  const gone = projectGone(slug);
  const repo = githubUrl(p) ?? mine.find((j) => j.repo_url)?.repo_url ?? null;

  $('chat-head').hidden = false;
  $('chat-head').innerHTML = `
    <h2>${esc(slug)}</h2>
    <span class="meta">
      ${p?.private ? '<span class="tag">private</span>' : ''}
      ${p?.is_local && !p?.full_name ? '<span class="tag">local</span>' : ''}
      ${gone ? '<span class="tag gone">gone</span>' : ''}
      ${repo ? `<a class="btn tiny ghost" href="${esc(repo)}" target="_blank" rel="noopener">
                  ${icon('link')}repo</a>` : ''}
      ${mine.length ? `<button class="btn tiny ghost" data-delete-chat="${esc(slug)}">
                         ${icon('trash')}clear chat</button>` : ''}
    </span>`;

  // Keep the reading position of any log the user has scrolled into.
  const scrolls = new Map();
  for (const el of document.querySelectorAll('[data-log]')) {
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    scrolls.set(el.dataset.log, atBottom ? null : el.scrollTop);
  }

  const notice = gone ? `
    <p class="note bad" data-status="error"><strong>${esc(slug)}</strong> isn’t on
      GitHub or your desktop any more. The history below is still here, but there’s
      nothing left to build on.</p>` : '';

  const turns = mine.map((job) => `
    <div class="turn" id="job-${esc(job.id)}">
      <div class="msg you" title="${esc(stamp(job.created_at))}">${esc(job.prompt)}</div>
      ${replyHtml(job)}
    </div>`).join('');

  $('thread').innerHTML = notice + (mine.length ? turns : `
    <div class="empty">
      ${icon('folder', 'empty-art')}
      <h3>No messages yet</h3>
      <p>Send a message to start working on <strong>${esc(slug)}</strong>. It gets
         cloned to your desktop the first time you use it.</p>
    </div>`);

  for (const el of document.querySelectorAll('[data-log]')) {
    const prev = scrolls.get(el.dataset.log);
    el.scrollTop = prev == null ? el.scrollHeight : prev;
  }
}

/** Append one log line in place, so a running job's log doesn't flicker. */
export function appendLive(ev, onRerender) {
  const job = state.jobs.get(ev.job_id);
  if (!job || route.view !== 'project' || job.project_slug !== route.slug) return;

  const el = document.querySelector(`[data-log="${ev.job_id}"]`);
  // A closing summary changes the card's shape, so rebuild for that one.
  if (!el || ev.kind === 'result') { onRerender(); return; }

  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  el.insertAdjacentHTML('beforeend', logLine(ev));
  if (atBottom) el.scrollTop = el.scrollHeight;

  if (ev.kind === 'tool' || ev.kind === 'status') {
    const now = el.closest('.msg')?.querySelector('.msg-now span');
    if (now) now.textContent = clip(ev.text, 140);
  }
}

// ── new project ───────────────────────────────────────────────────────

const EXAMPLES = [
  'Build a snake game I can play in the browser, with a high-score list.',
  'A CLI that watches a folder and converts any new image to WebP.',
  'A small REST API for tracking books I have read, with SQLite behind it.',
  'A static site that shows the weather for my city, deployed to GitHub Pages.',
];

export function renderExamples() {
  $('example-row').innerHTML = EXAMPLES.map((text) => `
    <button type="button" class="example" data-example="${esc(text)}">
      ${icon('spark')}<span>${esc(text)}</span>
    </button>`).join('');
}

// ── pending (a job with no project name yet) ──────────────────────────

export function renderPending(job) {
  $('chat-head').hidden = true;
  $('thread').innerHTML = job ? `
    <div class="turn">
      <div class="msg you">${esc(job.prompt)}</div>
      ${replyHtml(job)}
    </div>
    <p class="empty-note center">Your desktop names the project as soon as it
      picks this up, then this turns into its chat.</p>`
    : `
    <div class="empty">
      ${icon('spark', 'empty-art')}
      <h3>Starting…</h3>
      <p>Waiting for your desktop to pick this up.</p>
    </div>`;
}
