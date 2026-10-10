// Rendering. Every function here reads `state` and writes DOM — no queries,
// no fetches. Called whenever the store says something changed.

import {
  $, esc, ago, elapsed, dayClock, until, when, stamp, plural, clip,
  firstLine, dayKey, weekday,
} from './util.js';
import { md } from './md.js';
import { icon, setBadge, isNarrow } from './ui.js';
import { route, projectHref } from './router.js';
import { suggest } from './suggest.js';
import { ideas, profile, themeLabel } from './ideas.js';
import { catalog, languages, narrow, order, tally, liveHost, webUrl } from './catalog.js';
import {
  state, isActive, jobList, newest, oldest, threadOf, latestOf,
  projectOf, projectGone, eventsOf, lastActivity, resultOf, fleetNow,
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
    // A resume can land tomorrow, so it has to name the day, not just a clock.
    return job.resume_at ? `resumes ${dayClock(job.resume_at)}` : 'waiting';
  }
  if (job.status === 'queued') return 'waiting for desktop';
  if (job.status === 'running') {
    const from = job.claimed_at ?? job.created_at;
    return `<span data-elapsed="${esc(from)}">${elapsed(from)}</span>`;
  }
  return `<span data-ago="${esc(job.created_at)}">${ago(job.created_at)}</span>`;
}

const jobHref = (job) =>
  (job.project_slug ? projectHref(job.project_slug) : `#/j/${encodeURIComponent(job.id)}`);

/** The settings a run was queued with — small, but it answers "why so slow?". */
function jobFacts(job) {
  const facts = [
    job.effort ? `${job.effort} effort` : '',
    job.usage_cap_pct != null && job.usage_cap_pct < 100 ? `pauses at ${job.usage_cap_pct}%` : '',
    job.num_turns ? plural(job.num_turns, 'turn') : '',
    job.repo_visibility && job.repo_visibility !== 'none' && !job.project_slug
      ? `${job.repo_visibility} repo` : '',
  ].filter(Boolean);
  return facts.map((f) => `<span class="fact">${esc(f)}</span>`).join('');
}

const jobRow = (job) => `
  <a class="row${job.status === 'running' ? ' live' : ''}" data-status="${esc(job.status)}"
     href="${jobHref(job)}">
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
    agents: 'Agents',
    ideas: 'Ideas',
    projects: 'Projects',
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
  } else if (route.view === 'agents') {
    const f = fleetNow();
    sub = [
      `${f.running.length} of ${f.max} running`,
      f.waiting.length ? `${f.waiting.length} waiting` : '',
    ].filter(Boolean).join(' · ');
  } else if (route.view === 'ideas') {
    sub = 'read off your own work';
  } else if (route.view === 'projects') {
    const t = tally(projectEntries());
    sub = t.total ? `${plural(t.total, 'project')} · ${t.live} live` : '';
  }
  $('view-sub').textContent = sub;

  setBadge(jobList().filter((j) => j.status === 'running').length);

  const pill = $('host-badge');
  const { host, hostFresh } = state;
  pill.classList.toggle('online', hostFresh);
  pill.classList.toggle('offline', !hostFresh);
  $('host-name').textContent = host ? (hostFresh ? host.name : `${host.name} · off`) : 'no desktop';
}

export function hostExplainer() {
  const feed = state.realtime === 'live' ? '' : ' · live updates reconnecting';
  if (!state.host) return `No desktop has ever checked in. Start the runner on your PC.${feed}`;
  if (state.hostFresh) return `${state.host.name} is online — jobs start right away.${feed}`;
  return `${state.host.name} last checked in ${ago(state.host.last_seen)} ago. `
    + `Jobs will queue until it boots.${feed}`;
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

  const repos = state.projects
    .filter((p) => !jobList().some((j) => j.project_slug === p.name))
    .filter((p) => match(p.name));

  const item = (slug, sub, trail) => `
    <a class="list-item${route.slug === slug ? ' current' : ''}"
       ${route.slug === slug ? 'aria-current="page"' : ''}
       href="${projectHref(slug)}">
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

  // The three doors under "New project" say which of them you are behind.
  for (const [id, view] of [['agents-link', 'agents'], ['projects-link', 'projects'],
    ['ideas-link', 'ideas']]) {
    if (route.view === view) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  }
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
const WINDOW_SHORT = {
  five_hour: '5h', seven_day: 'week', seven_day_opus: 'week · Opus',
  seven_day_sonnet: 'week · Sonnet', seven_day_overage_included: 'week+',
  overage: 'overage',
};
const WINDOW_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

/** The severity of a ratio, as a class and the word that always rides with it. */
const level = (pct) => (pct >= 85
  ? { tone: 'full', word: 'nearly out' }
  : pct >= 60 ? { tone: 'warn', word: 'watch' } : { tone: '', word: 'healthy' });

const usageRows = () => state.usage
  .filter((r) => r.pct != null)
  .sort((a, b) => {
    const ai = WINDOW_ORDER.indexOf(a.window_type);
    const bi = WINDOW_ORDER.indexOf(b.window_type);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });

/** The window with the least headroom — the one that will actually stop you. */
const tightest = () => usageRows().reduce(
  (worst, r) => (worst && Number(worst.pct) >= Number(r.pct) ? worst : r), null);

const future = (iso) => Boolean(iso) && new Date(iso) > new Date();

/**
 * When a window resets, in words: the day comes first because "resets 3:00 PM"
 * on a weekly limit is the one thing you cannot act on. The countdown ticks.
 */
