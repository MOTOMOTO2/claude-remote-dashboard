// What the cloud runner tells Claude, and how it carries memory from one run
// to the next. Pure — rows in, strings out — so test/host.mjs can check every
// word of it without a model, a network or a clock.
//
// Memory lives in three places, from most to least durable:
//
//   1. CLAUDE.md in the project's repo. Claude Code reads it at the start of
//      every session — on this runner, on the PC runner, and in your own
//      editor — and every job is told to keep it current. It is committed
//      and pushed with the work, so it survives any machine.
//   2. The project's last Claude session. A follow-up resumes it, so "now
//      make the button blue" knows which button. Sessions live on the disk
//      of the machine that ran them, so this only works on the same runner.
//   3. The dashboard's own history: earlier prompts on the project and what
//      came of them. Used when there is no session to resume, so a fresh
//      session still knows what it was asked before.

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export const clip = (s, n) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ── naming a new project ──────────────────────────────────────────────

const FILLER = new Set(`a an the and or but for of to in on at by with from me my i
  you your we our it its this that these those please can could would should
  make build create write code develop set up setup start new want need let
  lets some simple small quick little basic using use which who where`.split(/\s+/));

/** "Build me a pomodoro timer with dark mode" → "pomodoro-timer-dark-mode". */
export function slugify(text, fallback = 'project') {
  const words = String(text ?? '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w && !FILLER.has(w))
    .slice(0, 4);
  const slug = words.join('-').slice(0, 40).replace(/-+$/, '');
  return slug || fallback;
}

// ── a coding job ──────────────────────────────────────────────────────

/**
 * Appended to Claude Code's own system prompt for every job. The parts that
 * matter most: nobody can answer a question mid-run, the work has to be
 * checked before it is called done, and CLAUDE.md is the project's memory.
 */
export function jobSystemPrompt({ slug, isNew = false, owner = '', host = 'cloud', today = '' } = {}) {
  const who = owner || 'the user';
  return [
    `You are running unattended as a coding agent on ${who}'s cloud runner ("${host}").`
      + ' The request came from their phone dashboard. They are not watching this session and'
      + ' cannot answer questions while it runs.',
    '',
    'How to work:',
    '- Decide for yourself rather than asking. When something is genuinely ambiguous, take the most'
      + ' sensible reading and say what you assumed in your final message.',
    '- Check your work before you finish: install, build, run the tests or the app, and fix what'
      + ' breaks. Never say something works unless you saw it work.',
    '- Commit as you go, with clear messages. Do not push, and do not change git remotes or'
      + ' credentials: the runner pushes when you finish.',
    '',
    'Project memory (important):',
    '- CLAUDE.md at the repository root is how this project is remembered between sessions, by you'
      + ' and by every agent after you. If it exists, it was loaded for you; trust it, but check it'
      + ' against the code.',
    `- Before you finish, create or update CLAUDE.md so a fresh session could pick this project up`
      + ' cold: what it is and who it is for; how to install, run, test and deploy it; how the code'
      + ' is laid out; conventions and decisions, each with its reason; known problems and sensible'
      + ` next steps; and a short "Recent work" list with one dated line per request${today ? ` (today is ${today})` : ''}.`
      + ' Keep it under about 150 lines: rewrite and prune stale detail rather than appending forever.'
      + ' Commit it with the rest of the work.',
    '',
    'Your final message is shown on their phone as the reply to their request. Keep it short and'
      + ' concrete: what changed, how to see or use it (URLs, commands), and anything they need to'
      + ' do. Markdown is fine; no large code blocks.',
    ...(isNew ? [
      '',
      `This is a brand-new project called "${slug}". The folder is empty apart from git. Give it a`
        + ' sensible structure, a README.md and a .gitignore, as well as CLAUDE.md.',
    ] : []),
  ].join('\n');
}

/**
 * Earlier requests on this project and what came of them, oldest first.
 * `past` rows are { prompt, status, error, result, created_at }.
 */
export function historyBlock(past = [], { max = 6, each = 700 } = {}) {
  const rows = past.filter((p) => oneLine(p.prompt)).slice(-max);
  if (!rows.length) return '';
  const entries = rows.map((p) => {
    const when = String(p.created_at ?? '').slice(0, 10);
    const outcome = p.status === 'error'
      ? `It failed: ${clip(oneLine(p.error) || 'no reason recorded', 300)}`
      : clip(p.result, each) || '(it finished without a summary)';
    return `### ${when || 'earlier'}: they asked\n${clip(p.prompt, 600)}\n\nWhat happened:\n${outcome}`;
  });
  return 'Earlier requests on this project from the dashboard, oldest first. The code and'
    + ' CLAUDE.md are the source of truth; this is what you were asked and what you reported.\n\n'
    + entries.join('\n\n');
}

/** What to send as the user turn of a job. */
export function jobPrompt({ prompt, past = [], resumed = false, continuing = false }) {
  if (continuing) {
    return 'You were paused by the usage limit and the limit has reset. Carry on from where you'
      + ' left off and finish the request.';
  }
  if (resumed) {
    return 'A new request from the dashboard, on the same project. The repository may have changed'
      + ' since your last turn (another agent or the user may have worked on it), so check `git log`'
      + ` if it matters.\n\n${prompt}`;
  }
  const history = historyBlock(past);
  return history ? `${history}\n\n---\n\nNew request:\n${prompt}` : String(prompt ?? '');
}

// ── the stream, as lines on the dashboard ─────────────────────────────

const shortPath = (p) => String(p ?? '')
  .replace(/^.*?\/(?:work|assistant)\/[^/]+\//, '')
  .replace(/^\/data\//, '');

/** One tool call as the activity line under an agent's card. */
export function describeTool(name, input = {}) {
  const file = input.file_path ?? input.path ?? input.notebook_path;
  switch (name) {
    case 'Read': return `Read ${shortPath(file)}`;
    case 'Write': return `Write ${shortPath(file)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': return `Edit ${shortPath(file)}`;
    case 'Bash': return `$ ${clip(oneLine(input.command), 160)}`;
    case 'Glob': return `Find ${clip(input.pattern, 80)}`;
    case 'Grep': return `Search for "${clip(input.pattern, 60)}"`;
    case 'WebSearch': return `Search the web: ${clip(input.query, 100)}`;
    case 'WebFetch': return `Read ${clip(input.url, 120)}`;
    case 'TodoWrite': return 'Update the plan';
    case 'Task':
    case 'Agent': return `Subagent: ${clip(oneLine(input.description ?? input.prompt), 100)}`;
    default: return name ? `${name}` : 'tool';
  }
}

// ── the subscription's limits ─────────────────────────────────────────

/**
 * A `rate_limit_event` as a `usage_windows` row. Claude Code reports
 * utilization as a fraction and the reset as epoch seconds; the dashboard
 * wants a percentage and an ISO time.
 */
export function usageRow(info, now = Date.now()) {
  if (!info?.rateLimitType || typeof info.utilization !== 'number') return null;
  const pct = info.utilization <= 1 ? info.utilization * 100 : info.utilization;
  const reset = typeof info.resetsAt === 'number'
    ? new Date(info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt).toISOString()
    : null;
  return {
    window_type: info.rateLimitType,
    pct: Math.round(Math.min(100, Math.max(0, pct))),
    resets_at: reset,
    updated_at: new Date(now).toISOString(),
  };
}

/** When a refused or capped run may go again. Falls back to half an hour. */
export function resumeAt(info, now = Date.now()) {
  const at = typeof info?.resetsAt === 'number'
    ? (info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt)
    : 0;
  return new Date(at > now ? at + 60_000 : now + 30 * 60_000).toISOString();
}

/** A failed run whose reason was the subscription's limit, not the work. */
export const hitLimit = (text) =>
  /usage limit|limit reached|hit your (usage )?limit|rate[_ ]limit|limit will reset|resets? (at|in)\b/i
    .test(String(text ?? ''));

/** `--resume` pointed at a session this machine does not have. */
export const lostSession = (text) =>
  /no conversation found|session .*not found|could not (find|resume)/i.test(String(text ?? ''));

// ── the Ask tab ───────────────────────────────────────────────────────

/** Appended to Claude Code's system prompt for a conversation. */
export function chatSystemPrompt({ owner = '', tools = 'node bridge/tools.mjs', work = 'work', github = '', host = 'cloud' } = {}) {
  const who = owner || 'the user';
  return [
    `You are Claude, answering in the Ask tab of ${who}'s personal dashboard, a web app they`
      + ' mostly use on a phone. Answer directly, in Markdown, in short paragraphs. No large code'
      + ' blocks unless they ask.',
    '',
    `You run on their cloud runner ("${host}"), not on their PC. What you can reach:`,
    `- Their projects. Ones agents have worked on are cloned in ${work}/<name>.`
      + (github ? ` To read another of their repositories, clone it there: git clone https://github.com/${github}/<name>.git ${work}/<name>` : ''),
    '- The dashboard, as a command. Arguments go in as JSON on stdin:',
    `    ${tools} list`,
    `    echo '{}' | ${tools} call dashboard_status`,
    `    echo '{"slug":"my-app"}' | ${tools} call job_details`,
    `    echo '{"slug":"my-app","prompt":"…"}' | ${tools} call queue_job`,
    '  The tools are dashboard_status, job_details, list_projects, queue_job, house_status and'
    + ' house_control.',
    '- The web, through WebSearch and WebFetch.',
    '',
    'Rules:',
    '- Do not change project code from here. When they want something built, fixed or changed,'
      + ' queue it with queue_job: write a complete, self-contained prompt and name the project.'
      + ' It runs as its own agent, with its own log on the dashboard. Tell them you queued it.',
    '- house_control changes their real house. Use it only when their latest message asks.',
    '- CLAUDE.md in your working folder is your long-term memory of them. It was loaded for you.'
      + ' When you learn something worth keeping (preferences, goals, facts about their projects or'
      + ' setup), add a line under "What I know" and keep the file tidy. Never store secrets.',
  ].join('\n');
}

/** The memory file a brand-new assistant folder starts with. */
export function seedMemory({ owner = '', github = '' } = {}) {
  return [
    '# Memory',
    '',
    'Claude\'s long-term memory for the dashboard\'s Ask tab. It is loaded at the start of every',
    'conversation, and Claude adds to it as it learns things worth keeping.',
    '',
    '## What I know',
    '',
    owner ? `- I work for ${owner}.` : '- (nothing yet)',
    github ? `- Their GitHub account is ${github}.` : '',
    '',
  ].filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n');
}

/**
 * The user turn of a conversation. A resumed session already holds the
 * earlier turns; a fresh one is handed them, so a thread never forgets
 * itself just because it moved machines.
 */
export function chatPrompt({ messages = [], resumed = false, max = 24 }) {
  const said = messages.filter((m) => oneLine(m.text));
  const last = [...said].reverse().find((m) => m.role === 'user');
  const latest = String(last?.text ?? '').trim();
  if (resumed) return latest;
  const before = said.slice(0, last ? said.lastIndexOf(last) : said.length).slice(-max);
  if (!before.length) return latest;
  const transcript = before
    .map((m) => `${m.role === 'user' ? 'Them' : 'You'}: ${String(m.text).trim()}`)
    .join('\n\n');
  return `This conversation so far (you are picking it up in a fresh session):\n\n${transcript}`
    + `\n\n---\n\nTheir new message:\n${latest}`;
}
