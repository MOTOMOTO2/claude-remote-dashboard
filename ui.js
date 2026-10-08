// Chrome that isn't the data: theme, drawer, toasts, confirm dialog, the
// one-second ticker that keeps relative times honest.

import { $, esc, ago, elapsed, until } from './util.js';

// ── icons ─────────────────────────────────────────────────────────────
/** Reference into the sprite in index.html. */
export const icon = (name, cls = '') =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"${cls ? ` class="${cls}"` : ''}><use href="#i-${name}"/></svg>`;

// ── theme ─────────────────────────────────────────────────────────────

const THEME_KEY = 'cr-theme';
const CHROME = { light: '#f7f7fb', dark: '#101014' };

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

export const readTheme = () => {
  try { return localStorage.getItem(THEME_KEY) ?? 'system'; } catch { return 'system'; }
};

export function applyTheme(pref = readTheme()) {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.dataset.theme = pref;

  const resolved = pref === 'system' ? (systemDark() ? 'dark' : 'light') : pref;
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.remove();
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = CHROME[resolved];
  document.head.append(meta);

  for (const b of document.querySelectorAll('[data-theme-set]')) {
    b.setAttribute('aria-checked', String(b.dataset.themeSet === pref));
  }
}

export function setTheme(pref) {
  try { localStorage.setItem(THEME_KEY, pref); } catch { /* storage blocked */ }
  applyTheme(pref);
}

export function initTheme() {
  applyTheme();
  for (const b of document.querySelectorAll('[data-theme-set]')) {
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => setTheme(b.dataset.themeSet));
  }
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => { if (readTheme() === 'system') applyTheme('system'); });
}

// ── drawer / sidebar ──────────────────────────────────────────────────

export const isNarrow = () => window.matchMedia('(max-width: 899px)').matches;

let lastFocus = null;

export function openDrawer() {
  if (!isNarrow()) return;
  lastFocus = document.activeElement;
  $('scrim').hidden = false;
  $('sidebar').classList.add('open');
  $('menu-open').setAttribute('aria-expanded', 'true');
  $('project-search').focus({ preventScroll: true });
}

export function closeDrawer() {
  if (!$('sidebar').classList.contains('open')) {
    $('scrim').hidden = true;
    return;
  }
  $('sidebar').classList.remove('open');
  $('scrim').hidden = true;
  $('menu-open').setAttribute('aria-expanded', 'false');
  if (lastFocus?.isConnected) lastFocus.focus({ preventScroll: true });
  lastFocus = null;
}

export const drawerOpen = () => $('sidebar').classList.contains('open');

/** Keep Tab inside the drawer while it covers the page. */
export function trapFocus(e) {
  if (e.key !== 'Tab' || !drawerOpen()) return;
  const nodes = [...$('sidebar').querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled])')]
    .filter((n) => n.offsetParent !== null);
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

// ── toasts ────────────────────────────────────────────────────────────

export function toast(message, { bad = false, glyph = bad ? 'offline' : 'check', ms = 2800 } = {}) {
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  el.innerHTML = `${icon(glyph)}<span>${esc(message)}</span>`;
  $('toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 600);
  }, ms);
}

export async function copy(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, { glyph: 'copy' });
    return true;
  } catch {
    toast('Could not copy', { bad: true });
    return false;
  }
}

// ── confirm dialog ────────────────────────────────────────────────────

/** A styled replacement for window.confirm(). Resolves to true/false. */
export function ask({ title, body = '', confirm = 'Confirm', danger = false }) {
  const dlg = $('confirm');
  if (typeof dlg?.showModal !== 'function') {
    return Promise.resolve(window.confirm(`${title}\n\n${body}`));
  }

  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  $('confirm-body').hidden = !body;

  const yes = $('confirm-yes');
  yes.textContent = confirm;
  yes.className = `btn ${danger ? 'danger' : 'primary'}`;

  return new Promise((resolve) => {
    const done = (answer) => {
      yes.removeEventListener('click', onYes);
      $('confirm-no').removeEventListener('click', onNo);
      dlg.removeEventListener('cancel', onNo);
      dlg.close();
      resolve(answer);
    };
    const onYes = () => done(true);
    const onNo = (e) => { e.preventDefault?.(); done(false); };

    yes.addEventListener('click', onYes);
    $('confirm-no').addEventListener('click', onNo);
    dlg.addEventListener('cancel', onNo);
    dlg.showModal();
    $('confirm-no').focus();
  });
}