function resetHtml(r) {
  if (!future(r.resets_at)) return '<span class="meter-reset muted">reset time unknown</span>';
  return `<span class="meter-reset">
    ${icon('calendar')}resets <b>${esc(dayClock(r.resets_at))}</b>
    <span class="dim">· in <span data-until="${esc(r.resets_at)}">${esc(until(r.resets_at))}</span></span>
  </span>`;
}

/**
 * A ratio against a limit is a meter, not a chart. The fill carries severity
 * and the track is a lighter step of the same ramp, so the state reads across
 * the whole bar — and the percentage is always written out beside it.
 */
function meterHtml(r) {
  const pct = Math.max(0, Number(r.pct));
  const { tone, word } = level(pct);
  const left = Math.max(0, 100 - Math.round(pct));
  return `
      <div class="meter ${tone}">
        <div class="meter-head">
          <span class="meter-name">${esc(WINDOW_LABEL[r.window_type] ?? r.window_type)}</span>
          <span class="meter-state"><i class="dot"></i>${esc(word)}</span>
          <span class="meter-pct">${pct.toFixed(0)}%</span>
        </div>
        <div class="meter-track">
          <i class="meter-fill" style="width:${Math.min(100, pct)}%"></i>
        </div>
        <div class="meter-foot">
          <span class="meter-left">${left}% left</span>
          ${resetHtml(r)}
        </div>
      </div>`;
}

const usageHtml = () => usageRows().map(meterHtml).join('');

/**
 * Home's copy. Every window matters, but five meters is most of a phone
 * screen, so a narrow one leads with the window that will actually stop you
 * and folds the rest behind their own count. Nothing is dropped.
 */
function homeUsageHtml() {
  const rows = usageRows();
  if (!rows.length) return '';
  if (!isNarrow() || rows.length === 1) return rows.map(meterHtml).join('');
  const lead = tightest();
  const rest = rows.filter((r) => r !== lead);
  return meterHtml(lead) + `
    <details class="fold">
      <summary>${plural(rest.length, 'more window')}</summary>
      <div class="usage-rest">${rest.map(meterHtml).join('')}</div>
    </details>`;
}

/** One sentence a person can act on, used by the block note and the pill. */
export function usageSentence() {
  if (state.usageError) return `Couldn’t read your limits — ${state.usageError}`;
  const r = tightest();
  if (!r) return 'No usage readings yet — your desktop reports these when it starts up.';
  const pct = Math.round(Number(r.pct));
  const name = WINDOW_LABEL[r.window_type] ?? r.window_type;
  const reset = future(r.resets_at)
    ? ` It resets ${dayClock(r.resets_at)}, in ${until(r.resets_at)}.`
    : '';
  const read = state.usageAt ? ` Read ${ago(state.usageAt)} ago.` : '';
  return `${name} is your tightest window: ${100 - pct}% left.${reset}${read}`;
}

/**
 * Whether the readings are arriving, in words. A meter that is stuck is
 * indistinguishable from a quiet account unless the page says which it is:
 * when the last read landed, and when its numbers last actually moved.
 */
function freshnessHtml() {
  if (state.usageError) {
    return `<span class="usage-read bad">${icon('offline')}couldn’t read the limits —
      ${esc(clip(state.usageError, 80))}</span>`;
  }
  if (!state.usageAt) return '<span class="usage-read">no reading yet</span>';
  // No trailing "ago": `ago()` already answers with "now" when it is now.
  const moved = state.usageMovedAt
    ? ` · changed <span data-ago="${esc(state.usageMovedAt)}">${ago(state.usageMovedAt)}</span>`
    : ' · unchanged so far';
  return `<span class="usage-read">${icon('clock')}last read
    <span data-ago="${esc(state.usageAt)}">${ago(state.usageAt)}</span>${moved}</span>`;
}

export function renderUsage() {
  const inner = usageHtml();
  const home = homeUsageHtml();
  $('usage-home').innerHTML = home;
  $('usage-home').hidden = !home;
  for (const id of ['usage-new', 'usage-side']) {
    const el = $(id);
    el.innerHTML = inner;
    el.hidden = !inner;
  }
  // Home already leads with these; no need to print them twice.
  $('usage-side').hidden = !inner || route.view === 'home';
  $('usage-empty').hidden = Boolean(inner) || Boolean(state.usageError);
  $('usage-foot').innerHTML = freshnessHtml();

  const r = tightest();
  $('usage-note').textContent = r
    ? `${Math.max(0, 100 - Math.round(Number(r.pct)))}% left on ${
      WINDOW_SHORT[r.window_type] ?? r.window_type}`
    : '';

  const pill = $('usage-pill');
  pill.hidden = !r;
  if (r) {
    const pct = Math.round(Number(r.pct));
    const { tone, word } = level(pct);
    pill.classList.remove('warn', 'full');
    if (tone) pill.classList.add(tone);
    // The pill has room for a number; the accessible name carries the word
    // that goes with the colour, and the sentence behind both.
    pill.title = usageSentence();
    pill.setAttribute('aria-label', `Usage ${word} — ${usageSentence()}`);
    $('usage-pill-text').innerHTML = `${pct}%<span class="pill-sub"> ${
      esc(WINDOW_SHORT[r.window_type] ?? '')}</span>`;
  }
}

// ── activity (runs per day) ───────────────────────────────────────────

const DAYS = 14;

/**
 * Fourteen columns, one per day, counting the runs you started. One series, so
 * no legend: the heading names it and today's column is the only coloured one.
 * The busiest day is labelled directly; the rest live in the hover title.
 */
