// Asserts the colour claims in style.css instead of trusting them.
//
// A design system that says "every text colour clears 4.5:1" needs something
// that fails when it doesn't. This reads the tokens straight out of the
// stylesheet, works out the WCAG ratio of every ink against every surface it
// can land on, and exits non-zero if one slips. `npm run contrast`, and it
// also runs as part of `npm test`.

import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

// ── colour maths ──────────────────────────────────────────────────────

const srgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex) => {
  const [r, g, b] = srgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// ── reading the tokens back out of the stylesheet ─────────────────────

/** The declarations inside one `selector { … }` block, as a name → value map. */
function block(selector) {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`no ${selector} block in style.css`);
  const open = css.indexOf('{', at);
  const body = css.slice(open + 1, css.indexOf('\n}', open));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  );
}

const hexes = (map) => Object.fromEntries(
  Object.entries(map).filter(([, v]) => /^#[0-9a-f]{6}$/i.test(v)),
);

const light = hexes(block(':root {'));
const dark = hexes(block(':root[data-theme="dark"] {'));
const darkAuto = hexes(block(':root:not([data-theme="light"]) {\n    color-scheme: dark;'));

// ── the claims ────────────────────────────────────────────────────────

const TEXT_MIN = 4.5;   // WCAG AA for body text
const MARK_MIN = 3.0;   // WCAG AA for a graphical object: dot, fill, bar

/** Ink → the surfaces it is actually set on in the app. */
const INK = {
  text: ['bg', 'surface', 'surface-2'],
  'text-2': ['bg', 'surface', 'surface-2'],
  muted: ['bg', 'surface', 'surface-2', 'surface-3'],
  'accent-text': ['bg', 'surface', 'surface-2'],
  'good-text': ['bg', 'surface'],
  'warn-text': ['bg', 'surface'],
  'active-text': ['bg', 'surface'],
  'critical-text': ['bg', 'surface'],
};

/** Mark → the surfaces it is drawn on. Dots, meter fills, chart bars. */
const MARK = {
  good: ['bg', 'surface', 'surface-2'],
  warn: ['bg', 'surface', 'surface-2'],
  active: ['bg', 'surface', 'surface-2'],
  critical: ['bg', 'surface', 'surface-2'],
  accent: ['bg', 'surface'],
  bar: ['bg', 'surface'],          // the day columns in the activity strip
};

const fails = [];
let checks = 0;

function check(label, got, min) {
  checks++;
  if (got + 1e-9 < min) fails.push(`${label}: ${got.toFixed(2)}:1 (needs ${min})`);
}

for (const [mode, tokens] of [['light', light], ['dark', dark]]) {
  for (const [ink, surfaces] of Object.entries(INK)) {
    for (const surface of surfaces) {
      if (!tokens[ink] || !tokens[surface]) { fails.push(`${mode}: missing --${ink}/--${surface}`); continue; }
      check(`${mode}  --${ink} on --${surface}`, contrast(tokens[ink], tokens[surface]), TEXT_MIN);
    }
  }
  for (const [mark, surfaces] of Object.entries(MARK)) {
    for (const surface of surfaces) {
      if (!tokens[mark] || !tokens[surface]) { fails.push(`${mode}: missing --${mark}/--${surface}`); continue; }
      check(`${mode}  --${mark} mark on --${surface}`, contrast(tokens[mark], tokens[surface]), MARK_MIN);
    }
  }
  // Text printed inside the accent: the primary button, the send button.
  check(`${mode}  --accent-fg on --accent`, contrast(tokens['accent-fg'], tokens.accent), TEXT_MIN);
}

// The toggle scope and the OS-preference scope have to agree, or the theme
// switch changes more than the theme.
for (const [name, value] of Object.entries(dark)) {
  checks++;
  if (darkAuto[name] !== value) {
    fails.push(`dark scopes disagree on --${name}: toggle ${value}, system ${darkAuto[name]}`);
  }
}

// Nothing in here is orange any more. Orange is roughly hue 15–45° at a
// chroma high enough to read as a hue rather than a brown-grey; past 45° it
// is the amber the warning step has always been.
const hue = (hex) => {
  const [r, g, b] = srgb(hex);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((h * 60) % 360 + 360) % 360;
};
const saturation = (hex) => {
  const [r, g, b] = srgb(hex);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max ? (max - min) / max : 0;
};
for (const [mode, tokens] of [['light', light], ['dark', dark]]) {
  for (const name of ['accent', 'accent-text', 'good', 'warn', 'warn-text', 'active', 'critical', 'bar']) {
    checks++;
    const h = hue(tokens[name]);
    if (h >= 15 && h <= 45 && saturation(tokens[name]) > 0.35) {
      fails.push(`${mode}: --${name} (${tokens[name]}) is an orange, hue ${h.toFixed(0)}°`);
    }
  }
}

const label = `${checks} colour claims`;
if (fails.length) {
  console.error(`\n  ${label} — ${fails.length} failed:\n`);
  for (const f of fails) console.error(`   ✗ ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`  ${label} hold`);