// ── ticker ────────────────────────────────────────────────────────────

/**
 * One interval for the whole page. Any element carrying `data-elapsed`,
 * `data-ago` or `data-until` gets its text refreshed, so nothing has to
 * re-render just to move a clock forward.
 */
export function startTicker() {
  const beat = () => {
    for (const el of document.querySelectorAll('[data-elapsed]')) {
      el.textContent = elapsed(el.dataset.elapsed);
    }
    for (const el of document.querySelectorAll('[data-ago]')) {
      el.textContent = ago(el.dataset.ago);
    }
    for (const el of document.querySelectorAll('[data-until]')) {
      el.textContent = until(el.dataset.until);
    }
  };
  beat();
  return setInterval(beat, 1000);
}

// ── misc chrome ───────────────────────────────────────────────────────

export function setOffline(off) {
  $('offline-bar').hidden = !off;
}

/** Running count in the tab title and, where supported, on the app icon. */
export function setBadge(count) {
  document.title = count ? `(${count}) claude-remote` : 'claude-remote';
  try {
    if (count) navigator.setAppBadge?.(count);
    else navigator.clearAppBadge?.();
  } catch { /* unsupported */ }
}

// ── desktop / phone notifications ─────────────────────────────────────
// No push server involved: the page asks the browser directly, and only
// fires while it is in the background — a toast already covers the case
// where you are looking at it.

const NOTIFY_KEY = 'cr-notify';
const supported = () => typeof window.Notification === 'function';

export const notifyOn = () => {
  try {
    return supported()
      && localStorage.getItem(NOTIFY_KEY) === 'on'
      && window.Notification.permission === 'granted';
  } catch { return false; }
};

function paintNotifyButton() {
  const btn = $('notify-toggle');
  if (!btn) return;
  btn.hidden = !supported();
  const on = notifyOn();
  btn.setAttribute('aria-pressed', String(on));
  btn.querySelector('use')?.setAttribute('href', on ? '#i-bell' : '#i-bell-off');
  btn.title = on ? 'Notifications on — jobs tell you when they finish'
                 : 'Notify me when a job finishes';
}

export async function toggleNotify() {
  if (!supported()) { toast('This browser has no notifications', { bad: true }); return; }

  if (notifyOn()) {
    try { localStorage.setItem(NOTIFY_KEY, 'off'); } catch { /* blocked */ }
    paintNotifyButton();
    toast('Notifications off', { glyph: 'bell-off' });
    return;
  }

  let permission = window.Notification.permission;
  if (permission === 'default') permission = await window.Notification.requestPermission();
  if (permission !== 'granted') {
    toast('Notifications are blocked for this site', { bad: true, ms: 4000 });
    paintNotifyButton();
    return;
  }

  try { localStorage.setItem(NOTIFY_KEY, 'on'); } catch { /* blocked */ }
  paintNotifyButton();
  toast('Notifications on', { glyph: 'bell' });
}

export function initNotify() {
  paintNotifyButton();
  $('notify-toggle')?.addEventListener('click', toggleNotify);
}

/** Fires only when the page is hidden; otherwise the toast is enough. */
export function notify(title, body) {
  if (!notifyOn() || document.visibilityState === 'visible') return;
  try {
    new window.Notification(title, { body, icon: 'icon.png', tag: 'claude-remote' });
  } catch { /* some browsers only allow this from a service worker */ }
}