function activityHtml(jobs) {
  const now = new Date();
  const days = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push({ date: d, key: dayKey(d), n: 0 });
  }
  const index = new Map(days.map((d) => [d.key, d]));
  for (const j of jobs) {
    const day = index.get(dayKey(j.created_at));
    if (day) day.n++;
  }

  const max = Math.max(1, ...days.map((d) => d.n));
  const peak = days.reduce((best, d) => (d.n > best.n ? d : best), days[0]);
  const total = days.reduce((sum, d) => sum + d.n, 0);

  const label = (d) => `${weekday(d.date)} ${d.date.toLocaleDateString([], {
    month: 'short', day: 'numeric' })} · ${plural(d.n, 'run')}`;

  const cols = days.map((d, i) => {
    const today = i === DAYS - 1;
    const show = d.n > 0 && d === peak && d.n > 1;
    return `
      <div class="bar-col${today ? ' today' : ''}" title="${esc(label(d))}"
           role="img" aria-label="${esc(label(d))}">
        <span class="bar-val${show ? '' : ' hide'}">${d.n}</span>
        <span class="bar-wrap"><i class="bar" style="height:${
          d.n ? Math.max(6, Math.round((d.n / max) * 100)) : 0}%"></i></span>
      </div>`;
  }).join('');

  return {
    total,
    peak,
    html: `
      <div class="bars">${cols}</div>
      <div class="chart-foot">
        <span>${esc(days[0].date.toLocaleDateString([], { month: 'short', day: 'numeric' }))}</span>
        <span class="chart-base" aria-hidden="true"></span>
        <span>today</span>
      </div>`,
  };
}

// ── suggestions ───────────────────────────────────────────────────────

/**
 * Everything offered anywhere, by id, so a click can find its prompt again.
 * Two engines fill it — next steps and new builds — and ids are stable, so
 * each render overwrites its own entries rather than clearing the lot.
 */
const shown = new Map();
export const suggestionById = (id) => shown.get(id) ?? null;
const remember = (list) => { for (const it of list) shown.set(it.id, it); return list; };

/** Closing summaries by job id — they sharpen every keyword probe. */
function summaryMap() {
  const summaries = new Map();
  for (const j of jobList()) {
    const r = resultOf(j.id);
    if (r) summaries.set(j.id, r.text);
  }
  return summaries;
}

const engineInput = () => ({
  jobs: jobList(), projects: state.projects, summaries: summaryMap(),
});

function suggestionList() {
  return suggest({ ...engineInput(), limit: 6 });
}

const suggestionHtml = (s) => `
  <button type="button" class="suggest" data-suggest="${esc(s.id)}" data-kind="${esc(s.kind)}">
    <span class="suggest-icon">${icon(s.icon)}</span>
    <span class="suggest-text">
      <span class="suggest-title">${esc(s.title)}</span>
      <span class="suggest-why">
        ${s.slug ? `<span class="tag plain">${esc(s.slug)}</span>` : ''}
        <span class="why-text">${esc(s.why)}</span>
      </span>
    </span>
    <span class="suggest-go">${icon('arrow')}</span>
  </button>`;

/** The new-project view, where knowing there is room for another matters. */
export function renderNewIntro() {
  const f = fleetNow();
  const room = f.free
    ? `${plural(f.free, 'slot')} free of ${f.max} — it starts as soon as your desktop sees it.`
    : `All ${plural(f.max, 'slot')} are busy, so this one queues behind them.`;
  $('new-intro').textContent = `Describe what to build. Your desktop picks it up, `
    + `creates the repo, writes the code, and pushes it. ${room}`;
}

export function renderSuggestions() {
  const all = remember(suggestionList());

  const fromYours = all.filter((s) => s.kind !== 'starter').length;
  const note = fromYours
    ? `${fromYours} from your ${plural(new Set(all.filter((s) => s.slug).map((s) => s.slug)).size,
      'project')}`
    : 'ideas to get you started';

  const home = all.slice(0, 3);
  $('suggest-list').innerHTML = home.map(suggestionHtml).join('');
  $('suggest-block').hidden = !home.length;
  $('suggest-note').textContent = note;

  $('suggest-new').innerHTML = all.map(suggestionHtml).join('');
  $('suggest-new-note').textContent = note;
}

// ── ideas (the long list, read off everything you have made) ──────────

/** 'all' · 'next' · 'new' · 'theme:<key>'. Set by the chip row. */
let ideaFilter = 'all';
export const setIdeaFilter = (key) => { ideaFilter = key; };

/** Both engines at full length — this is the view that shows everything. */
const ideaSets = () => {
  const input = engineInput();
  return {
    next: remember(suggest({ ...input, limit: 24 }).filter((s) => s.kind !== 'starter')),
    builds: remember(ideas({ ...input, limit: 30 })),
    read: profile(input),
  };
};

/**
 * A build is a card, not a row: the title alone doesn't say enough to pick
 * one, so it carries a line about what it is and the evidence that put it
 * here. Clicking it loads the brief, which is the actual artefact.
 */
const ideaCard = (it) => `
  <button type="button" class="idea" data-suggest="${esc(it.id)}"
          data-kind="${esc(it.kind)}" data-idea-theme="${esc(it.theme ?? '')}">
    <span class="idea-top">
      <span class="idea-icon">${icon(it.icon)}</span>
      <span class="idea-tag-row">${it.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</span>
      <span class="idea-go">${icon('arrow')}</span>
    </span>
    <span class="idea-title">${esc(it.title)}</span>
    <span class="idea-blurb">${esc(it.blurb)}</span>
    <span class="idea-why">${icon('pulse')}<span>${esc(it.why)}</span></span>
  </button>`;

