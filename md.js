// A very small Markdown subset, enough for an agent's closing summary:
// headings, bold/italic, inline code, fenced code, lists, quotes, rules,
// links. Everything is HTML-escaped *first*, then markup is added back, so
// the output is safe to inject — no sanitiser and no dependency needed.

import { esc } from './util.js';

const SAFE_URL = /^(https?:\/\/|mailto:|#|\/)/i;

const NUL = '\u0000';
const token = (i, kind) => `${NUL}${kind}${i}${NUL}`;

function inline(src, codes) {
  let s = esc(src);

  // Inline code first, so its contents never get bold/italic treatment.
  s = s.replace(/`([^`\n]+)`/g, (_, body) => {
    codes.push(`<code>${body}</code>`);
    return token(codes.length - 1, 'C');
  });

  // [text](url) — only protocols we trust.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const raw = url.replace(/&amp;/g, '&');
    if (!SAFE_URL.test(raw)) return m;
    return `<a href="${esc(raw)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  // Bare URLs.
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/g,
    (_, lead, url) => `${lead}<a href="${esc(url.replace(/&amp;/g, '&'))}" ` +
      'target="_blank" rel="noopener noreferrer">' + url + '</a>');

  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');

  return s;
}

/** Markdown → safe HTML string. */
export function md(src) {
  const text = String(src ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '';

  const blocks = [];
  const codes = [];

  // Pull fenced code out before anything else touches the text.
  const staged = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body) => {
    blocks.push(`<pre><code>${esc(body.replace(/\n+$/, ''))}</code></pre>`);
    return `\n\n${token(blocks.length - 1, 'B')}\n\n`;
  });

  const out = staged.split(/\n{2,}/).map((chunk) => {
    const block = chunk.trim();
    if (!block) return '';

    const held = block.match(new RegExp(`^${NUL}B(\\d+)${NUL}$`));
    if (held) return blocks[Number(held[1])];

    if (/^(-{3,}|_{3,}|\*{3,})$/.test(block)) return '<hr>';

    const head = block.match(/^(#{1,6})\s+(.*)$/s);
    if (head) {
      const level = Math.min(3, head[1].length);
      return `<h${level}>${inline(head[2].trim(), codes)}</h${level}>`;
    }

    const lines = block.split('\n');

    if (lines.every((l) => /^\s*>\s?/.test(l))) {
      const body = lines.map((l) => l.replace(/^\s*>\s?/, '')).join('\n');
      return `<blockquote>${inline(body, codes).replace(/\n/g, '<br>')}</blockquote>`;
    }

    const bullet = lines.filter((l) => /^\s*[-*+]\s+/.test(l)).length;
    const number = lines.filter((l) => /^\s*\d+[.)]\s+/.test(l)).length;

    if (bullet > 0 && bullet >= lines.length - 1) return list(lines, /^\s*[-*+]\s+/, 'ul', codes);
    if (number > 0 && number >= lines.length - 1) return list(lines, /^\s*\d+[.)]\s+/, 'ol', codes);

    return `<p>${inline(block, codes).replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  // Put inline-code spans back.
  return out.replace(new RegExp(`${NUL}C(\\d+)${NUL}`, 'g'), (_, i) => codes[Number(i)]);
}

/** Lines that continue an item (no marker) fold into the item above. */
function list(lines, marker, tag, codes) {
  const items = [];
  for (const line of lines) {
    if (marker.test(line)) items.push(line.replace(marker, ''));
    else if (items.length) items[items.length - 1] += `\n${line.trim()}`;
    else items.push(line.trim());
  }
  const body = items
    .map((item) => `<li>${inline(item, codes).replace(/\n/g, '<br>')}</li>`)
    .join('');
  return `<${tag}>${body}</${tag}>`;
}
