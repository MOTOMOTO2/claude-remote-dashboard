// Draws icon.png — the installed app's icon — from the same geometry as
// favicon.svg, so the two can never drift apart. Run it after a brand change:
//
//   node tools/icon.mjs
//
// No image library: it rasterises a signed-distance field (round-capped
// strokes, rounded corners, antialiased by sampling the distance) and writes
// a PNG by hand with zlib.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const SIZE = 512;
const BG = [0x10, 0x10, 0x14];      // --bg, dark
const FG = [0xb7, 0x9c, 0xff];      // --accent, dark

// Geometry in the 24-unit space favicon.svg uses, scaled up.
const U = SIZE / 24;
const CORNER = 6 * U;
const STROKE = 2.1 * U;
// The eight rays of the brand spark, kept inside a maskable icon's safe zone.
const R = 7.1 * U;
const C = SIZE / 2;
const RAYS = [0, 45, 90, 135].map((deg) => {
  const a = (deg * Math.PI) / 180;
  return [C - Math.cos(a) * R, C - Math.sin(a) * R, C + Math.cos(a) * R, C + Math.sin(a) * R];
});

/** Distance from a point to a segment — a round-capped stroke is just this. */
function distToSegment(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Signed distance to a rounded square: negative inside. */
function distToRoundRect(px, py) {
  const qx = Math.abs(px - C) - (SIZE / 2 - CORNER);
  const qy = Math.abs(py - C) - (SIZE / 2 - CORNER);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
    + Math.min(Math.max(qx, qy), 0) - CORNER;
}

const coverage = (d) => Math.max(0, Math.min(1, 0.5 - d));   // 1px antialiased edge

const rows = [];
for (let y = 0; y < SIZE; y++) {
  const row = Buffer.alloc(1 + SIZE * 4);            // filter byte + RGBA
  for (let x = 0; x < SIZE; x++) {
    const px = x + 0.5, py = y + 0.5;
    const inCard = coverage(distToRoundRect(px, py));
    const onRay = coverage(Math.min(...RAYS.map((s) => distToSegment(px, py, s))) - STROKE / 2);
    const at = 1 + x * 4;
    for (let ch = 0; ch < 3; ch++) {
      row[at + ch] = Math.round(BG[ch] + (FG[ch] - BG[ch]) * onRay);
    }
    row[at + 3] = Math.round(255 * inCard);
  }
  rows.push(row);
}

// ── the PNG container ─────────────────────────────────────────────────

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;        // bit depth
ihdr[9] = 6;        // colour type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = new URL('../icon.png', import.meta.url);
writeFileSync(out, png);
console.log(`wrote icon.png — ${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(1)} kB`);