/** One chip per way of narrowing the list, each carrying its own count. */
function chipRow(next, builds) {
  const themes = [];
  for (const b of builds) {
    if (!b.theme) continue;
    const found = themes.find((t) => t.key === b.theme);
    if (found) found.n++;
    else themes.push({ key: b.theme, label: b.tags[0] ?? b.theme, n: 1 });
  }

  const chips = [
    { key: 'all', label: 'Everything', n: next.length + builds.length },
    ...(next.length ? [{ key: 'next', label: 'Carry on', n: next.length }] : []),
    { key: 'new', label: 'New projects', n: builds.length },
    ...themes.map((t) => ({ key: `theme:${t.key}`, label: t.label, n: t.n })),
  ];

  return chips.map((c) => `
    <button type="button" class="filter-chip${c.key === ideaFilter ? ' on' : ''}"
            data-idea-filter="${esc(c.key)}" aria-pressed="${c.key === ideaFilter}">
      ${esc(c.label)}<span class="count">${c.n}</span>
    </button>`).join('');
}

/** What the engine actually read, spelled out — the basis for every card. */
function profileHtml(read) {
  if (!read.ranked.length) return '';
  const rows = read.ranked.slice(0, 6).map(([key, from]) => `
    <div class="info-row">
      <span class="info-k">${esc(themeLabel(key))}</span>
      <span class="info-v">${esc(from.slice(0, 4).join(', '))}${
        from.length > 4 ? ` +${from.length - 4}` : ''}</span>
    </div>`).join('');
  const stack = read.stack.length
    ? `<p class="info-note">Briefs stay in the stack you already use: ${
      esc(read.stack.slice(0, 4).join(', '))}.</p>`
    : '';
  return `<p class="profile-h">${icon('filter')}What your projects say you build</p>${rows}${stack}`;
}

export function renderIdeas() {
  const { next, builds, read } = ideaSets();

  // The filter outlives the render that set it, and the account moves under
  // it — a theme that no longer has ideas would leave the page blank.
  let theme = ideaFilter.startsWith('theme:') ? ideaFilter.slice(6) : null;
  if (theme && !builds.some((b) => b.theme === theme)) {
    ideaFilter = 'all';
    theme = null;
  }
  const showNext = ideaFilter === 'all' || ideaFilter === 'next';
  const shownBuilds = theme ? builds.filter((b) => b.theme === theme)
    : ideaFilter === 'next' ? []
      : builds;

  $('ideas-intro').textContent = read.ranked.length
    ? `${plural(next.length + builds.length, 'idea')}, every one of them derived from `
      + `your ${plural(read.slugs.length, 'project')}.`
    : 'Nothing to read off yet — run a job or two and this fills up with ideas '
      + 'built from your own work.';

  const prof = profileHtml(read);
  $('ideas-profile').innerHTML = prof;
  $('ideas-profile').hidden = !prof;

  $('ideas-filters').innerHTML = chipRow(next, builds);

  $('ideas-next-block').hidden = !(showNext && next.length);
  $('ideas-next').innerHTML = next.map(suggestionHtml).join('');
  $('ideas-next-note').textContent = next.length
    ? `${plural(new Set(next.map((s) => s.slug)).size, 'project')} with a next step`
    : '';

  $('ideas-new-block').hidden = !shownBuilds.length;
  $('ideas-grid').innerHTML = shownBuilds.map(ideaCard).join('');
  $('ideas-new-note').textContent = theme
    ? themeLabel(theme)
    : shownBuilds.length ? 'none of these exist yet' : '';

  $('ideas-empty').hidden = Boolean(shownBuilds.length) || !$('ideas-next-block').hidden;
}

/**
 * How many ideas are waiting, on the two doors into that view. Cheap enough
 * to run every render — both engines are regexes over rows already in memory.
 */
export function renderIdeaBadge() {
  const input = engineInput();
  const n = suggest({ ...input, limit: 24 }).filter((s) => s.kind !== 'starter').length
    + ideas({ ...input, limit: 30 }).length;
  $('ideas-count').textContent = String(n);
  $('ideas-teaser').textContent = `All ${n} ideas`;
}

// ── projects (everything you have, and where each one is live) ────────

/** Search text, the active chip ('all' · 'live' · 'lang:<name>'), and the sort. */
let projectQuery = '';
let projectFilter = 'all';
let projectSort = 'recent';
export const setProjectQuery = (q) => { projectQuery = q; };
export const setProjectFilter = (key) => { projectFilter = key; };
export const setProjectSort = (key) => { projectSort = key; };

const projectEntries = () => catalog({ projects: state.projects, jobs: jobList() });

const LIVE_KIND = { fly: 'on Fly.io', pages: 'on GitHub Pages', homepage: 'at its homepage' };

/** An external link, opened in a new tab — a live site, or the repo. */
const outLink = (url, glyph, label) => `
  <a class="btn tiny ghost" href="${esc(url)}" target="_blank" rel="noopener">${icon(glyph)}${label}</a>`;

/**
 * A project is a card: what it is, where it is live, and the ways in — its
 * chat here, and its repo. The live link gets a line of its own because it is
 * what this screen is for; a project that isn't online says so, so the
 * absence reads as a fact rather than a gap.
 */
