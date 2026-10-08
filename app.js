// Entry point: boot, auth, view switching, the composer, and the handful of
// listeners that tie the store to the views.

import { $, firstLine } from './util.js';
import * as store from './store.js';
import * as views from './views.js';
import {
  initTheme, initNotify, notify, startTicker, toast, ask, copy,
  openDrawer, closeDrawer, drawerOpen, trapFocus, isNarrow, setOffline,
} from './ui.js';
import { route, initRouter, syncRoute, go, projectHref } from './router.js';

if (!store.configured) {
  document.body.innerHTML =
    '<div style="padding:2rem;font:15px system-ui;max-width:34rem;margin:auto">' +
    '<h1 style="font-size:1.1rem">Almost there</h1>' +
    '<p>Copy <code>config.example.js</code> to <code>config.js</code> and fill in ' +
    'your Supabase URL and anon key.</p></div>';
  throw new Error('missing config');
}

const PREFS = 'cr-compose';

// ── composer settings ─────────────────────────────────────────────────

const radio = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
function setRadio(name, value) {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}

const settings = () => ({
  effort: radio('effort') ?? 'high',
  cap: radio('cap') ?? '90',
  visibility: radio('vis') ?? 'private',
});

function rememberSettings() {
  try { localStorage.setItem(PREFS, JSON.stringify(settings())); } catch { /* blocked */ }
}

function restoreSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS) ?? '{}');
    if (saved.effort) setRadio('effort', saved.effort);
    if (saved.cap) setRadio('cap', saved.cap);
    if (saved.visibility) setRadio('vis', saved.visibility);
  } catch { /* blocked or malformed */ }
}

function updateSummary() {
  const { effort, cap, visibility } = settings();
  const bits = [effort, cap === '100' ? 'no cap' : `cap ${cap}%`];
  if (route.view !== 'project') bits.push(visibility === 'none' ? 'local only' : `${visibility} repo`);
  $('opts-summary').textContent = bits.join(' · ');
}

// ── rendering ─────────────────────────────────────────────────────────

let pendingFrame = null;
function scheduleRender() {
  if (pendingFrame) return;
  pendingFrame = requestAnimationFrame(() => { pendingFrame = null; render(); });
}

/**
 * One bad row should cost you that render, not the whole app: without this a
 * thrown error leaves the UI frozen on stale markup with no clue why.
 */
function render() {
  try {
    draw();
  } catch (err) {
    console.error(err);
    toast('Something failed to draw — reopen to retry', { bad: true, ms: 4000 });
  }
}

function draw() {
  const v = route.view;

  // The pending view borrows the chat column so the message you just sent
  // stays on screen while the host names the project.
  $('home-view').hidden = v !== 'home';
  $('chat-view').hidden = !(v === 'project' || v === 'pending');
  $('new-view').hidden = v !== 'new';
  $('composer').hidden = v === 'home';
  $('visibility-wrap').hidden = v === 'project';

  views.renderTopbar();
  views.renderSidebar();
  views.renderUsage();
  // Only two views show them, and they read the whole account to work it out.
  if (v === 'home' || v === 'new') views.renderSuggestions();

  if (v === 'home') views.renderHome();
  if (v === 'project') views.renderChat();
  if (v === 'pending') {
    const job = store.state.jobs.get(route.jobId);
    if (job?.project_slug) { go(`#/p/${encodeURIComponent(job.project_slug)}`); return; }
    views.renderPending(job);
  }

  $('prompt').placeholder = v === 'project'
    ? `Message ${route.slug}…`
    : v === 'pending' ? 'Waiting for your desktop…'
    : 'Describe what to build…';
  $('send').disabled = v === 'pending';

  updateSummary();
  updateHint();
  if (stick && inThread()) scrollToEnd('auto');
  updateJump();
}

// ── scrolling ─────────────────────────────────────────────────────────

let stick = true;
const inThread = () => route.view === 'project' || route.view === 'pending';
const scroller = () => $('scroller');
const nearBottom = () => {
  const el = scroller();
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
};

function scrollToEnd(behavior = 'smooth') {
  const el = scroller();
  el.scrollTo({ top: el.scrollHeight, behavior });
}

function updateJump() {
  $('jump').hidden = !(inThread() && !nearBottom());
}

scroller().addEventListener('scroll', () => {
  stick = nearBottom();
  updateJump();
}, { passive: true });

$('jump').addEventListener('click', () => { stick = true; scrollToEnd(); updateJump(); });

// ── routing ───────────────────────────────────────────────────────────

