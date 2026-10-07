// Chrome that isn't the data: theme, drawer, toasts, confirm dialog, the
// one-second ticker that keeps relative times honest.

import { $, esc, ago, elapsed } from './util.js';

// ── icons ─────────────────────────────────────────────────────────────
/** Reference into the sprite in index.html. */
export const icon = (name, cls = '') =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"${cls ? ` class="${cls}"` : ''}><use href="#i-${name}"/></svg>`;

// ── theme ─────────────────────────────────────────────────────────────

const THEME_KEY = 'cr-theme';
const CHROME = { light: '#faf9f6', dark: '#121211' };

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
 * One interval for the whole page. Any element carrying `data-elapsed` or
 * `data-ago` gets its text refreshed, so nothing has to re-render just to
 * move a clock forward.
 */
export function startTicker() {
  const beat = () => {
    for (const el of document.querySelectorAll('[data-elapsed]')) {
      el.textContent = elapsed(el.dataset.elapsed);
    }
    for (const el of document.querySelectorAll('[data-ago]')) {
      el.textContent = ago(el.dataset.ago);
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