function projectCard(p) {
  // Public or private is a fact about a GitHub repo, so only a repo gets one.
  const tags = [
    p.on_github ? (p.private ? 'private' : 'public') : '',
    p.is_local && !p.on_github ? 'local only' : '',
    p.on_github && !p.is_local ? 'not cloned' : '',
    p.is_fork ? 'fork' : '',
    p.is_archived ? 'archived' : '',
  ].filter(Boolean);

  const facts = [
    p.language ? esc(p.language) : '',
    p.pushed_at ? `pushed <span data-ago="${esc(p.pushed_at)}">${ago(p.pushed_at)}</span> ago` : '',
    p.runs ? esc(plural(p.runs, 'run')) : '',
    p.stars ? esc(plural(p.stars, 'star')) : '',
  ].filter(Boolean);

  const live = p.live_url ? `
    <a class="proj-live" href="${esc(p.live_url)}" target="_blank" rel="noopener"
       title="${esc(`Live ${LIVE_KIND[p.live_kind] ?? ''}`.trim())}">
      ${icon('globe')}<span>${esc(liveHost(p.live_url))}</span>${icon('link')}
    </a>`
    : `<p class="proj-live none">${icon('globe')}<span>Not online</span></p>`;

  return `
    <article class="proj" data-project="${esc(p.name)}">
      <div class="proj-top">
        <a class="proj-name" href="${projectHref(p.name)}">${esc(p.name)}</a>
        ${p.busy ? stateTag(p.busy.status, p.busy.status === 'running') : ''}
      </div>
      ${tags.length ? `<div class="proj-tags">${
        tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
      <p class="proj-desc${p.description ? '' : ' none'}">${
        esc(p.description ?? 'No description yet.')}</p>
      ${facts.length ? `<p class="proj-facts">${
        facts.map((f) => `<span>${f}</span>`).join('<span aria-hidden="true">·</span>')}</p>` : ''}
      ${live}
      <div class="proj-actions">
        <a class="btn tiny ghost" href="${projectHref(p.name)}">${icon('arrow')}chat</a>
        ${p.full_name ? outLink(`https://github.com/${p.full_name}`, 'link', 'repo') : ''}
      </div>
    </article>`;
}

/** All · Live · one chip per language, each carrying its own count. */
function projectChips(all) {
  const t = tally(all);
  const chips = [
    { key: 'all', label: 'All', n: t.total },
    ...(t.live ? [{ key: 'live', label: 'Live', n: t.live }] : []),
    ...languages(all).map(([lang, n]) => ({ key: `lang:${lang}`, label: lang, n })),
  ];
  return chips.map((c) => `
    <button type="button" class="filter-chip${c.key === projectFilter ? ' on' : ''}"
            data-project-filter="${esc(c.key)}" aria-pressed="${c.key === projectFilter}">
      ${esc(c.label)}<span class="count">${c.n}</span>
    </button>`).join('');
}

export function renderProjects() {
  const all = projectEntries();
  const t = tally(all);

  // The filter outlives the render that set it, and the list moves under it:
  // a language whose last project went away would leave the page blank.
  const langs = new Set(all.map((e) => e.language));
  if ((projectFilter === 'live' && !t.live)
    || (projectFilter.startsWith('lang:') && !langs.has(projectFilter.slice(5)))) {
    projectFilter = 'all';
  }

  const shown = order(narrow(all, { query: projectQuery, filter: projectFilter }), projectSort);

  $('projects-intro').textContent = t.total
    ? `${plural(t.total, 'project')}: ${t.live} live on the web, ${t.onGitHub} on GitHub${
      t.localOnly ? `, ${t.localOnly} only on your desktop` : ''}.`
    : state.loading ? 'Loading…' : 'Nothing listed yet.';

  $('projects-tools').hidden = !t.total;
  $('projects-filters').innerHTML = t.total ? projectChips(all) : '';
  $('projects-grid').innerHTML = shown.map(projectCard).join('');
  $('projects-none').hidden = !t.total || Boolean(shown.length);
  $('projects-empty').hidden = Boolean(t.total) || state.loading;
}

/** The size of the list, on the sidebar door into it. */
export function renderProjectBadge() {
  const n = projectEntries().length;
  $('projects-count').textContent = n ? String(n) : '';
}

// ── agents (every run at once) ────────────────────────────────────────
// The fleet screen. Home answers "is anything happening"; this one answers
// "what are all of them doing, and what is the queue waiting for" — which is
// the question you get as soon as more than one agent can run.

/** The ceiling in a sentence, used by the hint line and the toast. */
export function slotsSentence() {
  const f = fleetNow();
  const ceiling = `Your desktop runs up to ${plural(f.max, 'agent')} at once`;
  if (!state.slotsSynced) {
    return `${ceiling} — but this number is only on this device so far: `
      + `the settings row isn't readable, so the runner still works one job at a time.`;
  }
  return `${ceiling}, one per project. ${f.used} in flight, ${plural(f.free, 'slot')} free.`;
}

/** Why one queued job hasn't started, in the words this account can justify. */
function waitLabel({ reason, job, label }) {
  if (reason === 'project') return `waiting for ${job.project_slug} to finish`;
  if (reason === 'host') {
    return state.host ? 'your desktop is offline' : 'no desktop has checked in';
  }
  if (reason === 'next') return 'next up — claimed within seconds';
  return label;
}

/** The last few log lines, so a card says what it is doing without a tap. */
function tailHtml(job) {
  const lines = eventsOf(job.id).slice(isNarrow() ? -2 : -3);
  if (!lines.length) return '';
  return `<div class="agent-tail">${lines.map(logLine).join('')}</div>`;
}

/**
 * One agent, as a card: who it is, what it is doing this second, the tail of
 * its log, and the two things you might want — its thread, or its neck.
 */
