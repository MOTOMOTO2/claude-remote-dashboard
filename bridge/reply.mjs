// Two adapters and the text-shaped glue between them.
//
// The bridge does not know what your assistant is. It knows two ways to ask
// something a question and get words back a piece at a time:
//
//   ASSISTANT_URL   an HTTP endpoint — yours, Ollama, llama.cpp, LM Studio,
//                   anything OpenAI-shaped, or a Flask route you wrote
//   ASSISTANT_CMD   a command — a Python script, a Node script, a CLI
//
// Every guess about a response shape lives in this file and nowhere else, so
// it can be checked against fixed strings in the test suite. The loop in
// bridge.mjs only ever sees `onChunk(text)`.

/** Pull the reply out of a parsed JSON body, whatever dialect it speaks. */
export function bodyText(obj) {
  if (obj == null) return '';
  if (typeof obj === 'string') return obj;

  // OpenAI-shaped, streaming and not.
  const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
  if (choice) {
    const t = choice.delta?.content ?? choice.message?.content ?? choice.text;
    if (typeof t === 'string') return t;
  }

  // Anthropic-shaped: a delta while streaming, a content array when not.
  if (typeof obj.delta?.text === 'string') return obj.delta.text;
  if (Array.isArray(obj.content)) {
    return obj.content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('');
  }

  // Ollama: /api/chat gives a message, /api/generate gives a response.
  if (typeof obj.message?.content === 'string') return obj.message.content;
  if (typeof obj.response === 'string') return obj.response;

  // What a hand-written endpoint tends to call it.
  for (const key of ['reply', 'text', 'answer', 'output', 'result', 'completion', 'content']) {
    if (typeof obj[key] === 'string') return obj[key];
  }
  return '';
}

/** An error an endpoint reported in its own body, as a sentence or ''. */
export function bodyError(obj) {
  const e = obj?.error ?? obj?.detail;
  if (!e) return '';
  if (typeof e === 'string') return e;
  return e.message ?? JSON.stringify(e);
}

/**
 * One line of a stream → the text it carries.
 *
 * `mode` is decided once per response, not per line, because the two failure
 * modes pull in opposite directions: printing an SSE `event:` line as if it
 * were prose puts protocol noise in your reply, and dropping a line of prose
 * because it wasn't JSON loses the answer.
 */
export function chunkText(line, mode = 'prose') {
  const raw = String(line ?? '');
  const trimmed = raw.trim();

  if (mode === 'sse') {
    if (!/^data:/.test(trimmed)) return '';          // event:, id:, retry:, blank
    const body = trimmed.replace(/^data:\s*/, '');
    if (!body || body === '[DONE]') return '';
    return jsonOrRaw(body, body);
  }

  if (mode === 'lines') {
    if (!trimmed || trimmed === '[DONE]') return '';
    return jsonOrRaw(trimmed, `${raw}\n`);
  }

  return raw;
}

/** JSON if it parses, otherwise the fallback. An error in the body throws. */
function jsonOrRaw(body, fallback) {
  if (!(body.startsWith('{') || body.startsWith('['))) return fallback;
  let obj;
  try {
    obj = JSON.parse(body);
  } catch {
    return fallback;
  }
  const err = bodyError(obj);
  if (err) throw new Error(err);
  return bodyText(obj);
}

/** What kind of stream this is, from the first thing it said. */
export function sniff(text) {
  const first = String(text ?? '').replace(/^\s+/, '');
  if (!first) return null;
  if (/^(data|event|id|retry):/.test(first)) return 'sse';
  if (first.startsWith('{') || first.startsWith('[')) return 'lines';
  return 'prose';
}

/**
 * Feed it bytes as they arrive, get whole pieces of reply out. Prose is
 * passed through byte for byte — newlines in an answer are part of the
 * answer — and a structured stream is split into lines first.
 */