function onRoute() {
  closeDrawer();
  stick = route.view !== 'home';
  scroller().scrollTop = 0;
  if (route.view === 'project') store.loadThreadEvents(route.slug);
  render();
  if (route.view === 'project' || route.view === 'pending') scrollToEnd('auto');
}

// ── wiring ────────────────────────────────────────────────────────────

$('menu-open').addEventListener('click', () => (drawerOpen() ? closeDrawer() : openDrawer()));
$('menu-close').addEventListener('click', closeDrawer);
$('scrim').addEventListener('click', closeDrawer);
$('new-project').addEventListener('click', () => { go('#/new'); closeDrawer(); focusPrompt(); });
$('home-new').addEventListener('click', () => { go('#/new'); focusPrompt(); });

$('project-search').addEventListener('input', (e) => {
  views.setFilter(e.target.value);
  views.renderSidebar();
});

$('host-badge').addEventListener('click', () => toast(views.hostExplainer(), { glyph: 'auto', ms: 4000 }));
$('usage-pill').addEventListener('click', () => toast(views.usageSentence(), { glyph: 'gauge', ms: 5000 }));

$('sign-out').addEventListener('click', async () => {
  closeDrawer();
  await store.sb.auth.signOut();
});

// composer options
$('opts-toggle').addEventListener('click', () => {
  const open = $('opts').hidden;
  $('opts').hidden = !open;
  $('opts-toggle').setAttribute('aria-expanded', String(open));
});
$('opts').addEventListener('change', () => { rememberSettings(); updateSummary(); });

// textarea
const prompt = $('prompt');
function autoGrow() {
  prompt.style.height = 'auto';
  prompt.style.height = `${Math.min(prompt.scrollHeight, 176)}px`;
}
prompt.addEventListener('input', autoGrow);

function focusPrompt() {
  if (isNarrow()) return;           // don't yank the mobile keyboard open
  requestAnimationFrame(() => prompt.focus());
}

function fillPrompt(text) {
  prompt.value = text;
  autoGrow();
  prompt.focus();
  prompt.setSelectionRange(text.length, text.length);
}

// Enter sends on a real keyboard; Shift+Enter is a newline. On phones Enter
// always makes a newline — the send button is right there.
prompt.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const send = (e.metaKey || e.ctrlKey) || (!e.shiftKey && !isNarrow());
  if (!send) return;
  e.preventDefault();
  $('composer').requestSubmit();
});
/** Enter only sends where there is a real keyboard — say so, or say nothing. */
function updateHint() {
  $('send-hint').textContent = isNarrow() ? '' : 'Enter to send';
}

window.addEventListener('resize', () => { updateHint(); updateJump(); });

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = prompt.value.trim();
  if (!text || route.view === 'pending') return;

  const note = $('composer-note');
  const btn = $('send');
  btn.disabled = true;
  note.hidden = true;

  const inProject = route.view === 'project';
  const { effort, cap, visibility } = settings();
  const { data, error } = await store.createJob({
    prompt: text,
    slug: inProject ? route.slug : null,
    visibility,
    effort,
    cap,
  });

  if (error) {
    note.textContent = error.message;
    note.hidden = false;
    toast('Could not queue that job', { bad: true });
    btn.disabled = false;
    return;
  }

  prompt.value = '';
  autoGrow();
  $('opts').hidden = true;
  $('opts-toggle').setAttribute('aria-expanded', 'false');
  btn.disabled = false;
  stick = true;
  rememberSettings();

  toast(store.state.hostFresh ? 'Queued — your desktop has it' : 'Queued — waiting for your desktop');
  if (!inProject && data?.id) go(`#/j/${data.id}`);
  else { scheduleRender(); scrollToEnd(); }
});