function agentCard(job) {
  const live = job.status === 'running';
  const act = live ? lastActivity(job.id) : null;
  const clock = live
    ? `<span class="agent-clock" data-elapsed="${esc(job.claimed_at ?? job.created_at)}">${
        elapsed(job.claimed_at ?? job.created_at)}</span>`
    : job.resume_at
      ? `<span class="agent-clock">resumes ${esc(dayClock(job.resume_at))}</span>`
      : '<span class="agent-clock">waiting</span>';

  const now = act
    ? `<p class="agent-now">${icon('pulse')}<span>${esc(clip(act.text, 120))}</span></p>`
    : `<p class="agent-now quiet">${icon('clock')}<span>${esc(firstLine(job.prompt))}</span></p>`;

  const actions = [
    `<a class="btn tiny ghost" href="${jobHref(job)}">${icon('arrow')}thread</a>`,
    job.cancel_requested
      ? '<span class="muted small">stopping…</span>'
      : `<button class="btn tiny ghost" data-cancel="${esc(job.id)}">${icon('stop')}stop</button>`,
  ].join('');

  return `
    <article class="agent${live ? ' live' : ''}" data-status="${esc(job.status)}"
             data-agent="${esc(job.id)}">
      <div class="agent-top">
        <a class="agent-name" href="${jobHref(job)}">${esc(job.project_slug ?? 'naming…')}</a>
        ${stateTag(job.status, live)}
        ${clock}
      </div>
      ${now}
      ${job.status === 'paused' ? `<p class="note" data-status="paused">Usage limit reached —
        it keeps its slot and picks up where it left off${job.resume_at
          ? ` in ${esc(until(job.resume_at))}` : ''}.</p>` : ''}
      ${tailHtml(job)}
      <div class="agent-foot">
        <span class="agent-facts">${jobFacts(job)}</span>
        <span class="agent-actions">${actions}</span>
      </div>
    </article>`;
}

const waitRow = (w) => `
  <a class="row" data-status="queued" href="${jobHref(w.job)}">
    <span class="row-top">
      <span class="row-name">${esc(w.job.project_slug ?? 'new project')}</span>
      <span class="row-why" data-status="${w.reason === 'next' ? 'running' : 'queued'}">
        <i class="dot"></i>${esc(waitLabel(w))}
      </span>
      <span class="row-when">${w.ahead ? `${w.ahead} ahead` : 'first'}</span>
    </span>
    <span class="row-sub">${esc(firstLine(w.job.prompt))}</span>
  </a>`;

/** One pip per slot. A graphic, so the count beside it carries the words. */
const pipsHtml = (f) => f.pips
  .map((kind) => `<i class="pip${kind === 'free' ? '' : ` on`}" data-status="${
    kind === 'free' ? 'queued' : kind}"></i>`)
  .join('');

export function renderAgents() {
  const f = fleetNow();
  const inFlight = [...f.running, ...f.paused];

  $('fleet-value').textContent = String(f.running.length);
  $('fleet-label').textContent = f.running.length === 1 ? 'agent running' : 'agents running';
  $('fleet-pips').innerHTML = pipsHtml(f);
  $('fleet-pips').setAttribute('aria-label',
    `${f.used} of ${f.max} slots busy${f.paused.length ? `, ${f.paused.length} paused` : ''}`);

  const chip = (status, text) => `<span class="stat-chip"${status ? ` data-status="${status}"` : ''}>${
    status ? '<i class="dot"></i>' : ''}${text}</span>`;
  const chips = [chip('', `<b>${f.used}</b> of <b>${f.max}</b> slots busy`)];
  if (f.paused.length) chips.push(chip('paused', `<b>${f.paused.length}</b> paused for usage`));
  if (f.blocked) chips.push(chip('queued', `<b>${f.blocked}</b> waiting for a slot`));
  if (f.over) chips.push(chip('paused', `<b>${f.over}</b> over the ceiling`));
  if (!state.hostFresh) chips.push(chip('paused', 'desktop offline'));
  $('fleet-chips').innerHTML = chips.join('');

  for (const el of document.querySelectorAll('#slots input[name="slots"]')) {
    el.checked = Number(el.value) === f.max;
  }
  $('slots-note').textContent = `${f.used} of ${f.max} busy`;
  $('slots-hint').textContent = slotsSentence();

  $('fleet-count').textContent = inFlight.length ? String(inFlight.length) : '';
  $('fleet-list').innerHTML = inFlight.map(agentCard).join('');
  $('fleet-empty').hidden = Boolean(inFlight.length);

  $('waiting-block').hidden = !f.waiting.length;
  $('waiting-list').innerHTML = f.waiting.map(waitRow).join('');
  $('waiting-note').textContent = f.waiting.length
    ? `${plural(f.waiting.length, 'job')} queued` : '';

  const settled = jobList().filter((j) => !isActive(j)).sort(newest).slice(0, 3);
  $('fleet-done-block').hidden = !settled.length;
  $('fleet-done').innerHTML = settled.map(jobRow).join('');
  $('fleet-done-note').textContent = settled.length
    ? `last ${ago(settled[0].created_at)} ago` : '';

  $('stop-all').hidden = f.active.length < 2;
}

/** How many agents are in flight, on every door into this view. */
export function renderFleetBadge() {
  const n = jobList().filter(isActive).length;
  $('agents-count').textContent = n ? String(n) : '';
  const pip = $('tab-agents-count');
  pip.textContent = n ? String(n) : '';
  pip.hidden = !n;
}