export function makeStream(onChunk) {
  let mode = null;
  let held = '';

  return {
    get mode() { return mode; },

    push(text) {
      if (mode === null) {
        mode = sniff(held + text);
        if (mode === null) { held += text; return; }   // whitespace so far
      }
      if (mode === 'prose') {
        onChunk(held + text);
        held = '';
        return;
      }
      held += text;
      const parts = held.split('\n');
      held = parts.pop() ?? '';
      for (const line of parts) {
        const piece = chunkText(line, mode);
        if (piece) onChunk(piece);
      }
    },

    end() {
      if (!held) return;
      const tail = held;
      held = '';
      const piece = mode === null || mode === 'prose' ? tail : chunkText(tail, mode);
      if (piece) onChunk(piece);
    },
  };
}

/** A whole body at once: JSON if it parses, otherwise exactly what was said. */
export function oneShot(text) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  return jsonOrRaw(t, text);
}

/** The conversation as one plain-text transcript, for a command-line brain. */
export function transcript(messages, you = 'You', them = 'Assistant') {
  return messages
    .map((m) => `${m.role === 'user' ? you : them}: ${m.text}`)
    .join('\n\n');
}

const asChat = (messages) => messages.map((m) => ({ role: m.role, content: m.text }));
const lastAsked = (messages) => [...messages].reverse().find((m) => m.role === 'user')?.text ?? '';

// ── the HTTP adapter ──────────────────────────────────────────────────

/**
 * Ask an endpoint and stream what comes back.
 *
 * The request body is deliberately over-complete: `messages` for anything
 * chat-shaped, `prompt` and `input` for anything that wants the question on
 * its own, `stream: true` for servers that need asking. An endpoint ignores
 * the keys it does not know, so one body fits all of them.
 */
export async function askUrl({ url, messages, onChunk, stopped, headers = {}, fetchImpl }) {
  const doFetch = fetchImpl ?? fetch;

  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      messages: asChat(messages),
      prompt: lastAsked(messages),
      input: lastAsked(messages),
      stream: true,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${url} answered ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
  }

  // A server that answers in one piece is the easy case.
  if (!res.body) {
    const piece = oneShot(await res.text());
    if (piece) onChunk(piece);
    return;
  }

  const stream = makeStream(onChunk);
  const decoder = new TextDecoder();
  for await (const bytes of res.body) {
    if (stopped?.()) return;
    stream.push(typeof bytes === 'string' ? bytes : decoder.decode(bytes, { stream: true }));
  }
  stream.end();
}

// ── the command adapter ───────────────────────────────────────────────

/**
 * Run a command and stream its stdout.
 *
 * The question is handed over three ways, because homemade assistants take
 * it three ways: as `$ASSISTANT_PROMPT`, as `$ASSISTANT_TRANSCRIPT`, and as
 * JSON on stdin. Read whichever your script already reads.
 */
export async function askCommand({ cmd, messages, onChunk, stopped, spawnImpl }) {
  const spawn = spawnImpl ?? (await import('node:child_process')).spawn;
  const question = lastAsked(messages);

  const child = spawn(cmd, {
    shell: true,
    env: {
      ...process.env,
      ASSISTANT_PROMPT: question,
      ASSISTANT_TRANSCRIPT: transcript(messages),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stream = makeStream(onChunk);
  let errors = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (text) => {
    if (stopped?.()) { child.kill(); return; }
    stream.push(text);
  });
  child.stderr.on('data', (text) => { errors += text; });

  // A script that never reads stdin would otherwise take the bridge down
  // with an EPIPE the moment we write to it.
  child.stdin.on('error', () => {});
  child.stdin.end(`${JSON.stringify({ messages: asChat(messages), prompt: question })}\n`);

  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  stream.end();

  if (code !== 0 && !stopped?.()) {
    throw new Error(`${cmd} exited ${code}${errors ? ` — ${errors.trim().slice(0, 300)}` : ''}`);
  }
}

/** Whichever adapter is configured, as one call. */
export function answerWith({ url, cmd, headers }) {
  if (cmd) return (opts) => askCommand({ cmd, ...opts });
  if (url) return (opts) => askUrl({ url, headers, ...opts });
  return null;
}