// delegated row actions
document.addEventListener('click', async (e) => {
  const btn = e.target.closest?.('[data-cancel],[data-retry],[data-copy-log],[data-copy-summary],[data-delete-chat],[data-suggest]');
  if (!btn) return;
  const d = btn.dataset;

  // A suggestion is only ever a head start: it lands in the composer, aimed at
  // the project it was derived from, and you still press send.
  if (d.suggest) {
    const s = views.suggestionById(d.suggest);
    if (!s) return;
    go(s.slug ? projectHref(s.slug) : '#/new');
    fillPrompt(s.prompt);
    toast(s.slug ? `Ready for ${s.slug} — edit or send` : 'Dropped into the composer');
    return;
  }

  if (d.cancel) {
    btn.disabled = true;
    const { error } = await store.cancelJob(d.cancel);
    if (error) { toast(error.message, { bad: true }); btn.disabled = false; }
    else toast('Stopping…', { glyph: 'stop' });
    return;
  }

  if (d.retry) {
    const job = store.state.jobs.get(d.retry);
    if (!job) return;
    if (job.project_slug) go(`#/p/${encodeURIComponent(job.project_slug)}`);
    setRadio('effort', job.effort ?? 'high');
    setRadio('cap', String(job.usage_cap_pct ?? 90));
    updateSummary();
    fillPrompt(job.prompt);
    toast('Loaded into the composer — edit and send');
    return;
  }

  if (d.copyLog) {
    const text = store.eventsOf(d.copyLog).map((ev) => ev.text).join('\n');
    copy(text, 'Log copied');
    return;
  }

  if (d.copySummary) {
    copy(store.resultOf(d.copySummary)?.text ?? '', 'Summary copied');
    return;
  }

  if (d.deleteChat) {
    const ok = await ask({
      title: `Clear the chat for “${d.deleteChat}”?`,
      body: 'This removes the messages and logs from the dashboard.\n'
          + 'It does NOT delete the GitHub repo or the folder on your PC.',
      confirm: 'Clear chat',
      danger: true,
    });
    if (!ok) return;
    btn.disabled = true;
    const { error } = await store.deleteChat(d.deleteChat);
    if (error) { toast(error.message, { bad: true }); btn.disabled = false; return; }
    toast('Chat cleared');
    go('#/');
  }
});

// keyboard
document.addEventListener('keydown', (e) => {
  if ($('app').hidden) return;        // nothing to drive from the sign-in screen
  trapFocus(e);

  if (e.key === 'Escape') {
    if (drawerOpen()) { closeDrawer(); return; }
    if (!$('opts').hidden) {
      $('opts').hidden = true;
      $('opts-toggle').setAttribute('aria-expanded', 'false');
      return;
    }
    if (document.activeElement === prompt) prompt.blur();
    return;
  }

  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '');
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === '/' && !$('composer').hidden) { e.preventDefault(); prompt.focus(); }
  if (e.key === 'n') { e.preventDefault(); go('#/new'); focusPrompt(); }
});

// password reveal
$('pw-toggle').addEventListener('click', () => {
  const field = $('password');
  const show = field.type === 'password';
  field.type = show ? 'text' : 'password';
  $('pw-toggle').setAttribute('aria-pressed', String(show));
  $('pw-toggle').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  field.focus();
});

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('auth-error');
  const btn = $('auth-submit');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  const { error } = await store.sb.auth.signInWithPassword({
    email: $('email').value.trim(),
    password: $('password').value,
  });

  if (error) { err.textContent = error.message; err.hidden = false; }
  btn.disabled = false;
  btn.textContent = 'Sign in';
});

// ── store → views ─────────────────────────────────────────────────────

store.on('change', scheduleRender);
store.on('event', (ev) => views.appendLive(ev, scheduleRender));
store.on('finish', (job) => {
  const name = job.project_slug ?? firstLine(job.prompt);
  if (job.status === 'done') {
    toast(`${name} finished`, { glyph: 'check' });
    notify(`${name} finished`, firstLine(job.prompt));
  } else if (job.status === 'error') {
    toast(`${name} failed`, { bad: true });
    notify(`${name} failed`, job.error ?? firstLine(job.prompt));
  }
});

// ── boot ──────────────────────────────────────────────────────────────

let hostTimer = null;
let tickTimer = null;

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
  $('boot').hidden = true;
  $('app').hidden = !signedIn;
  $('auth').hidden = signedIn;

  store.unsubscribe();
  clearInterval(hostTimer);
  clearInterval(tickTimer);

  if (!signedIn) {
    closeDrawer();
    $('storage-warning').hidden = storageWorks();
    return;
  }

  syncRoute();
  render();
  await store.loadAll(route.slug);
  store.subscribe();
  store.pollHost();
  hostTimer = setInterval(store.pollHost, 10_000);
  tickTimer = startTicker();
  if (route.view === 'project' || route.view === 'pending') scrollToEnd('auto');
}

initTheme();
initNotify();
views.renderSuggestions();
restoreSettings();
initRouter(onRoute);

(async () => {
  const { data: { session } } = await store.sb.auth.getSession();
  await applySession(session);
  store.sb.auth.onAuthStateChange((_evt, s) => applySession(s));
})();

// Realtime drops when a phone sleeps the tab; resync on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('app').hidden) {
    store.loadAll(route.slug);
    store.pollHost();
  }
});

window.addEventListener('online', () => { setOffline(false); store.loadAll(route.slug); });
window.addEventListener('offline', () => setOffline(true));
setOffline(!navigator.onLine);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw?.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('New version ready — reopen to update', { glyph: 'retry', ms: 4000 });
        }
      });
    });
  }).catch(() => {});
}