/** The bottom tabs on a phone: which section you are in. */
export function renderTabs() {
  const doors = [['tab-home', 'home'], ['tab-agents', 'agents'], ['tab-new', 'new'],
    ['tab-projects', 'projects'], ['tab-ideas', 'ideas']];
  for (const [id, view] of doors) {
    if (route.view === view) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  }
}

// ── home ──────────────────────────────────────────────────────────────

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');

/** Running first, then paused, then the queue — urgency, not arrival. */
const URGENCY = { running: 0, paused: 1, queued: 2 };
const byUrgency = (a, b) => (URGENCY[a.status] - URGENCY[b.status]) || oldest(a, b);

export function renderHome() {
  const all = jobList();
  const active = all.filter(isActive).sort(byUrgency);
  const running = active.filter((j) => j.status === 'running');
  const paused = active.filter((j) => j.status === 'paused');
  const queued = active.filter((j) => j.status === 'queued');
  const finished = all.filter((j) => j.status === 'done');
  const failed = all.filter((j) => j.status === 'error');

  const f = fleetNow();
  const bare = !all.length && !state.projects.length && !state.loading;
  $('home-empty').hidden = !bare;
  // On a brand-new account the empty state is the whole page — a big zero
  // above it is noise.
  for (const id of ['hero-card', 'active-block', 'usage-block', 'glance-block',
    'recent-block', 'activity-block', 'desktop-block', 'suggest-block']) {
    $(id).hidden = bare;
  }

  // One hero figure per view: what is happening right now.
  $('hero-value').textContent = String(running.length);
  $('hero-label').textContent = running.length === 1 ? 'agent running' : 'agents running';
  $('hero-eyebrow').textContent = state.loading ? 'Loading…' : 'Right now';

  // The hero says how many; this line says what, which is the part you want.
  const lead = running[0];
  const act = lead ? lastActivity(lead.id) : null;
  $('hero-now').hidden = bare || !lead;
  if (lead) {
    $('hero-now').innerHTML = `${icon('pulse')}<span><b>${esc(lead.project_slug ?? 'naming…')}</b>
      — ${esc(clip(act ? act.text : lead.prompt, 90))}</span>`;
  }

  const chip = (status, text) => `
    <span class="stat-chip" data-status="${esc(status)}"><i class="dot"></i>${text}</span>`;
  const chips = [];
  if (active.length) {
    chips.push(`<a class="stat-chip" href="#/agents"><b>${f.used}</b> of <b>${f.max}</b> slots busy</a>`);
  }
  if (paused.length) chips.push(chip('paused', `<b>${paused.length}</b> paused for usage`));
  if (f.blocked) chips.push(chip('queued', `<b>${f.blocked}</b> waiting for a slot`));
  else if (queued.length) chips.push(chip('queued', `<b>${queued.length}</b> waiting on desktop`));
  if (!active.length && !bare) {
    chips.push(`<span class="stat-chip">Nothing in progress</span>`);
  }
  if (!state.hostFresh && !bare) {
    chips.push(`<span class="stat-chip" data-status="paused"><i class="dot"></i>desktop offline</span>`);
  }
  $('hero-chips').innerHTML = chips.join('');

  // Home leads with the fleet rather than listing it: three rows, then the
  // door to the screen that holds all of them.
  const LEAD = 3;
  $('active-block').hidden = bare || !active.length;
  $('active-count').textContent = active.length ? String(active.length) : '';
  $('active-list').innerHTML = state.loading && !active.length
    ? '<div class="skel skel-row"></div>'
    : active.slice(0, LEAD).map(jobRow).join('');
  $('active-note').textContent = active.length > LEAD ? `showing ${LEAD} of ${active.length}` : '';
  $('active-more').hidden = !active.length;
  $('active-more-text').textContent = active.length > LEAD
    ? `All ${active.length} agents` : 'Every agent, and the queue';

  const slugs = new Set(all.map((j) => j.project_slug).filter(Boolean));
  const turns = finished.reduce((sum, j) => sum + (Number(j.num_turns) || 0), 0);
  const settled = finished.length + failed.length;

  $('kpi-projects').textContent = String(state.projects.length || slugs.size);
  $('kpi-projects-note').textContent = slugs.size
    ? `${slugs.size} worked on so far` : 'none run yet';
  $('kpi-done').textContent = String(finished.length);
  $('kpi-done-note').textContent = turns ? `${plural(turns, 'turn')} of work` : '';
  $('kpi-failed').textContent = String(failed.length);
  $('kpi-failed-note').textContent = failed.length
    ? 'open one to retry' : 'nothing broken';
  $('kpi-failed').closest('.tile').classList.toggle('flag', failed.length > 0);
  $('kpi-rate').textContent = pct(finished.length, settled);
  $('kpi-rate-note').textContent = settled ? `of ${plural(settled, 'finished run')}` : 'no runs yet';

  const strip = activityHtml(all);
  $('activity-block').hidden = bare || !all.length;
  $('activity').innerHTML = strip.html;
  $('activity-note').textContent = strip.total
    ? `${plural(strip.total, 'run')} · busiest ${weekday(strip.peak.date)} (${strip.peak.n})`
    : 'nothing started yet';

  const recent = all.filter((j) => !isActive(j)).sort(newest).slice(0, 5);
  $('recent-block').hidden = bare || !recent.length;
  $('recent-list').innerHTML = recent.map(jobRow).join('');

  $('desktop-card').innerHTML = desktopHtml();

  // The reference half of the page — the strip, the history, the desktop —
  // is the part a phone has no room for, so there it is one tap behind a
  // toggle. On a wide screen it is the right-hand column and always open.
  const folded = isNarrow() && !moreOpen;
  $('home-more').hidden = bare || folded;
  $('home-more-toggle').hidden = bare || !isNarrow();
  $('home-more-toggle').setAttribute('aria-expanded', String(!folded));
  $('home-more-label').textContent = folded ? 'More detail' : 'Less detail';
}

