// Rendering. Every function here reads `state` and writes DOM — no queries,
// no fetches. Called whenever the store says something changed.

import {
  $, esc, ago, since, elapsed, dayClock, until, when, stamp, plural, clip,
  firstLine, signedOut, SIGNED_OUT_FIX,
} from './util.js';
import { readings, tightest, chip, sentence, resetWords, spanWords } from './usage.js';
import { md } from './md.js';
import { icon, setBadge, isNarrow, setOffline } from './ui.js';
import { route, projectHref, askHref, siteHref } from './router.js';
import { STATUS_WORD, STATUS_TONE, FILTERS as FIELD_FILTERS, filtered, dialable } from './field.js';
import { suggest } from './suggest.js';
import { ideas, profile, themeLabel } from './ideas.js';
import { catalog, languages, narrow, order, tally, liveHost, webUrl } from './catalog.js';
import { replyState, turns as askTurns, STARTERS, isPending } from './assistant.js';
import {
  kindOf, kindIcon, isOn, isAway, stateWord, detailLine, actionsFor, isDimmable,
  nudged, commandLabel, litLights, isQueued, RELAY_HOSTS,
} from './house.js';
import {
  state, isActive, jobList, newest, threadOf, latestOf,
  projectOf, projectGone, eventsOf, lastActivity, resultOf, fleetNow,
  askChats, askPresence, askPending,
  houseDevices, houseRoomList, houseSummaryNow, housePresence, houseState,
  housePending, houseBusy, houseRecent,
  fieldSiteList, fieldTallyNow, fieldSiteOf, fieldTimelineOf,
  unsentJobs, unsentAsks, outboxEntry, keepsAcrossReloads,
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
  const who = askPresence();
  const titles = {
    project: route.slug ?? '',
    pending: 'Starting…',
    new: 'New project',
    agents: 'Agents',
    house: 'House',
    ask: who.known ? who.name : 'Assistant',
    ideas: 'Ideas',
    projects: 'Projects',
    field: 'Field reports',
    site: fieldSiteOf(route.siteId)?.name ?? 'Site',
    outbox: 'Outbox',
  };
  $('view-title').textContent = titles[route.view] ?? '';

  let sub = '';
  if (route.view === 'project') {
    const p = projectOf(route.slug);
    const n = threadOf(route.slug).length;
    sub = [
      p?.full_name ?? (p?.is_local ? 'on your desktop' : ''),
      n ? plural(n, 'message') : 'no messages yet',
    ].filter(Boolean).join(' · ');
  } else if (route.view === 'pending') {
    sub = outboxEntry(route.jobId) ? 'not sent yet — kept on this phone'
      : state.cloud ? 'starting in the cloud' : 'waiting for your desktop to name it';
  } else if (route.view === 'agents') {
    const f = fleetNow();
    sub = [
      `${f.running.length} of ${f.max} running`,
      f.waiting.length ? `${f.waiting.length} waiting` : '',
    ].filter(Boolean).join(' · ');
  } else if (route.view === 'house') {
    const home = houseSummaryNow();
    sub = state.houseReady
      ? [houseState().label, home.devices ? plural(home.devices, 'device') : ''].filter(Boolean).join(' · ')
      : 'not set up yet';
  } else if (route.view === 'ask') {
    const threads = askChats().length;
    sub = [
      presenceWord(who),
      threads ? plural(threads, 'conversation') : '',
    ].filter(Boolean).join(' · ');
  } else if (route.view === 'field') {
    const n = fieldTallyNow();
    sub = n.all
      ? [plural(n.all, 'site'), n.queued ? `${n.queued} not sent` : ''].filter(Boolean).join(' · ')
      : state.fieldError ? 'not set up yet' : '';
  } else if (route.view === 'site') {
    const site = fieldSiteOf(route.siteId);
    sub = site ? [site.asset_tag, site.region].filter(Boolean).join(' · ') : '';
  } else if (route.view === 'outbox') {
    sub = state.outbox.length ? `${plural(state.outbox.length, 'thing')} waiting` : 'nothing waiting';
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
  const hostWord = hostFresh ? host.name
    : state.cloud ? 'cloud · asleep'
      : host ? `${host.name} · off` : 'no desktop';
  $('host-name').textContent = hostWord;
  // On a narrow screen the name is hidden to give the title its width back,
  // so the button has to carry it some other way.
  pill.setAttribute('aria-label', `Runner: ${hostWord}`);
  pill.title = hostWord;
}

export function hostExplainer() {
  const feed = state.realtime === 'live' ? '' : ' · live updates reconnecting';
  if (state.hostFresh) return `${state.host.name} is online — jobs start right away.${feed}`;
  if (state.cloudRefused) {
    return `The cloud runner is set up but refused this account: ${state.cloudRefused}. `
      + `Check OWNER_ID in the Vercel project's settings.${feed}`;
  }
  if (state.cloud) {
    return 'The cloud runner sleeps when nothing is queued and starts within seconds of '
      + `anything you send — your PC can stay off.${feed}`;
  }
  if (!state.host) return `No desktop has ever checked in. Start the runner on your PC.${feed}`;
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

  // The doors under "New project" say which of them you are behind. One
  // site is still the Field section.
  const here = route.view === 'site' ? 'field' : route.view;
  for (const [id, view] of [['ask-link', 'ask'], ['agents-link', 'agents'],
    ['house-link', 'house'], ['field-link', 'field'], ['projects-link', 'projects'],
    ['ideas-link', 'ideas'], ['outbox-link', 'outbox']]) {
    if (here === view) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  }
}

// ── usage meters ──────────────────────────────────────────────────────
// What a reading means lives in usage.js, because it is the part that has to
// be right: this file only draws it. A meter always says two things under its
// bar — when the window resets, and how long that is — because those are the
// two things you look at it to find out.

const usageList = () => readings(state.usage);

/** The rest of the line under a bar: when it resets, or why it cannot say. */
function resetHtml(r) {
  const w = resetWords(r);
  if (r.state === 'live') {
    return `<span class="meter-reset">Resets <b>${esc(w.clock)}</b>
      <span class="sep">·</span>
      <span class="in" data-until-phrase="${esc(r.resetISO)}">${esc(w.phrase)}</span></span>`;
  }
  if (r.state === 'idle') {
    // Not unknown: Anthropic opens a window with your next message, so there
    // is no clock running yet. The useful answer is how long you will have,
    // which meterHtml puts where the headroom goes.
    return '<span class="meter-reset">Starts with your next message</span>';
  }
  if (r.state === 'stale') {
    return `<span class="meter-reset">Reset <b>${esc(w.clock)}</b>
      <span class="sep">·</span> ${esc(w.ago)} — waiting for a new reading</span>`;
  }
  return '<span class="meter-reset">Reset time not reported</span>';
}

/** What is left: a share of it — or, for a window yet to start, how long it will last. */
function headroomHtml(r) {
  if (r.state === 'stale') return '';          // a number that is out of date has no headroom
  if (r.state === 'idle' && r.span) return `<span class="meter-left">lasts ${esc(spanWords(r.span))}</span>`;
  return `<span class="meter-left">${r.left}% left</span>`;
}

/**
 * A ratio against a limit is a meter, not a chart. The fill carries severity
 * and the track is a lighter step of the same ramp, so the state reads across
 * the whole bar — and the percentage is always written out beside it, with a
 * word for the severity, so the colour is never the only thing saying it.
 */
function meterHtml(r) {
  const pct = Math.round(r.pct);
  return `
      <div class="meter ${r.tone}" data-window="${esc(r.type)}" data-state="${esc(r.state)}">
        <div class="meter-head">
          <span class="meter-name">${esc(r.label)}</span>
          <span class="meter-state"><i class="dot"></i>${esc(r.word)}</span>
          <span class="meter-pct">${r.state === 'stale'
            ? `was <b>${pct}%</b>` : `<b>${pct}%</b> used`}</span>
        </div>
        <div class="meter-track">
          <i class="meter-fill" style="width:${r.fill}%"></i>
        </div>
        <div class="meter-foot">
          ${resetHtml(r)}
          ${headroomHtml(r)}
        </div>
      </div>`;
}

const usageHtml = () => usageList().map(meterHtml).join('');

/** One sentence a person can act on, used by the sheet, the chip and the toast. */
export function usageSentence() {
  if (state.usageError) return `Couldn’t read your limits — ${state.usageError}`;
  // `since`, not `ago`: "read now ago" is what a fresh read used to say.
  const read = state.usageAt ? ` Read ${since(state.usageAt)}.` : '';
  return `${sentence(usageList())}${usageList().length ? read : ''}`;
}

/**
 * Whether the readings are arriving, in words. A meter that is stuck is
 * indistinguishable from a quiet account unless the page says which it is:
 * when the last read landed, and when its numbers last actually moved.
 */
function freshnessHtml() {
  if (state.usageError) {
    return `<span class="usage-read bad">${icon('offline')}<span>couldn’t read the limits —
      ${esc(clip(state.usageError, 80))}</span></span>`;
  }
  if (!state.usageAt) return '<span class="usage-read">no reading yet</span>';
  // No trailing "ago": `ago()` already answers with "now" when it is now.
  const moved = state.usageMovedAt
    ? ` · changed <span data-ago="${esc(state.usageMovedAt)}">${ago(state.usageMovedAt)}</span>`
    : ' · unchanged so far';
  // One inline run inside the flex row: as separate text nodes, each became
  // its own flex item and a narrow screen broke "last read now" into a column.
  return `<span class="usage-read">${icon('clock')}<span>last read
    <span data-ago="${esc(state.usageAt)}">${ago(state.usageAt)}</span>${moved}</span></span>`;
}

export function renderUsage() {
  const list = usageList();
  const inner = list.map(meterHtml).join('');
  const bare = !jobList().length && !state.projects.length && !state.loading;

  // The same meters, drawn wherever you might be asking: the front page, the
  // sheet behind the chip, the new-project screen, and the desktop sidebar.
  for (const id of ['usage-agents', 'usage-new', 'usage-side', 'usage-sheet-list']) {
    const el = $(id);
    el.innerHTML = inner;
    el.hidden = !inner;
  }
  $('usage-new-block').hidden = !inner;
  // The front page already leads with them; no need to print them twice.
  $('usage-side').hidden = !inner || route.view === 'agents';
  $('usage-empty').hidden = Boolean(inner) || Boolean(state.usageError);
  $('usage-block').hidden = bare && !inner && !state.usageError;
  $('usage-foot').innerHTML = freshnessHtml();
  $('usage-sheet-foot').innerHTML = freshnessHtml();
  $('usage-sheet-lead').textContent = usageSentence();

  const lead = tightest(list);
  $('usage-note').textContent = lead
    ? `${lead.left}% left on ${lead.short}` : '';

  // The chip: how much, and how long. Its title and accessible name carry the
  // whole sentence, since the chip has room for two short figures only.
  const c = chip(list);
  const pill = $('usage-pill');
  pill.hidden = !c;
  if (!c) return;
  pill.classList.remove('warn', 'full');
  if (c.reading.tone) pill.classList.add(c.reading.tone);
  pill.dataset.state = c.reading.state;
  $('usage-ring').setAttribute('stroke-dasharray', `${c.fill} ${100 - c.fill}`);
  pill.title = usageSentence();
  pill.setAttribute('aria-label', `Usage ${c.reading.word} — ${usageSentence()}`);
  $('usage-pill-text').innerHTML = `${esc(c.text)}${
    c.sub ? `<span class="pill-sub"> ${esc(c.sub)}</span>` : ''}`;
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
  const who = state.cloud ? 'The cloud runner' : 'Your desktop';
  const room = f.free
    ? `${plural(f.free, 'slot')} free of ${f.max} — it starts as soon as ${who.toLowerCase()} sees it.`
    : `All ${plural(f.max, 'slot')} are busy, so this one queues behind them.`;
  $('new-intro').textContent = `Describe what to build. ${who} picks it up, `
    + `creates the repo, writes the code, and pushes it. ${room}`;
}

export function renderSuggestions() {
  const all = remember(suggestionList());

  const fromYours = all.filter((s) => s.kind !== 'starter').length;
  const note = fromYours
    ? `${fromYours} from your ${plural(new Set(all.filter((s) => s.slug).map((s) => s.slug)).size,
      'project')}`
    : 'ideas to get you started';

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
  $('ideas-teaser').textContent = `All ${n} ideas, read off your own work`;
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
// The front page. It answers "is anything happening", then "what are all of
// them doing, and what is the queue waiting for" — the question you get as
// soon as more than one agent can run — and sits your limits right under it,
// because what is running is mostly a question of what you have left.

/**
 * The ceiling in a sentence. Three cases, and the difference between them
 * matters: a number nothing can read is not a ceiling, and neither is one
 * that was never written down.
 */
export function slotsSentence() {
  const f = fleetNow();
  const many = `up to ${plural(f.max, 'agent')} at once`;
  const claim = !state.slotsSynced
    ? `Saved on this device only — the settings row can't be read, so there is `
      + `no ceiling for your desktop to claim against and it works to its own.`
    : !state.slotsPublished
      ? `Not published yet — tap a number to tell your desktop it may run ${many}.`
      : `${state.cloud ? 'The cloud runner' : 'Your desktop'} runs ${many}, one per project.`;
  return `${claim} ${f.used} in flight, ${plural(f.free, 'slot')} free.`;
}

/** Why the cloud runner, when it last looked, chose to leave this job. */
const CLOUD_WHY = {
  cap: 'over its usage cap — starts when the window resets',
  'pc-only': 'only on your PC, not GitHub — starts when your PC is on',
  pc: 'left for your desktop, which was awake',
};
const cloudWhy = (job) => CLOUD_WHY[state.cloudWhy?.get(String(job.id))] ?? null;

/** Why one queued job hasn't started, in the words this account can justify. */
function waitLabel({ reason, job, label }) {
  if (reason === 'project') return `waiting for ${job.project_slug} to finish`;
  if (reason === 'host') {
    return state.host ? 'your desktop is offline' : 'no desktop has checked in';
  }
  if (reason === 'wake' && cloudWhy(job)) return cloudWhy(job);
  if (reason === 'wake') return 'starting in the cloud — a few seconds';
  if (reason === 'host' && state.cloudRefused) return `the cloud runner refused: ${state.cloudRefused}`;
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
 * its log, and the two things you might want from it — its thread, or a stop.
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

  const statChip = (status, text) => `<span class="stat-chip"${status ? ` data-status="${status}"` : ''}>${
    status ? '<i class="dot"></i>' : ''}${text}</span>`;
  const chips = [statChip('', `<b>${f.used}</b> of <b>${f.max}</b> slots busy`)];
  if (f.paused.length) chips.push(statChip('paused', `<b>${f.paused.length}</b> paused for usage`));
  if (f.blocked) chips.push(statChip('queued', `<b>${f.blocked}</b> waiting for a slot`));
  if (f.over) chips.push(statChip('paused', `<b>${f.over}</b> over the ceiling`));
  // The newest settled run decides it: one that finished after a sign-in
  // failure means the desktop has logged back in.
  const lastSettled = jobList().filter((j) => j.status === 'done' || j.status === 'error')
    .sort(newest)[0];
  if (lastSettled?.status === 'error' && signedOut(lastSettled.error)) {
    chips.push(`<a class="stat-chip" data-status="error" href="${esc(jobHref(lastSettled))}"
      title="${esc(SIGNED_OUT_FIX)}"><i class="dot"></i>desktop signed out — run /login</a>`);
  }
  if (!state.hostFresh && !state.cloud) chips.push(statChip('paused', 'desktop offline'));
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

  $('desktop-card').innerHTML = desktopHtml();
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
  const doors = [['tab-agents', 'agents'], ['tab-ask', 'ask'], ['tab-new', 'new'],
    ['tab-house', 'house'], ['tab-projects', 'projects']];
  // The front page is Agents; any other view lights no tab.
  const here = route.view;
  for (const [id, view] of doors) {
    if (here === view) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  }
}

// ── the runner ────────────────────────────────────────────────────────

/** The runner on your PC, spelled out — the pill only has room for a word. */
function desktopHtml() {
  const { host, hostFresh, realtime } = state;
  const feed = { live: 'live', error: 'reconnecting', connecting: 'connecting' }[realtime]
    ?? realtime;
  const rows = [
    ['Name', host ? esc(host.name) : state.cloud ? 'cloud' : 'none has checked in'],
    ['State', host || state.cloud
      ? `<span class="state" data-status="${hostFresh ? 'done' : 'queued'}">
           <i class="dot${hostFresh ? ' live' : ''}"></i>${hostFresh ? 'online'
             : state.cloud ? 'asleep' : 'offline'}</span>`
      : `<span class="state" data-status="error"><i class="dot"></i>never seen</span>`],
    ['Last checked in', host
      ? `<span data-since="${esc(host.last_seen)}">${since(host.last_seen)}</span>`
      : '—'],
    ['Live updates', `<span class="state" data-status="${realtime === 'live' ? 'done' : 'paused'}">
       <i class="dot"></i>${esc(feed)}</span>`],
  ];
  const note = hostFresh ? 'Anything you send starts right away.'
    : state.cloud ? 'The cloud runner starts within seconds of anything you send, '
      + 'with your PC on or off. Each project keeps its own workspace between runs.'
      : !host ? 'Start the runner on your PC and it will claim queued jobs.'
        : 'Jobs you send will sit in the queue until it boots.';

  return rows.map(([k, v]) => `
    <div class="info-row"><span class="info-k">${esc(k)}</span><span class="info-v">${v}</span></div>`)
    .join('') + `<p class="info-note">${esc(note)}</p>`;
}

// ── your own assistant ────────────────────────────────────────────────
// The second thing this app relays. A coding agent answers with a repo; your
// assistant answers with a sentence — but the path is identical, so the
// screen keeps the same manners: a reply always says what it is waiting for,
// and "typing…" is never printed over a PC that is switched off.

/** Reply states, drawn in the ramp the rest of the app already uses. */
const REPLY_STATUS = {
  typing: 'running',    // work in progress is blue, not a warning
  stopping: 'running',
  next: 'queued',
  queued: 'queued',
  offline: 'paused',    // waiting on something outside the app is amber
  never: 'paused',
  waking: 'running',    // starting up is work in progress
  failed: 'error',
  done: 'done',
};

/** The conversation on screen: the one in the URL, else the newest. */
export function currentConversation() {
  const all = askChats();
  if (route.chatId) return all.find((c) => String(c.id) === String(route.chatId)) ?? null;
  return all[0] ?? null;
}

/** The word on the pill. Four states, because "offline" hides two of them. */
function presenceWord(who) {
  if (!state.askReady) return 'not set up';
  if (who.online) return 'online';
  if (state.cloud) return 'in the cloud · wakes when you ask';
  if (!who.known) return 'no assistant yet';
  return `last seen ${ago(who.lastSeen)} ago`;
}

/** The same thing in a sentence — what the toast says. */
export function askExplainer() {
  const who = askPresence();
  if (!state.askReady) {
    return 'The conversation tables are not in your Supabase project yet. Run '
      + 'bridge/schema.sql, then start the bridge on your PC.';
  }
  if (state.cloud && !who.online) {
    return 'Claude answers from the cloud, with your projects, the dashboard and the house to '
      + 'hand. It sleeps between conversations and wakes in a few seconds when you ask.';
  }
  if (!who.known) {
    return 'No assistant has ever checked in. Run the bridge on your PC and it shows '
      + 'up here — then anything you send is answered while the PC is on.';
  }
  const model = who.model ? ` (${who.model})` : '';
  if (who.online) {
    return `${who.name}${model} is listening on your PC. Replies come straight back here.`;
  }
  return `${who.name}${model} last checked in ${ago(who.lastSeen)} ago. What you send waits `
    + 'in the queue and is answered as soon as your PC is on again.';
}

/**
 * The Supabase SQL editor for the project config.js points at. Derived
 * rather than configured, because the project reference is already in the
 * URL and one more setting to keep in sync is one too many.
 */
export function sqlEditorUrl() {
  const ref = String(window.CONFIG?.supabaseUrl ?? '')
    .match(/^https:\/\/([a-z0-9-]+)\.supabase\./i)?.[1];
  return ref ? `https://supabase.com/dashboard/project/${ref}/sql/new` : null;
}

/**
 * What to do about it — as the two steps it actually is, each with the
 * button that does it. Saying "run bridge/schema.sql" to someone holding a
 * phone is a dead end; copying the file and opening the editor is not.
 */
function setupHtml() {
  const editor = sqlEditorUrl();
  const recheck = `<button class="btn tiny ghost" data-ask-recheck>${icon('retry')}check again</button>`;

  if (!state.askReady) {
    return `
      <p class="setup-step"><span class="setup-n">1</span>Add the tables to Supabase</p>
      <div class="info-row"><span class="info-k">Tables</span>
        <span class="info-v"><span class="state" data-status="error"><i class="dot"></i>missing</span></span></div>
      <div class="info-row"><span class="info-k">What to run</span>
        <span class="info-v"><code>bridge/schema.sql</code></span></div>
      <p class="info-note">One paste, once. It adds the four tables this account is
        missing — conversations, messages, the bridge's heartbeat and the agent
        ceiling — each locked to your own account, and changes nothing that is
        already there.${state.askError ? ` The read said: ${esc(state.askError)}` : ''}</p>
      <div class="setup-acts">
        <button class="btn tiny" data-copy-schema>${icon('copy')}copy the SQL</button>
        ${editor ? `<a class="btn tiny ghost" href="${esc(editor)}" target="_blank"
           rel="noopener">${icon('link')}open the SQL editor</a>` : ''}
        ${recheck}
      </div>`;
  }
  return `
    <p class="setup-step"><span class="setup-n">2</span>Start the bridge on your PC</p>
    <div class="info-row"><span class="info-k">Bridge</span>
      <span class="info-v"><span class="state" data-status="paused"><i class="dot"></i>never checked in</span></span></div>
    <div class="info-row"><span class="info-k">What to run</span>
      <span class="info-v"><code>npm run bridge:setup</code></span></div>
    <p class="info-note">That checks the rest for you: it writes <code>bridge/.env</code>,
      asks whatever <code>ASSISTANT_CMD</code> or <code>ASSISTANT_URL</code> points at, and
      tells you what is left. Then <code>npm run bridge</code> leaves it running — it says
      hello every ten seconds, so this screen knows the moment it is awake.</p>
    <div class="setup-acts">
      <button class="btn tiny" data-copy-cmd="npm run bridge:setup">${icon('copy')}copy the command</button>
      ${recheck}
    </div>`;
}

const starterHtml = (st, i) => `
  <button type="button" class="suggest" data-ask-starter="${i}" data-kind="starter">
    <span class="suggest-icon">${icon(st.icon)}</span>
    <span class="suggest-text">
      <span class="suggest-title">${esc(st.text)}</span>
      <span class="suggest-why"><span class="why-text">drops into the box — you still press send</span></span>
    </span>
    <span class="suggest-go">${icon('arrow')}</span>
  </button>`;

/** One reply: what it says, or what it is still waiting for. */
function askReplyHtml(message, { who, queue }) {
  const spot = queue.findIndex((m) => String(m.id) === String(message.id));
  const st = replyState({
    message,
    online: who.online,
    known: who.known,
    ahead: Math.max(0, spot),
    wakes: state.cloud === true,
  });
  const status = REPLY_STATUS[st.kind] ?? 'queued';
  const live = isPending(message);

  const body = message.text ? `<div class="msg-body md">${md(message.text)}</div>` : '';
  const dots = st.live && !message.text
    ? '<p class="ask-dots" role="status" aria-label="typing"><i></i><i></i><i></i></p>' : '';
  const note = st.note
    ? `<p class="note" data-status="${esc(status)}">${esc(st.note)}</p>` : '';
  const failed = st.kind === 'failed' && message.error
    ? `<p class="note bad" data-status="error">${esc(message.error)}</p>` : '';

  const actions = [
    live && !message.cancel_requested
      ? `<button class="btn tiny ghost" data-ask-stop="${esc(message.id)}">${icon('stop')}stop</button>`
      : '',
    !live && message.text
      ? `<button class="btn tiny ghost" data-ask-copy="${esc(message.id)}">${icon('copy')}copy</button>`
      : '',
    !live
      ? `<button class="btn tiny ghost" data-ask-again="${esc(message.id)}">${icon('retry')}ask again</button>`
      : '',
    // The merge, in one button: an answer worth building becomes a job.
    !live && message.text
      ? `<button class="btn tiny ghost" data-ask-build="${esc(message.id)}">${icon('bot')}hand to an agent</button>`
      : '',
  ].filter(Boolean).join('');

  return `
    <div class="msg agent${st.live ? ' live' : ''}" data-status="${esc(status)}"
         data-reply="${esc(message.id)}">
      <div class="msg-head">
        <span class="state" data-status="${esc(status)}">
          <i class="dot${st.live ? ' live' : ''}"></i>${esc(who.known ? who.name : 'assistant')}
        </span>
        <span class="msg-clock">${esc(st.label || when(message.created_at))}</span>
      </div>
      ${note}
      ${body}
      ${dots}
      ${failed}
      <div class="msg-actions">${actions}</div>
    </div>`;
}

export function renderAsk() {
  const who = askPresence();
  const all = askChats();
  const current = currentConversation();
  const msgs = current?.messages ?? [];
  const queue = askPending();

  $('ask-title').textContent = current ? current.title : 'Assistant';
  $('ask-presence-text').textContent = presenceWord(who);
  $('ask-presence').classList.toggle('online', who.online);
  $('ask-presence').classList.toggle('offline', !who.online);

  const asked = msgs.filter((m) => m.role === 'user').length;
  const answered = msgs.filter((m) => m.role === 'assistant' && m.status === 'done').length;
  const stats = [
    asked ? plural(asked, 'message') : '',
    answered ? `${answered} answered` : '',
    queue.length ? `${queue.length} on the way` : '',
    who.model ?? '',
  ].filter(Boolean);
  $('ask-stats').innerHTML = msgs.length
    ? `${stats.map((b) => esc(b)).join(' · ')} · last `
      + `<span data-ago="${esc(msgs.at(-1).created_at)}">${ago(msgs.at(-1).created_at)}</span> ago`
    : '';

  $('ask-who-text').textContent = who.known
    ? `${who.name} · ${who.online ? 'online' : 'offline'}`
    : 'no assistant yet';

  $('ask-clear').hidden = !(current && msgs.length);
  if (current) $('ask-clear').dataset.askDelete = current.id;
  else delete $('ask-clear').dataset.askDelete;

  const needsSetup = !state.askReady || !who.known;
  $('ask-setup').hidden = !needsSetup;
  if (needsSetup) $('ask-setup').innerHTML = setupHtml();

  // Everything else you have said, one tap away but never in the way.
  const others = all.filter((c) => c.id !== current?.id);
  $('ask-history').hidden = !others.length;
  $('ask-history-label').textContent = plural(others.length, 'earlier conversation');
  $('ask-history-list').innerHTML = others.map((c) => {
    const at = new Date(c.at).toISOString();
    return `
    <a class="row" href="${esc(askHref(c.id))}">
      <span class="row-top">
        <span class="row-name">${esc(c.title)}</span>
        ${c.pending ? '<span class="tag" data-status="running"><i class="dot"></i>answering</span>' : ''}
        <span class="row-when" data-ago="${esc(at)}">${ago(at)}</span>
      </span>
      <span class="row-sub">${esc(clip(c.last?.text || 'nothing said yet', 90))}</span>
    </a>`;
  }).join('');

  const waiting = current ? unsentAsks(current.id) : [];
  $('ask-thread').innerHTML = askTurns(msgs).map(({ you, reply }) => `
    <div class="turn">
      ${you ? `<div class="msg you" title="${esc(stamp(you.created_at))}">${esc(you.text)}</div>` : ''}
      ${reply ? askReplyHtml(reply, { who, queue }) : ''}
    </div>`).join('') + waiting.map(unsentTurnHtml).join('');

  const blank = !msgs.length && !waiting.length;
  $('ask-open').hidden = !blank;
  if (blank) {
    $('ask-starters').innerHTML = STARTERS.map(starterHtml).join('');
    $('ask-open-p').textContent = state.cloud
      ? 'Claude answers from the cloud, with your projects, the dashboard and the house to '
        + 'hand — your PC can be off. It remembers what you tell it, and each conversation '
        + 'picks up where it left off.'
      : who.online
      ? `${who.name} is awake on your PC right now — ask it something and the answer `
        + 'comes back here.'
      : 'It answers on your PC and the reply comes back here. Ask anyway if the PC is '
        + 'off: the message is picked up the moment it wakes.';
  }
}

/** Replies in flight: the number on the Ask door and on its tab. */
export function renderAskBadge() {
  const n = askPending().length;
  $('ask-count').textContent = n ? String(n) : '';
  const pip = $('tab-ask-count');
  pip.textContent = n ? String(n) : '';
  pip.hidden = !n;
}

// ── your house ────────────────────────────────────────────────────────
// The third thing this app relays, and the one you will open most often —
// so it is built for the two-second visit: what is on, and the tap that
// turns it off. Everything else is one screen further down.
//
// Two things sit between a tap and a light: the relay on your PC and the
// hub on your Pi. The screen never pretends both are there — a tap while
// the PC is asleep says so, and still queues, because that is the truth.

/** A device's state, drawn in the ramp the rest of the app already uses. */
const deviceStatus = (device, pending) => {
  if (pending) return 'running';
  if (isAway(device)) return 'error';
  return isOn(device) ? 'done' : 'queued';
};

/** The same thing in a sentence — what the toast says. */
export function houseExplainer() {
  if (!state.houseReady) {
    return 'The house tables are not in your Supabase project yet. Run bridge/schema.sql, '
      + 'then put a relay next to your hub — on the hub itself, or on your PC.';
  }
  return houseState().note;
}

/** The two steps, each with the button that does it — as on the Ask screen. */
function houseSetupHtml() {
  const editor = sqlEditorUrl();
  const recheck = `<button class="btn tiny ghost" data-house-recheck>${icon('retry')}check again</button>`;

  if (!state.houseReady) {
    return `
      <p class="setup-step"><span class="setup-n">1</span>Add the tables to Supabase</p>
      <div class="info-row"><span class="info-k">Tables</span>
        <span class="info-v"><span class="state" data-status="error"><i class="dot"></i>missing</span></span></div>
      <div class="info-row"><span class="info-k">What to run</span>
        <span class="info-v"><code>bridge/schema.sql</code></span></div>
      <p class="info-note">The same one paste as the assistant: it adds the three house
        tables — your devices, the relay's heartbeat and the taps you make — each locked
        to your own account.${state.houseError ? ` The read said: ${esc(state.houseError)}` : ''}</p>
      <div class="setup-acts">
        <button class="btn tiny" data-copy-schema>${icon('copy')}copy the SQL</button>
        ${editor ? `<a class="btn tiny ghost" href="${esc(editor)}" target="_blank"
           rel="noopener">${icon('link')}open the SQL editor</a>` : ''}
        ${recheck}
      </div>`;
  }
  return `
    <p class="setup-step"><span class="setup-n">2</span>Put a relay next to your hub</p>
    <div class="info-row"><span class="info-k">Hub</span>
      <span class="info-v"><span class="state" data-status="paused"><i class="dot"></i>never checked in</span></span></div>
    <div class="info-row"><span class="info-k">On the hub</span>
      <span class="info-v"><code>bridge/addon</code> — reachable whenever the hub is</span></div>
    <div class="info-row"><span class="info-k">On your PC</span>
      <span class="info-v"><code>HA_URL</code> · <code>HA_TOKEN</code> in <code>bridge/.env</code></span></div>
    <p class="info-note">Your hub is taken to be Home Assistant on the Pi, and the
      relay can run in either place. <b>On the hub</b> is the one that works while you
      are out: copy <code>bridge/addon</code> into the hub's <code>addons</code> share,
      install it from Settings → Add-ons, and it needs no token at all.
      <b>On your PC</b> is quicker to try — set <code>HA_URL</code> to
      <code>http://homeassistant.local:8123</code> and <code>HA_TOKEN</code> to a
      long-lived access token, then <code>npm run bridge</code> — but the house is
      then reachable only while the PC is awake.</p>
    <div class="setup-acts">
      <button class="btn tiny" data-copy-cmd="node bridge/house.mjs --try">${icon('copy')}copy the check</button>
      ${recheck}
    </div>`;
}

/**
 * Every relay that has ever checked in, and what each one means for whether
 * the house is reachable right now. Worth its own block because the useful
 * answer is rarely one row: a Pi that is always up and a PC that is up
 * sometimes read very differently, and only the list says which you have.
 */
function renderHouseRelays(who) {
  const list = who.relays ?? [];
  $('house-relay-block').hidden = list.length === 0;
  if (!list.length) return;

  $('house-relay-count').textContent = String(list.length);
  $('house-relay-note').textContent = who.online
    ? `${who.online} of ${list.length} up` : 'none up';

  $('house-relays').innerHTML = list.map((r) => {
    const status = r.reachable ? 'done' : r.online ? 'error' : 'paused';
    const word = r.reachable ? (r.mirroring ? 'mirroring' : 'ready')
      : r.online ? 'hub not answering' : 'asleep';
    return `
    <div class="row" data-status="${status}">
      <span class="row-top">
        <span class="row-name">${esc(r.id)}</span>
        <span class="state" data-status="${status}">
          <i class="dot${r.reachable ? ' live' : ''}"></i>${esc(word)}</span>
        <span class="row-when" data-ago="${esc(r.lastSeen ?? '')}">${
          r.lastSeen ? ago(r.lastSeen) : '—'}</span>
      </span>
      <span class="row-sub">${esc(RELAY_HOSTS[r.host]?.note
        ? `${r.where} — ${RELAY_HOSTS[r.host].note}` : r.where)}${
        r.error ? esc(` — ${clip(r.error, 80)}`) : ''}</span>
    </div>`;
  }).join('');

  // The one thing worth saying unprompted, because it is the difference
  // between a house you can reach from the bus and one you cannot.
  const hint = $('house-relay-hint');
  hint.hidden = !who.needsPc;
  if (who.needsPc) {
    hint.innerHTML = 'Every relay you have runs on a PC, so the house is reachable only '
      + 'while that PC is awake — which is usually not the case when you are out. '
      + 'The same relay runs on the hub itself, where nothing extra has to be on: '
      + '<code>npm run addon</code>, copy <code>bridge/addon</code> into the hub&rsquo;s '
      + '<code>addons</code> share, and install it from Settings &rarr; Add-ons.';
  }
}

/** One device: what it is, what it is doing, and the tap that changes it. */
function deviceHtml(device, pending) {
  const kind = kindOf(device);
  const status = deviceStatus(device, pending);
  const acts = isAway(device) ? [] : actionsFor(device);
  // Some cards are their own first action; a thermostat is not — see house.js.
  const primary = acts[0]?.inline ? null : (acts[0] ?? null);
  const rest = primary ? acts.slice(1) : acts;
  const detail = pending
    ? commandLabel({ action: pending.action, value: pending.value })
    : detailLine(device);

  const act = (a) => {
    const value = a.step != null ? nudged(device, a.step) : '';
    return `<button class="dev-act" type="button" title="${esc(a.label)}"
      aria-label="${esc(`${a.label} — ${device.name}`)}"
      data-house-act="${esc(a.action)}" data-entity="${esc(device.entity_id)}"
      ${value === '' ? '' : `data-value="${esc(value)}"`}>${icon(a.icon)}</button>`;
  };

  // The whole card is its first action, so a light is one thumb away.
  const main = primary
    ? `<button class="dev-main" type="button" data-house-act="${esc(primary.action)}"
         data-entity="${esc(device.entity_id)}"${primary.step != null
          ? ` data-value="${esc(nudged(device, primary.step))}"` : ''}
         aria-label="${esc(`${primary.label} — ${device.name}`)}">`
    : '<div class="dev-main">';

  const dim = isDimmable(device) && isOn(device) && !isAway(device)
    ? `<input class="dev-dim" type="range" min="0" max="100" step="5"
         value="${esc(Math.round(Number(device.attrs?.level ?? 100)))}"
         aria-label="${esc(`Brightness — ${device.name}`)}"
         data-house-dim="${esc(device.entity_id)}">`
    : '';

  return `
    <div class="dev" data-status="${esc(status)}" data-kind="${esc(kind)}">
      ${main}
        <span class="dev-ico">${icon(kindIcon(kind))}</span>
        <span class="dev-text">
          <span class="dev-name">${esc(device.name)}</span>
          <span class="dev-sub">${esc(detail || stateWord(device))}</span>
        </span>
        <span class="state" data-status="${esc(status)}">
          <i class="dot${pending ? ' live' : ''}"></i>${esc(pending ? 'sending' : stateWord(device))}
        </span>
      ${primary ? '</button>' : '</div>'}
      ${rest.length ? `<div class="dev-acts">${rest.map(act).join('')}</div>` : ''}
      ${dim}
    </div>`;
}

export function renderHouse() {
  const who = housePresence();
  const st = houseState();
  const devices = houseDevices();
  const s = houseSummaryNow();
  const pending = housePending();

  const needsSetup = !state.houseReady || !who.known;
  $('house-setup').hidden = !needsSetup;
  if (needsSetup) $('house-setup').innerHTML = houseSetupHtml();

  // The hero answers the question people actually open this for.
  $('house-value').textContent = String(s.on);
  $('house-label').textContent = s.on === 1 ? 'thing on' : 'things on';
  $('house-hero').hidden = needsSetup && !devices.length;

  const tone = st.kind === 'ok' ? 'done' : st.kind === 'hub-off' ? 'error' : 'paused';
  const chips = [`<span class="stat-chip" data-status="${tone}"><i class="dot${
    st.kind === 'ok' ? ' live' : ''}"></i>${esc(who.known ? `${who.name} · ${st.label}` : st.label)}</span>`];
  // Where it is relayed from is the difference between "works when I am out"
  // and "works when the desktop happens to be awake", so it goes up here.
  if (st.kind === 'ok') {
    chips.push(`<span class="stat-chip" data-status="${who.onHub ? 'done' : 'paused'}">${
      icon(who.onHub ? 'house' : 'server')}${esc(who.relays[0]?.where ?? 'relayed')}</span>`);
  }
  if (s.temperature != null) {
    chips.push(`<span class="stat-chip">${icon('thermometer')}${esc(s.temperature)}°</span>`);
  }
  if (s.lights) {
    chips.push(`<span class="stat-chip" data-status="${s.lit ? 'done' : 'queued'}"><i class="dot"></i>
      <b>${s.lit}</b> of <b>${s.lights}</b> lights</span>`);
  }
  if (s.open) chips.push(`<span class="stat-chip" data-status="paused"><i class="dot"></i><b>${s.open}</b> open</span>`);
  if (s.unlocked) chips.push(`<span class="stat-chip" data-status="error"><i class="dot"></i><b>${s.unlocked}</b> unlocked</span>`);
  if (s.away) chips.push(`<span class="stat-chip" data-status="error"><i class="dot"></i><b>${s.away}</b> not answering</span>`);
  $('house-chips').innerHTML = chips.join('');

  const busy = houseBusy();
  $('house-now').hidden = !busy.length;
  if (busy.length) {
    $('house-now').innerHTML = `${icon('pulse')}<span>${esc(commandLabel(busy[0]))}${
      busy.length > 1 ? ` · ${busy.length - 1} more` : ''}</span>`;
  }

  // One tap: the lights you left on, and whatever scenes the hub knows.
  const lit = litLights(devices);
  const scenes = devices.filter((d) => kindOf(d) === 'scene').slice(0, 6);
  const quick = [];
  if (lit.length) {
    quick.push(`<button type="button" class="chip" data-house-all="lights-off">${icon('bulb')}<span>turn ${
      plural(lit.length, 'light')} off</span></button>`);
  }
  for (const sc of scenes) {
    quick.push(`<button type="button" class="chip" data-house-act="run"
      data-entity="${esc(sc.entity_id)}">${icon('wand')}<span>${esc(clip(sc.name, 24))}</span></button>`);
  }
  $('house-quick-block').hidden = !quick.length;
  $('house-quick').innerHTML = quick.join('');
  $('house-quick-note').textContent = lit.length ? `${lit.length} on` : 'scenes';

  // Room by room, the ones with something on first.
  $('house-empty').hidden = Boolean(devices.length) || needsSetup;
  $('house-rooms').innerHTML = houseRoomList().map((room) => `
    <section class="block room">
      <h2 class="block-h">
        <span>${esc(room.area)}</span>
        <span class="count">${room.devices.length}</span>
        <span class="block-note">${esc(room.on ? `${room.on} on` : 'all off')}${
          room.away ? esc(` · ${room.away} away`) : ''}</span>
      </h2>
      <div class="dev-grid">
        ${room.devices.map((d) => deviceHtml(d, pending.get(d.entity_id))).join('')}
      </div>
    </section>`).join('');

  renderHouseRelays(who);

  // What just happened, including anything your assistant did.
  const log = houseRecent(8);
  $('house-log-block').hidden = !log.length;
  $('house-log-note').textContent = log.some((c) => c.source === 'assistant')
    ? 'you and your assistant' : '';
  $('house-log').innerHTML = log.map((c) => {
    const status = c.status === 'error' ? 'error' : c.status === 'done' ? 'done' : 'running';
    return `
    <div class="row" data-status="${esc(status)}">
      <span class="row-top">
        <span class="row-name">${esc(commandLabel(c))}</span>
        <span class="state" data-status="${esc(status)}">
          <i class="dot${isQueued(c) ? ' live' : ''}"></i>${esc(c.status)}</span>
        <span class="row-when" data-ago="${esc(c.created_at)}">${ago(c.created_at)}</span>
      </span>
      <span class="row-sub">${esc(c.source === 'assistant' ? `${askPresence().name} did this`
        : 'from this dashboard')}${c.error ? esc(` — ${clip(c.error, 90)}`) : ''}</span>
    </div>`;
  }).join('');
}

/** Taps in flight: the number on the House door and on its tab. */
export function renderHouseBadge() {
  const n = houseBusy().length;
  $('house-count').textContent = n ? String(n) : '';
  const pip = $('tab-house-count');
  pip.textContent = n ? String(n) : '';
  pip.hidden = !n;
}

// ── the outbox ────────────────────────────────────────────────────────
// What this phone still has to send. It is shown where you sent it — at the
// end of the thread, on the site — and all together on its own screen, so
// "did that go?" always has an answer you can see.

const isoOf = (ms) => new Date(ms).toISOString();

/** Where something still on this phone is, in a sentence. */
function unsentLine(e) {
  if (e.state === 'failed') return e.lastError ?? 'Supabase refused it.';
  if (e.after && state.outbox.some((x) => x.id === e.after)) {
    return 'Waits for its site to reach Supabase first.';
  }
  if (!state.sync.online) return 'Kept on this phone — it sends itself when there is signal.';
  if (e.lastError) {
    const next = until(isoOf(e.nextAttemptAt));
    return `Not sent yet: ${e.lastError}. Trying again ${next === 'any moment' ? 'any moment' : `in ${next}`}.`;
  }
  return 'Sending…';
}

const KIND = {
  job: (e) => ({ glyph: 'bot', what: e.payload.slug ? `Job for ${e.payload.slug}` : 'New project' }),
  ask: () => ({ glyph: 'brain', what: `Message to ${askPresence().known ? askPresence().name : 'your assistant'}` }),
  report: (e) => ({
    glyph: 'clipboard',
    what: `${STATUS_WORD[e.payload.status] ?? 'Report'} · ${e.payload.siteName || 'a site'}`,
  }),
  site: (e) => ({ glyph: 'clipboard', what: `New site · ${e.payload.name}` }),
};
const kindOfEntry = (e) => (KIND[e.kind] ?? (() => ({ glyph: 'outbox', what: e.kind })))(e);

/** Where tapping an entry takes you: the place you sent it from. */
const entryHref = (e) => (e.kind === 'job'
  ? (e.payload.slug ? projectHref(e.payload.slug) : `#/j/${encodeURIComponent(e.id)}`)
  : e.kind === 'ask' ? askHref(e.payload.chatId)
    : e.kind === 'report' ? siteHref(e.payload.siteId)
      : e.kind === 'site' ? siteHref(e.id) : '#/outbox');

const entryText = (e) => e.payload?.prompt ?? e.payload?.text ?? e.payload?.note ?? e.title ?? '';

const unsentActions = (e) => `
  <button class="btn tiny ghost" data-outbox-retry="${esc(e.id)}">${icon('retry')}send now</button>
  <button class="btn tiny ghost" data-outbox-discard="${esc(e.id)}">${icon('trash')}discard</button>`;

/** The reply side of something not sent yet: what became of it, and what you can do. */
function unsentHtml(e) {
  const failed = e.state === 'failed';
  const status = failed ? 'error' : 'queued';
  const at = isoOf(e.createdAt);
  return `
    <div class="msg agent" data-status="${status}" data-unsent="${esc(e.id)}">
      <div class="msg-head">
        <span class="state" data-status="${status}"><i class="dot"></i>${failed ? 'refused' : 'not sent yet'}</span>
        <span class="msg-clock">written <span data-since="${esc(at)}">${since(at)}</span></span>
      </div>
      <p class="note${failed ? ' bad' : ''}" data-status="${status}">${esc(unsentLine(e))}</p>
      <div class="msg-actions">${unsentActions(e)}</div>
    </div>`;
}

function unsentTurnHtml(e) {
  return `
    <div class="turn" data-unsent-turn="${esc(e.id)}">
      <div class="msg you" title="${esc(stamp(isoOf(e.createdAt)))}">${esc(entryText(e))}</div>
      ${unsentHtml(e)}
    </div>`;
}

function outboxRow(e) {
  const k = kindOfEntry(e);
  const failed = e.state === 'failed';
  const status = failed ? 'error' : 'queued';
  const at = isoOf(e.createdAt);
  return `
    <div class="row outbox-row" data-status="${status}" data-entry="${esc(e.id)}">
      <span class="row-top">
        <a class="row-name" href="${esc(entryHref(e))}">${esc(k.what)}</a>
        <span class="state" data-status="${status}"><i class="dot"></i>${failed ? 'refused' : 'waiting'}</span>
        <span class="row-when" data-ago="${esc(at)}" title="${esc(stamp(at))}">${ago(at)}</span>
      </span>
      ${entryText(e) ? `<span class="row-sub">${esc(clip(entryText(e), 160))}</span>` : ''}
      <span class="row-meta${failed ? ' bad' : ''}">${esc(unsentLine(e))}${
        e.attempts ? ` · ${plural(e.attempts, 'try', 'tries')}` : ''}</span>
      <span class="row-acts">${unsentActions(e)}</span>
    </div>`;
}

export function renderOutbox() {
  const list = state.outbox;
  const failed = list.filter((e) => e.state === 'failed').length;
  const where = state.sync.online
    ? 'Each goes as soon as Supabase answers.'
    : 'No signal — each sends itself when you are back in range.';
  const fragile = keepsAcrossReloads() ? ''
    : ' This browser is not keeping them across a reload (a private window?), so leave the app open until they go.';
  $('outbox-intro').textContent = list.length
    ? `${plural(list.length, 'thing')} on this phone${failed ? `, ${failed} refused` : ''}. ${where}${fragile}`
    : '';
  $('outbox-list').innerHTML = list.map(outboxRow).join('');
  $('outbox-empty').hidden = list.length > 0;
  $('outbox-empty-p').textContent = state.sync.savedAt
    ? `Everything sent from this phone has reached Supabase. Last read live ${since(isoOf(state.sync.savedAt))}.`
    : 'Everything sent from this phone has reached Supabase.';
  $('outbox-send').hidden = !list.length;
  $('outbox-send').disabled = state.sync.sending;
}

/**
 * The always-there part: the pill in the topbar while anything is waiting,
 * the sidebar door's count, and the bar that says you are offline — and,
 * since it can now, how old what you are looking at is.
 */
export function renderSync() {
  const list = state.outbox;
  const failed = list.filter((e) => e.state === 'failed').length;
  $('outbox-side-count').textContent = list.length ? String(list.length) : '';

  const pill = $('outbox-pill');
  pill.hidden = !list.length;
  pill.classList.toggle('warn', failed > 0);
  const word = failed ? `${failed} refused` : state.sync.sending ? 'sending…' : `${list.length} to send`;
  // On a phone the topbar has room for the number, not the sentence.
  $('outbox-pill-text').innerHTML = failed
    ? `<b>${failed}</b><span class="pill-sub"> refused</span>`
    : `<b>${list.length}</b><span class="pill-sub"> ${state.sync.sending ? 'sending' : 'to send'}</span>`;
  pill.setAttribute('aria-label', `Outbox: ${word}`);
  pill.title = failed ? 'Supabase refused something — open the outbox'
    : `${plural(list.length, 'thing')} kept on this phone until Supabase has it`;

  setOffline(!state.sync.online);
  const at = state.sync.savedAt ? isoOf(state.sync.savedAt) : null;
  $('offline-text').innerHTML = [
    'Offline',
    at ? `last read <span data-since="${esc(at)}">${since(at)}</span>` : 'nothing saved here yet',
    list.length ? `${list.length} waiting to send` : '',
  ].filter(Boolean).join(' · ');
}

// ── field reports ─────────────────────────────────────────────────────
// Field Reports, moved in. Built for the place with no signal: the list and
// every site read from this phone, and filing a report never waits for the
// network. A finding is a dot plus a word in the ramp the app already uses.

let fieldFilter = 'all';
export const setFieldFilter = (key) => { fieldFilter = key; };

const findingTag = (status) => `
  <span class="state" data-status="${esc(STATUS_TONE[status] ?? 'queued')}">
    <i class="dot"></i>${esc(STATUS_WORD[status] ?? status)}</span>`;

const unsentTag = (e, word = 'not sent') => `
  <span class="tag" data-status="${e.state === 'failed' ? 'error' : 'queued'}"><i class="dot"></i>${
    e.state === 'failed' ? 'refused' : esc(word)}</span>`;

function fieldSetupHtml() {
  const editor = sqlEditorUrl();
  return `
    <p class="setup-step"><span class="setup-n">1</span>Add the tables to Supabase</p>
    <div class="info-row"><span class="info-k">Tables</span>
      <span class="info-v"><span class="state" data-status="error"><i class="dot"></i>missing</span></span></div>
    <div class="info-row"><span class="info-k">What to run</span>
      <span class="info-v"><code>bridge/schema.sql</code></span></div>
    <p class="info-note">The same one paste as the assistant and the house, and safe to run
      again: it adds your sites and their reports, each locked to your own account, and
      the rule that gives a site the status of its newest report.${
        state.fieldError ? ` The read said: ${esc(state.fieldError)}` : ''}</p>
    <div class="setup-acts">
      <button class="btn tiny" data-copy-schema>${icon('copy')}copy the SQL</button>
      ${editor ? `<a class="btn tiny ghost" href="${esc(editor)}" target="_blank"
         rel="noopener">${icon('link')}open the SQL editor</a>` : ''}
      <button class="btn tiny ghost" data-field-recheck>${icon('retry')}check again</button>
    </div>`;
}

function siteRow(site) {
  const at = site.lastAt ? isoOf(site.lastAt) : null;
  const facts = [site.asset_tag, site.region].filter(Boolean).map(esc).join(' · ');
  return `
    <a class="row site-row" data-status="${esc(STATUS_TONE[site.status] ?? 'queued')}"
       href="${esc(siteHref(site.id))}">
      <span class="row-top">
        <span class="tag">P${site.priority}</span>
        <span class="row-name">${esc(site.name)}</span>
        ${findingTag(site.status)}
      </span>
      ${site.address ? `<span class="row-sub">${esc(site.address)}</span>` : ''}
      <span class="row-meta">
        ${facts ? `<span>${facts}</span>` : ''}
        <span>${at ? `last report <span data-since="${esc(at)}">${since(at)}</span>` : 'never reported'}</span>
        ${site.queued.length ? unsentTag(site.queued.at(-1), `${site.queued.length} not sent`) : ''}
        ${site.unsent ? unsentTag(site.unsent, 'site not sent') : ''}
      </span>
    </a>`;
}

export function renderField() {
  const list = fieldSiteList();
  const n = fieldTallyNow();
  // Missing tables are only claimed once a read has said so: no signal, or
  // not asked yet, is not the same thing.
  const missing = !state.fieldReady && Boolean(state.fieldError) && !list.length;
  const unread = !state.fieldReady && !state.fieldError && !list.length;

  $('field-setup').hidden = !missing;
  if (missing) $('field-setup').innerHTML = fieldSetupHtml();

  $('field-hero').hidden = !list.length;
  $('field-value').textContent = String(n.attention);
  $('field-label').textContent = n.attention === 1 ? 'site needs attention' : 'sites need attention';
  const chips = [
    ['blocked', 'error'], ['needs_work', 'paused'], ['unvisited', 'queued'], ['ok', 'done'],
  ].filter(([key]) => n[key]).map(([key, tone]) => `
    <span class="stat-chip" data-status="${tone}"><i class="dot"></i><b>${n[key]}</b> ${
      esc(STATUS_WORD[key].toLowerCase())}</span>`);
  if (n.queued) {
    chips.push(`<span class="stat-chip">${icon('outbox')}<b>${n.queued}</b> not sent</span>`);
  }
  $('field-chips').innerHTML = chips.join('');

  // A filter whose last site just moved out of it is dropped, not obeyed.
  if (fieldFilter !== 'all' && !n[fieldFilter]) fieldFilter = 'all';
  $('field-filters').hidden = !list.length;
  $('field-filters').innerHTML = FIELD_FILTERS.map(([key, label]) => `
    <button type="button" class="filter-chip${fieldFilter === key ? ' on' : ''}"
            data-field-filter="${key}" aria-pressed="${fieldFilter === key}">
      ${esc(label)}${key === 'all' ? '' : `<span class="count">${n[key] ?? 0}</span>`}
    </button>`).join('');

  const shown = filtered(list, fieldFilter);
  $('field-list').innerHTML = shown.map(siteRow).join('');
  $('field-none').hidden = !list.length || shown.length > 0;

  $('field-empty').hidden = missing || list.length > 0;
  $('field-empty-h').textContent = unread ? 'Nothing saved here yet' : 'No sites yet';
  $('field-empty-p').textContent = unread
    ? (state.sync.online ? 'Reading your sites…'
      : 'This phone has not read your sites yet. Open this once with a signal and they are kept here from then on — you can still add a site now.')
    : 'Add the places you visit: each keeps its address, who to call and how to get in, and a report filed there works with no signal at all.';
  $('field-demo').hidden = !state.fieldReady;
  $('field-foot').hidden = !list.length;
}

function reportRow(r) {
  return `
    <div class="row report-row" data-status="${esc(STATUS_TONE[r.status] ?? 'queued')}">
      <span class="row-top">
        ${findingTag(r.status)}
        <span class="grow"></span>
        <span class="row-when" title="${esc(stamp(r.recorded_at))}" data-ago="${esc(r.recorded_at)}">${ago(r.recorded_at)}</span>
      </span>
      ${r.note ? `<p class="report-note">${esc(r.note)}</p>` : ''}
      <span class="row-meta"><span>${esc(r.author || 'Field tech')} · ${esc(when(r.recorded_at))}</span></span>
    </div>`;
}

function queuedReportRow(e) {
  const p = e.payload;
  const failed = e.state === 'failed';
  return `
    <div class="row report-row" data-status="${failed ? 'error' : 'queued'}" data-unsent="${esc(e.id)}">
      <span class="row-top">
        ${findingTag(p.status)}
        ${unsentTag(e)}
        <span class="grow"></span>
        <span class="row-when" data-since="${esc(p.recordedAt)}">${since(p.recordedAt)}</span>
      </span>
      ${p.note ? `<p class="report-note">${esc(p.note)}</p>` : ''}
      <span class="row-meta${failed ? ' bad' : ''}">${esc(unsentLine(e))}</span>
      <span class="row-acts">${unsentActions(e)}</span>
    </div>`;
}

export function renderSite() {
  const site = fieldSiteOf(route.siteId);
  $('site-missing').hidden = Boolean(site);
  for (const id of ['site-head', 'site-info', 'site-reports-block', 'site-actions']) $(id).hidden = !site;
  if (!site) {
    $('site-missing-p').textContent = state.sync.online && !state.fieldReady && !state.fieldError
      ? 'Reading it now…'
      : 'This site is not saved on this phone: it was never opened here with a signal, or it has been removed.';
    return;
  }

  const shownChanged = site.status !== site.saved && site.queued.length;
  $('site-head').innerHTML = `
    <div class="chat-title">
      <h2>${esc(site.name)}</h2>
      <span class="meta">
        ${findingTag(site.status)}
        ${shownChanged ? unsentTag(site.queued.at(-1)) : ''}
        ${site.unsent ? unsentTag(site.unsent, 'site not sent') : ''}
        <span class="tag">P${site.priority}</span>
      </span>
    </div>
    <span class="chat-stats">${esc([site.asset_tag, site.region].filter(Boolean).join(' · '))}</span>`;

  const phone = dialable(site.contact_phone);
  const rows = [
    ['Address', site.address || '—'],
    ['Contact', [site.contact_name, site.contact_phone].filter(Boolean).join(' · ') || '—'],
  ];
  const last = site.lastAt
    ? `<span data-since="${esc(isoOf(site.lastAt))}">${since(isoOf(site.lastAt))}</span>` : 'never';
  // Calling is the thing you do from here with gloves on, so it is a button,
  // not a phone number you have to hit exactly.
  const call = phone ? `
    <div class="setup-acts">
      <a class="btn tiny" href="tel:${esc(phone)}">${icon('phone')}call ${
        esc(site.contact_name ? site.contact_name.split(' ')[0] : site.contact_phone)}</a>
    </div>` : '';
  $('site-info').innerHTML = rows.map(([k, v]) => `
    <div class="info-row"><span class="info-k">${esc(k)}</span><span class="info-v">${esc(v)}</span></div>`).join('')
    + `<div class="info-row"><span class="info-k">Last report</span><span class="info-v">${last}</span></div>`
    + (site.access_notes ? `<p class="note site-access"><b>Getting in.</b> ${esc(site.access_notes)}</p>` : '')
    + call
    + (site.unsent ? `<p class="note${site.unsent.state === 'failed' ? ' bad' : ''}" data-status="${
      site.unsent.state === 'failed' ? 'error' : 'queued'}">${esc(unsentLine(site.unsent))}</p>` : '');

  const { queued, saved } = fieldTimelineOf(site.id);
  const total = queued.length + saved.length;
  $('site-count').textContent = total ? String(total) : '';
  $('site-note').textContent = queued.length ? `${queued.length} not sent`
    : state.sync.fromSaved || !state.sync.online ? 'saved on this phone' : '';
  $('site-reports').innerHTML = queued.map(queuedReportRow).join('')
    + saved.map(reportRow).join('')
    + (total ? '' : '<p class="empty-note">No reports filed yet.</p>');
  $('site-file').dataset.site = site.id;
}

/** Reports still to send: the number on the Field door in the menu. */
export function renderFieldBadge() {
  const n = state.outbox.filter((e) => e.kind === 'report' || e.kind === 'site').length;
  $('field-count').textContent = n ? String(n) : '';
}

// ── project chat ──────────────────────────────────────────────────────

const logLine = (e) => `<span class="l-${esc(e.kind)}">${esc(e.text)}</span>\n`;

/** The agent's side of one turn: status, summary or live activity, log. */
function replyHtml(job) {
  const log = eventsOf(job.id);
  const result = resultOf(job.id);
  const act = lastActivity(job.id);
  const live = isActive(job);

  const queuedFor = job.status === 'queued'
    ? fleetNow().waiting.find((w) => w.job.id === job.id) : null;

  const trailer = job.status === 'running'
    ? `<span class="msg-clock" data-elapsed="${esc(job.claimed_at ?? job.created_at)}">${
        elapsed(job.claimed_at ?? job.created_at)}</span>`
    : job.status === 'paused' && job.resume_at
      ? `<span class="msg-clock">resumes ${esc(dayClock(job.resume_at))}</span>`
      : queuedFor
        ? `<span class="msg-clock">${esc(waitLabel(queuedFor))}</span>`
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
      ${job.error && signedOut(job.error) ? `
        <p class="note bad" data-status="error" data-signed-out><strong>Desktop signed out.</strong>
          ${esc(SIGNED_OUT_FIX)}</p>
        <p class="muted small">${esc(job.error)}</p>` : ''}
      ${job.error && !signedOut(job.error)
        ? `<p class="note bad" data-status="error">${esc(job.error)}</p>` : ''}
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

  const waiting = unsentJobs(slug).map(unsentTurnHtml).join('');

  $('thread').innerHTML = notice + (mine.length || waiting ? turns + waiting : `
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
  const unsent = job ? null : outboxEntry(route.jobId);
  if (unsent) {
    $('thread').innerHTML = `${unsentTurnHtml(unsent)}
      <p class="empty-note center">It goes the moment this phone has a signal, then
        ${state.cloud ? 'the cloud runner' : 'your desktop'} names the project and this turns into its chat.</p>`;
    return;
  }
  $('thread').innerHTML = job ? `
    <div class="turn">
      <div class="msg you">${esc(job.prompt)}</div>
      ${replyHtml(job)}
    </div>
    <p class="empty-note center">${state.cloud ? 'The cloud runner' : 'Your desktop'} names the
      project as soon as it picks this up, then this turns into its chat.</p>`
    : `
    <div class="empty">
      ${icon('spark', 'empty-art')}
      <h3>Starting…</h3>
      <p>${state.cloud ? 'Starting in the cloud.' : 'Waiting for your desktop to pick this up.'}</p>
    </div>`;
}
