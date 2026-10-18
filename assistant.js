// Talking to your own assistant: who is listening on your PC, what a reply
// that hasn't landed yet is actually waiting for, and the conversations you
// have had. Pure — rows already in memory in, plain data out — so views.js
// only draws it and the smoke test can check it against fixed inputs.
//
// It is the same relay the coding agents use, for the same reason: your
// assistant runs on your PC, and a phone on mobile data cannot reach it. So
// a message goes into Supabase, the bridge on the PC claims it, and the
// answer streams back into the same row. Nothing is forwarded to anyone
// else's model, and nothing needs a port open on your router.
//
// Which means the honest answer to "where is my reply?" has four shapes, and
// getting them wrong is worse than a crash: "typing…" while the PC is off is
// a lie you would sit and wait for.

/** A heartbeat older than this and the bridge is not there. Same as a host. */
export const FRESH_MS = 30_000;

const time = (iso) => Date.parse(iso ?? '') || 0;
const oldest = (a, b) => time(a.created_at) - time(b.created_at);
const firstLine = (s) => String(s ?? '').split('\n')[0].trim();

/**
 * What is listening on your PC. `known: false` means no bridge has ever
 * checked in — a different thing from one that checked in an hour ago, and
 * the screen says so rather than printing "offline" for both.
 */
export function presence(assistant, now = Date.now()) {
  if (!assistant) {
    return { known: false, online: false, name: 'your assistant', model: null, lastSeen: null };
  }
  return {
    known: true,
    online: time(assistant.last_seen) > 0 && now - time(assistant.last_seen) < FRESH_MS,
    name: assistant.name || 'your assistant',
    model: assistant.model || null,
    lastSeen: assistant.last_seen ?? null,
  };
}

/** A reply that has been asked for and hasn't finished arriving. */
export const isPending = (m) => m?.role === 'assistant'
  && (m.status === 'queued' || m.status === 'streaming');

export const WAIT = {
  typing: 'typing…',
  stopping: 'stopping…',
  next: 'about to start',
  queued: 'waiting its turn',
  offline: 'waiting for your PC',
  never: 'no assistant has checked in',
};

/**
 * Where one reply is up to, in a word and a sentence.
 *
 * @param message the assistant row
 * @param online  whether the bridge checked in recently
 * @param known   whether a bridge has ever checked in
 * @param ahead   how many other replies are queued in front of it
 */
export function replyState({ message, online = false, known = true, ahead = 0 } = {}) {
  const m = message ?? {};
  if (m.status === 'error') {
    return { kind: 'failed', live: false, label: 'did not come back', note: m.error || '' };
  }
  if (m.status === 'done') return { kind: 'done', live: false, label: '', note: '' };

  if (m.cancel_requested) {
    return { kind: 'stopping', live: true, label: WAIT.stopping, note: '' };
  }
  if (m.status === 'streaming') {
    return { kind: 'typing', live: true, label: WAIT.typing, note: '' };
  }
  if (!known) {
    return {
      kind: 'never',
      live: false,
      label: WAIT.never,
      note: 'Start the assistant bridge on your PC and this is answered the moment it does.',
    };
  }
  if (!online) {
    return {
      kind: 'offline',
      live: false,
      label: WAIT.offline,
      note: 'Your PC is asleep or off. This is answered as soon as it is on again — '
          + 'you can close the app.',
    };
  }
  if (ahead > 0) {
    return {
      kind: 'queued',
      live: false,
      label: `${WAIT.queued} · ${ahead} ahead`,
      note: '',
    };
  }
  return { kind: 'next', live: false, label: WAIT.next, note: '' };
}

/** A conversation's name: what you called it, else how it opened. */
export function titleOf(chat, messages = []) {
  const given = String(chat?.title ?? '').trim();
  if (given) return given;
  const opener = messages.filter((m) => m.role === 'user').sort(oldest)[0];
  const line = firstLine(opener?.text);
  if (!line) return 'New conversation';
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}

/**
 * Every conversation, newest first, each with its own messages attached and
 * its pending replies counted. `messages` is the flat table; a chat with no
 * rows yet still shows up, because you can open one before you say anything.
 */
export function conversations({ chats = [], messages = [] } = {}) {
  const byChat = new Map();
  for (const m of messages) {
    const list = byChat.get(m.chat_id);
    if (list) list.push(m);
    else byChat.set(m.chat_id, [m]);
  }

  return chats
    .map((chat) => {
      const mine = (byChat.get(chat.id) ?? []).sort(oldest);
      const said = mine.filter((m) => m.role === 'user');
      return {
        id: chat.id,
        chat,
        title: titleOf(chat, mine),
        messages: mine,
        asked: said.length,
        pending: mine.filter(isPending).length,
        last: mine.at(-1) ?? null,
        at: Math.max(time(chat.updated_at), time(chat.created_at), time(mine.at(-1)?.created_at)),
      };
    })
    .sort((a, b) => b.at - a.at);
}

/**
 * Reading order for one conversation: a user message and the reply it earned,
 * paired. An assistant row with nothing in front of it (a regenerate, or a
 * reply the bridge volunteered) still gets a turn of its own.
 */
export function turns(messages = []) {
  const out = [];
  for (const m of [...messages].sort(oldest)) {
    if (m.role === 'user') out.push({ you: m, reply: null });
    else if (out.length && !out.at(-1).reply) out.at(-1).reply = m;
    else out.push({ you: null, reply: m });
  }
  return out;
}

/**
 * The queue across every conversation, in the order the bridge claims it —
 * oldest first — so a reply can say how many are in front of it.
 */
export function pendingQueue(messages = []) {
  return messages.filter(isPending).sort(oldest);
}

/** How many replies are in flight anywhere. The number on the tab. */
export const pendingCount = (messages = []) => pendingQueue(messages).length;

/**
 * Openers for an assistant you have never spoken to. Deliberately about the
 * thing it has that a hosted model doesn't — it is on your machine, it is
 * yours, and it is awake whenever the PC is.
 */
export const STARTERS = [
  { icon: 'brain', text: 'What can you do that a hosted assistant can’t?' },
  { icon: 'doc', text: 'Summarise what I worked on this week.' },
  { icon: 'bulb', text: 'Help me think through what to build next.' },
  { icon: 'terminal', text: 'Explain what’s running on my PC right now.' },
];