/** Whether home's reference blocks are open on a narrow screen. */
let moreOpen = false;
export const toggleHomeMore = () => { moreOpen = !moreOpen; return moreOpen; };

/** The runner on your PC, spelled out — the pill only has room for a word. */
function desktopHtml() {
  const { host, hostFresh, realtime } = state;
  const feed = { live: 'live', error: 'reconnecting', connecting: 'connecting' }[realtime]
    ?? realtime;
  const rows = [
    ['Desktop', host ? esc(host.name) : 'none has checked in'],
    ['State', host
      ? `<span class="state" data-status="${hostFresh ? 'done' : 'queued'}">
           <i class="dot${hostFresh ? ' live' : ''}"></i>${hostFresh ? 'online' : 'offline'}</span>`
      : `<span class="state" data-status="error"><i class="dot"></i>never seen</span>`],
    ['Last checked in', host
      ? `<span data-ago="${esc(host.last_seen)}">${ago(host.last_seen)}</span> ago`
      : '—'],
    ['Live updates', `<span class="state" data-status="${realtime === 'live' ? 'done' : 'paused'}">
       <i class="dot"></i>${esc(feed)}</span>`],
  ];
  const note = !host
    ? 'Start the runner on your PC and it will claim queued jobs.'
    : hostFresh ? 'Anything you send starts right away.'
      : 'Jobs you send will sit in the queue until it boots.';

  return rows.map(([k, v]) => `
    <div class="info-row"><span class="info-k">${esc(k)}</span><span class="info-v">${v}</span></div>`)
    .join('') + `<p class="info-note">${esc(note)}</p>`;
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
      ? `<span class="msg-clock">resumes ${esc(dayClock(job.resume_at))}</span>`
      : `<span class="msg-clock">${esc(when(job.created_at))}</span>`;

  const paused = job.status === 'paused' ? `
    <p class="note" data-status="paused">Usage limit reached. This picks up
      automatically where it left off${job.resume_at
        ? ` — <b>${esc(dayClock(job.resume_at))}</b>, in ${esc(until(job.resume_at))}`
        : ''}. Nothing for you to do.</p>` : '';

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
    webUrl(job.live_url) ? outLink(job.live_url, 'globe', 'site') : '',
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

  const facts = jobFacts(job);

  return `
    <div class="msg agent${live ? ' live' : ''}" data-status="${esc(job.status)}">
      <div class="msg-head">${stateTag(job.status, job.status === 'running')}${trailer}</div>
      ${facts ? `<div class="msg-facts">${facts}</div>` : ''}
      ${paused}
      ${body}
      ${logBlock}
      ${job.error ? `<p class="note bad" data-status="error">${esc(job.error)}</p>` : ''}
      <div class="msg-actions">${actions}</div>
    </div>`;
}

/** Everything that has happened to one project, in one line. */
function chatStats(mine) {
  if (!mine.length) return '';
  const done = mine.filter((j) => j.status === 'done').length;
  const failed = mine.filter((j) => j.status === 'error').length;
  const open = mine.filter(isActive).length;
  const turns = mine.reduce((sum, j) => sum + (Number(j.num_turns) || 0), 0);
  const last = mine.at(-1);
  const bits = [
    plural(mine.length, 'run'),
    done ? `${done} done` : '',
    failed ? `${failed} failed` : '',
    open ? `${open} open` : '',
    turns ? plural(turns, 'turn') : '',
  ].filter(Boolean);
  return `<span class="chat-stats">${bits.map((b) => esc(b)).join(' · ')}
    · last <span data-ago="${esc(last.created_at)}">${ago(last.created_at)}</span> ago</span>`;
}

export function renderChat() {
  const slug = route.slug;
  const mine = threadOf(slug);
  const p = projectOf(slug);
  const gone = projectGone(slug);
  const repo = githubUrl(p) ?? mine.find((j) => j.repo_url)?.repo_url ?? null;
  // The same answer the Projects screen gives, so the two never disagree.
  const site = catalog({ projects: p ? [p] : [], jobs: mine })
    .find((e) => e.name === slug)?.live_url ?? null;

  $('chat-head').hidden = false;
  $('chat-head').innerHTML = `
    <div class="chat-title">
      <h2>${esc(slug)}</h2>
      <span class="meta">
        ${p?.private ? '<span class="tag">private</span>' : ''}
        ${p?.is_local && !p?.full_name ? '<span class="tag">local</span>' : ''}
        ${gone ? '<span class="tag gone">gone</span>' : ''}
        ${site ? outLink(site, 'globe', 'site') : ''}
        ${repo ? `<a class="btn tiny ghost" href="${esc(repo)}" target="_blank" rel="noopener">
                    ${icon('link')}repo</a>` : ''}
        ${mine.length ? `<button class="btn tiny ghost" data-delete-chat="${esc(slug)}">
                           ${icon('trash')}clear chat</button>` : ''}
      </span>
    </div>
    ${chatStats(mine)}`;

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
  // The fleet cards each carry a tail of their own log, so a line that
  // belongs to any live agent changes that screen.
  if (route.view === 'agents') {
    if (job && isActive(job)) onRerender();
    return;
  }
  const onScreen = job && (
    (route.view === 'project' && job.project_slug === route.slug)
    || (route.view === 'pending' && job.id === route.jobId));
  if (!onScreen) return;

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
