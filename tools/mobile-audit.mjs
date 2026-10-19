// Measures the narrow layout in a real browser engine, because "some stuff is
// cut off" is a fact about boxes, not about markup — jsdom has no layout, so
// the smoke test cannot see it.
//
//   node tools/mobile-audit.mjs            # every view at 390px
//   node tools/mobile-audit.mjs home 360   # one view, one width
//
// It renders each screen with tools/preview.mjs, re-opens the frozen file in
// headless Chrome with a probe script appended, and reports: content clipped
// or pushed past the viewport, the page scrolling sideways at all, anything
// left under the bottom bar, and tap targets under 40px.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const dir = fileURLToPath(root);

const VIEWS = ['home', 'agents', 'ask', 'chat', 'new', 'ideas', 'projects', 'auth'];

/** Any of the browsers a box with Playwright, Chrome or Edge already has. */
function findBrowser() {
  const user = process.env.USERNAME ?? process.env.USER ?? '';
  const shells = [
    `C:/Users/${user}/AppData/Local/ms-playwright/chromium_headless_shell-1248`
      + '/chrome-headless-shell-win64/chrome-headless-shell.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ];
  return [process.env.CHROME, ...shells].filter(Boolean).find((p) => existsSync(p)) ?? null;
}

const PROBE = String.raw`
<script>
(() => {
  const vw = innerWidth, vh = innerHeight;
  const out = { viewport: vw, pageWidth: document.documentElement.scrollWidth, findings: [] };
  const name = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className.trim() : '';
    if (cls) s += '.' + cls.split(/\s+/).slice(0, 3).join('.');
    return s;
  };
  const words = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70);
  const shown = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { cs, r };
  };
  const add = (kind, el, extra) => out.findings.push({ kind, el: name(el), text: words(el), ...extra });

  /** Is this point scrolled out of one of the boxes the element lives in? */
  const clipped = (el, x, y) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflow === 'visible' && cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const b = p.getBoundingClientRect();
      if (x < b.left || x > b.right || y < b.top || y > b.bottom) return true;
    }
    return false;
  };

  const all = [...document.querySelectorAll('body *')];
  for (const el of all) {
    if (el.hidden || el.closest('[hidden]')) continue;
    // A closed <details> keeps its contents in the layout tree with stale
    // boxes, which read as overlapping things they are nowhere near.
    if (el.closest('details:not([open])') && !el.closest('summary')) continue;
    const v = shown(el); if (!v) continue;
    const cs = v.cs, r = v.r;

    // Content wider than its own box. Ellipsis is a decision; the rest is a cut.
    const over = el.scrollWidth - el.clientWidth;
    if (el.clientWidth > 0 && over > 1) {
      const ellipsis = cs.textOverflow === 'ellipsis';
      const scrolls = /auto|scroll/.test(cs.overflowX);
      if (!ellipsis && !scrolls) add('clipped', el, { over: over, box: el.clientWidth, ox: cs.overflowX });
    }

    // Boxes that reach past the screen edge.
    if (cs.position !== 'fixed' && (r.right > vw + 1 || r.left < -1)) {
      add('past-edge', el, { left: Math.round(r.left), right: Math.round(r.right) });
    }

    // Tap targets you would miss. A control may be smaller than its hit
    // area — an ::after stretched past its own edges is the usual way to
    // keep a dense screen dense and still catch a thumb — so measure that.
    // A field you type into is sized by its own content and is always the
    // width of the column; it is not what anyone misses with a thumb.
    const tappy = el.matches('a[href],button,[role="button"],[role="tab"]');
    if (tappy && !el.closest('.md')) {
      const pseudo = getComputedStyle(el, '::after');
      const grow = (side) => (pseudo.content !== 'none' && pseudo.position === 'absolute'
        ? Math.max(0, -parseFloat(pseudo[side]) || 0) : 0);
      const h = r.height + grow('top') + grow('bottom');
      const w = r.width + grow('left') + grow('right');
      if (h < 39.5 || w < 31.5) add('small-target', el, { w: Math.round(w), h: Math.round(h) });

      // And the other way round: a hit area grown over a neighbour would
      // swallow that neighbour's taps, which is worse than the small target
      // it was fixing. The middle of a control has to belong to it.
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = cx > 0 && cx < vw && cy > 0 && cy < vh && !clipped(el, cx, cy)
        ? document.elementFromPoint(cx, cy) : null;
      if (hit && !el.contains(hit) && !hit.contains(el)) add('covered', el, { by: name(hit) });
    }
  }

  // Scroll to the end and see what the fixed furniture is sitting on top of.
  const bars = all.filter((el) => {
    const v = shown(el);
    return v && v.cs.position === 'fixed' && v.r.bottom > vh - 2 && v.r.height < vh / 2;
  });
  const scroller = document.scrollingElement;
  const panes = all.filter((el) => el.scrollHeight - el.clientHeight > 4 && /auto|scroll/.test(getComputedStyle(el).overflowY));
  for (const p of panes) p.scrollTop = p.scrollHeight;
  scroller.scrollTop = scroller.scrollHeight;
  const covered = [];
  for (const bar of bars) {
    const b = bar.getBoundingClientRect();
    for (const el of all) {
      if (bar.contains(el) || el.contains(bar)) continue;
      if (el.children.length) continue;                 // leaves only: real content
      const v = shown(el); if (!v) continue;
      const r = v.r;
      if (r.top < b.bottom - 2 && r.bottom > b.top + 2 && r.right > b.left && r.left < b.right) {
        covered.push({ kind: 'under-bar', el: name(el), text: words(el), bar: name(bar) });
      }
    }
  }
  out.findings.push(...covered.slice(0, 12));

  const pre = document.createElement('pre');
  pre.id = 'audit-report';
  pre.textContent = JSON.stringify(out);
  document.body.append(pre);
})();
</script>`;

function audit(browser, view, width) {
  execFileSync(process.execPath,
    ['--import', './test/register.mjs', 'tools/preview.mjs', view, 'mobile'],
    { cwd: dir, stdio: 'pipe' });

  const src = `${dir}preview/${view}-mobile.html`;
  const probed = `${dir}preview/_audit-${view}.html`;
  writeFileSync(probed, readFileSync(src, 'utf8').replace('</body>', `${PROBE}</body>`));

  const url = 'file:///' + probed.replace(/\\/g, '/').replace(/ /g, '%20');
  const dom = execFileSync(browser, [
    '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--window-size=${width},844`, '--virtual-time-budget=3000', '--dump-dom', url,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

  const m = dom.match(/<pre id="audit-report">([\s\S]*?)<\/pre>/);
  if (!m) throw new Error(`${view}: the probe did not run`);
  const json = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return JSON.parse(json);
}

const args = process.argv.slice(2);
const views = args.filter((a) => !/^\d+$/.test(a));
const width = Number(args.find((a) => /^\d+$/.test(a))) || 390;

const browser = findBrowser();
if (!browser) {
  console.error('No Chrome found. Set CHROME=/path/to/chrome and re-run.');
  process.exit(1);
}

mkdirSync(new URL('preview/', root), { recursive: true });
let total = 0;
for (const view of (views.length ? views : VIEWS)) {
  const report = audit(browser, view, width);
  const sideways = report.pageWidth > report.viewport + 1;
  const groups = new Map();
  for (const f of report.findings) {
    const key = `${f.kind}|${f.el}`;
    if (!groups.has(key)) groups.set(key, { ...f, n: 0 });
    groups.get(key).n++;
  }
  console.log(`\n-- ${view} @ ${width}px ${'-'.repeat(Math.max(0, 36 - view.length))}`);
  if (sideways) {
    console.log(`  !! scrolls sideways: ${report.pageWidth}px of content in ${report.viewport}px`);
  }
  if (!groups.size && !sideways) { console.log('  clean'); continue; }
  for (const f of [...groups.values()].sort((a, b) => a.kind.localeCompare(b.kind))) {
    total++;
    const extra = Object.entries(f)
      .filter(([k]) => !['kind', 'el', 'text', 'n'].includes(k))
      .map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`  [${f.kind}] ${f.el}${f.n > 1 ? ` x${f.n}` : ''}  ${extra}`);
    if (f.text) console.log(`      "${f.text}"`);
  }
}
console.log(`\n${total} finding${total === 1 ? '' : 's'}`);
