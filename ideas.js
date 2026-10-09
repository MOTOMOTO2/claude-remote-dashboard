// New projects to build, read off the ones you have already built.
//
// `suggest.js` answers "what next for this repo?". This answers the other
// question — "what should I build at all?" — and it answers it from your own
// work rather than from a list of nice ideas. Every prompt you have sent and
// every summary an agent wrote back is one corpus; themes are matched against
// it; each theme you have actually worked in offers concrete projects, and
// each one says which of your projects put it there.
//
// Nothing here calls a model. It is keyword probes and a few counts, which
// means it is wrong in boring, visible ways — a project whose topic never came
// up in words won't register — and never wrong in interesting ones.

import { plural } from './util.js';

/**
 * The kinds of thing you build. `probe` runs over one project's words; a hit
 * means that project counts as evidence for the theme.
 */
const THEMES = {
  game: {
    label: 'games', icon: 'game', tag: 'game',
    probe: /\bgames?\b|snake|tetris|pong|puzzle|arcade|platformer|roguelike|chess|sudoku|wordle|\bplayer\b|high.?score/i,
  },
  web: {
    label: 'browser apps', icon: 'globe', tag: 'web',
    probe: /\bsites?\b|\bweb\b|\bhtml\b|\bcss\b|\bpages?\b|react|svelte|\bvue\b|next\.?js|frontend|\bspa\b|landing/i,
  },
  cli: {
    label: 'command-line tools', icon: 'terminal', tag: 'cli',
    probe: /\bcli\b|command.?line|\bterminal\b|\bargv\b|\bshell\b|\bflags?\b|stdin|stdout|\bexit code\b/i,
  },
  api: {
    label: 'APIs and servers', icon: 'server', tag: 'api',
    probe: /\bapis?\b|\brest\b|endpoints?|express|fastapi|\bservers?\b|graphql|\broutes?\b|\bauth\b|webhook/i,
  },
  data: {
    label: 'data wrangling', icon: 'database', tag: 'data',
    probe: /\bscrap(e|er|ing)\b|\bcsvs?\b|\bjson\b|\bparse|dataset|pandas|\bsql\b|sqlite|postgres|\bqueries\b|\bquery\b|\bdatabase\b/i,
  },
  viz: {
    label: 'dashboards and charts', icon: 'chart', tag: 'viz',
    probe: /dashboards?|\bcharts?\b|\bgraphs?\b|\bplots?\b|visuali[sz]|\bmeters?\b|\bsparkline|\bd3\b|\breport\b/i,
  },
  bot: {
    label: 'bots and automations', icon: 'bot', tag: 'bot',
    probe: /\bbots?\b|discord|telegram|slack|\bcron\b|\bscheduled?\b|automat(e|ed|ion)|\bnotif(y|ication)|\bwatcher?\b|\bpoll(s|ing)?\b/i,
  },
  ai: {
    label: 'AI projects', icon: 'brain', tag: 'ai',
    probe: /\bllms?\b|\bclaude\b|anthropic|\bprompts?\b|embedding|\bagents?\b|\bmodels?\b|\btokens?\b/i,
  },
  mobile: {
    label: 'phone-first apps', icon: 'phone', tag: 'mobile',
    probe: /\bpwa\b|\bmobile\b|\bphones?\b|\bios\b|android|react.native|offline.first|service.worker|home.screen/i,
  },
  tool: {
    label: 'developer tooling', icon: 'wrench', tag: 'tooling',
    probe: /\blint(er|ing)?\b|\bbundler?\b|\bformatter?\b|\bgenerator?\b|\bcodegen\b|\bgit hook|pre.commit|\bscaffold|\bbuild step\b/i,
  },
};

/** Stacks worth naming back at you, so a brief lands in tools you know. */
const STACK = {
  node: /\bnode\b|\bnpm\b|javascript|\bjs\b|typescript|\bts\b/i,
  python: /\bpython\b|\bpip\b|\bpy\b|pandas|flask|django|fastapi/i,
  rust: /\brust\b|\bcargo\b/i,
  go: /\bgolang\b|\bgo mod\b/i,
  react: /\breact\b|\bjsx\b|next\.?js/i,
  sqlite: /\bsqlite\b/i,
  postgres: /\bpostgres\b|supabase/i,
  tailwind: /tailwind/i,
  docker: /\bdocker\b|compose\.ya?ml/i,
};

/**
 * Three to four concrete builds per theme. Each is a whole brief, because a
 * one-line title is not something you can send — the prompt is the product
 * here and the title is just how it is filed.
 */
const BY_THEME = {
  game: [
    {
      slugId: 'daily-puzzle',
      title: 'A daily puzzle with a shareable result',
      blurb: 'One puzzle a day, the same for everyone, with an emoji grid you can paste anywhere.',
      prompt: 'Build a daily puzzle game that runs entirely in the browser. Everyone gets '
        + 'the same puzzle on the same date, derived from the date itself so no server is '
        + 'needed. Keep a streak and a per-day history in localStorage, and add a "copy '
        + 'result" button that produces a spoiler-free emoji grid. Make it playable with '
        + 'the keyboard alone, and readable on a phone.',
    },
    {
      slugId: 'score-service',
      title: 'A high-score service your games can post to',
      blurb: 'One small API plus a drop-in client, so every game you make gets a leaderboard.',
      prompt: 'Build a tiny high-score service: a small API that accepts a score for a named '
        + 'game and returns the top ten, with a per-name rate limit so it cannot be spammed. '
        + 'Ship a one-file browser client that any of my games can drop in, and a demo page '
        + 'that shows a leaderboard using it.',
    },
    {
      slugId: 'local-versus',
      title: 'A two-player game on one keyboard',
      blurb: 'Same screen, two sets of keys, best of five — no networking to get wrong.',
      prompt: 'Build a two-player game played on one keyboard at the same screen — one player '
        + 'on WASD, the other on the arrows — with a best-of-five match, a round timer and a '
        + 'proper pause. No networking. Make the game loop fixed-timestep so it behaves the '
        + 'same on a slow machine.',
    },
    {
      slugId: 'physics-toy',
      title: 'A physics sandbox you can throw things around in',
      blurb: 'Drag, drop and fling shapes; no goal, just something that feels good.',
      prompt: 'Build a canvas physics sandbox: spawn shapes, drag and fling them, and watch '
        + 'them collide, with gravity and restitution on sliders. Write the integrator and '
        + 'collision handling myself rather than pulling in a physics library, and keep it at '
        + '60fps with a few hundred bodies.',
    },
  ],
  web: [
    {
      slugId: 'morning-page',
      title: 'A one-page dashboard for your morning',
      blurb: 'Weather, calendar, the three things you said you would do. One screen, no scroll.',
      prompt: 'Build a single-page morning dashboard: the weather for my city, today’s date, '
        + 'a three-item to-do list that resets daily, and a clock. One screen with no '
        + 'scrolling, works offline after the first load, and stores everything locally. '
        + 'Light and dark, following the system.',
    },
    {
      slugId: 'link-shelf',
      title: 'A link shelf with tags and instant search',
      blurb: 'Paste a URL, it fetches the title, tags it, and finds it again in one keystroke.',
      prompt: 'Build a link-saving page: paste a URL and it stores it with its title and '
        + 'favicon, tags are free-form, and search filters as I type across titles and tags. '
        + 'Import and export as JSON so nothing is trapped. All client-side.',
    },
    {
      slugId: 'scratchpad',
      title: 'A Markdown scratchpad that never loses anything',
      blurb: 'Type on the left, read on the right, every keystroke saved, full history.',
      prompt: 'Build a Markdown scratchpad: a split editor and preview, saved to localStorage '
        + 'on every keystroke, with a snapshot history I can scrub back through. Add a word '
        + 'count, a focus mode, and export to .md. No dependencies for the Markdown — write '
        + 'the small subset I need.',
    },
  ],
  cli: [
    {
      slugId: 'file-tidy',
      title: 'A CLI that tidies a folder by what the files actually are',
      blurb: 'Reads dates and types out of the files themselves, then sorts and renames.',
      prompt: 'Build a CLI that tidies a folder: read each file’s real type and its embedded '
        + 'date where it has one, then sort into dated subfolders and rename consistently. '
        + 'Default to a dry run that prints the plan, require a flag to actually move '
        + 'anything, and never overwrite — collisions get a suffix.',
    },
    {
      slugId: 'scaffolder',
      title: 'A scaffolder for the stack you keep re-typing',
      blurb: 'One command, and the project starts the way your last three did.',
      prompt: 'Build a project scaffolder for the stack I keep reaching for: one command '
        + 'creates the folder, the git repo, the gitignore, a test command that works, and a '
        + 'README skeleton. Templates live in files, not in strings in the code, so I can add '
        + 'one without touching the tool.',
    },
    {
      slugId: 'json-diff',
      title: 'A CLI that diffs two JSON files and says what moved',
      blurb: 'Not a text diff — a structural one, printed as paths that changed.',
      prompt: 'Build a CLI that diffs two JSON or YAML files structurally and prints the '
        + 'paths that were added, removed or changed, with colour when the output is a TTY '
        + 'and plain text when it is piped. Add a flag to ignore given key paths, and exit '
        + 'non-zero when there is a difference so it works in CI.',
    },
  ],
  api: [
    {
      slugId: 'shortener',
      title: 'A URL shortener with its own stats page',
      blurb: 'Short links, click counts over time, and nothing you have to log into.',
      prompt: 'Build a URL shortener: an endpoint that takes a long URL and returns a short '
        + 'code, a redirect that counts the hit, and a stats page per link showing clicks per '
        + 'day and referrers. Store it in SQLite, and make the admin side a single token in '
        + 'a header rather than a login.',
    },
    {
      slugId: 'webhook-relay',
      title: 'A webhook relay that replays what failed',
      blurb: 'Accept, store, forward, retry with backoff — and let you replay by hand.',
      prompt: 'Build a webhook relay: accept a POST, store the full payload, forward it to a '
        + 'configured target, and retry with exponential backoff on failure. Keep a log of '
        + 'every delivery with its status, and add an endpoint to replay one by id. Verify '
        + 'incoming signatures.',
    },
    {
      slugId: 'csv-api',
      title: 'An API that turns an uploaded CSV into something queryable',
      blurb: 'Upload a spreadsheet, get real endpoints over its rows.',
      prompt: 'Build a service where uploading a CSV gives me a queryable endpoint over its '
        + 'rows: filter by column, sort, paginate, and aggregate with count and sum. Infer '
        + 'column types on upload and say what it inferred. SQLite underneath, one file per '
        + 'upload.',
    },
  ],
  data: [
    {
      slugId: 'price-watch',
      title: 'A watcher that tracks one number over time',
      blurb: 'Scrape it on a schedule, keep the history, chart the trend, shout on a change.',
      prompt: 'Build a watcher that fetches one number from a page or an API on a schedule, '
        + 'appends it to a local database with a timestamp, and charts the history. Alert me '
        + 'when it crosses a threshold I set. Be polite about rate limits, and keep working '
        + 'when the page markup shifts slightly.',
    },
    {
      slugId: 'daily-log',
      title: 'A log of something you do every day',
      blurb: 'One number a day, stored properly, with the streak and the trend.',
      prompt: 'Build a tiny habit log: one entry a day with a number and an optional note, '
        + 'stored in SQLite, with a CLI to add and a page to read. Show the current streak, a '
        + 'rolling seven-day average, and a calendar heatmap of the last year.',
    },
    {
      slugId: 'csv-explorer',
      title: 'A CSV explorer that never uploads your file',
      blurb: 'Drop a spreadsheet on the page, sort and chart it, all in the tab.',
      prompt: 'Build a page where dropping a CSV gives me a sortable, filterable table and a '
        + 'chart of any numeric column, with everything parsed in the browser so the file '
        + 'never leaves the machine. Handle a few hundred thousand rows without freezing the '
        + 'tab, and say so clearly when a column is not what it looks like.',
    },
  ],
  viz: [
    {
      slugId: 'git-heatmap',
      title: 'A heatmap of your own git history',
      blurb: 'Reads the repos on your disk and shows where the work actually went.',
      prompt: 'Build a tool that reads the git history of the repos on my disk and renders a '
        + 'heatmap of commits by day, plus a breakdown per project and per hour of day. Read '
        + 'the repos locally, cache the parse, and output a single self-contained HTML file.',
    },
    {
      slugId: 'sparkline-kit',
      title: 'A no-dependency sparkline and meter kit',
      blurb: 'The three small charts you keep rewriting, done once and done well.',
      prompt: 'Build a dependency-free chart kit covering the three things I keep rewriting: '
        + 'a sparkline, a horizontal meter with a threshold, and a small bar strip. Plain SVG, '
        + 'accessible by default with a text alternative per chart, and themeable with CSS '
        + 'custom properties. Ship a demo page and tests on the scale maths.',
    },
  ],
  bot: [
    {
      slugId: 'digest-bot',
      title: 'A bot that posts you one digest a day',
      blurb: 'Pulls from the feeds you care about, posts once, never spams.',
      prompt: 'Build a bot that gathers from a few sources I configure — RSS, an API, a page '
        + 'it scrapes — and posts one digest a day to a channel. Deduplicate against what it '
        + 'has already sent, keep a local record, and fail loudly in its own log rather than '
        + 'silently going quiet.',
    },
    {
      slugId: 'page-watch',
      title: 'A change detector for pages that matter',
      blurb: 'Tells you what changed on a page, not just that something did.',
      prompt: 'Build a page-change watcher: fetch a URL on a schedule, extract the part I care '
        + 'about with a CSS selector, and notify me with a readable diff when it changes. '
        + 'Ignore whitespace and timestamp-only churn, and keep the last ten versions so I can '
        + 'see the history.',
    },
  ],
  ai: [
    {
      slugId: 'thread-ui',
      title: 'A local-first chat UI with threads you keep',
      blurb: 'Your own front end over the API, with search across everything you ever asked.',
      prompt: 'Build a local-first chat interface over the Claude API: streaming replies, '
        + 'threads stored on disk, full-text search across every message, and a visible token '
        + 'and cost counter per thread. Keep the API key out of the client bundle.',
    },
    {
      slugId: 'explain-error',
      title: 'A paste-an-error tool that explains it',
      blurb: 'Paste a stack trace, get the likely cause and the next thing to try.',
      prompt: 'Build a tool where I paste a stack trace or build error and get back the likely '
        + 'cause, the file to look at first, and two things to try, with the prompt kept small '
        + 'by trimming the trace to the frames that matter. Cache by hash so the same error '
        + 'costs nothing twice.',
    },
  ],
  mobile: [
    {
      slugId: 'offline-pwa',
      title: 'A PWA that works with no signal and syncs later',
      blurb: 'Writes queue up offline and reconcile when you are back, without losing edits.',
      prompt: 'Build an installable PWA for something I track on my phone, designed offline '
        + 'first: writes queue locally and sync when the connection returns, with explicit '
        + 'conflict handling rather than last-write-wins. Show the sync state in the UI, and '
        + 'make the install prompt and the offline shell actually work.',
    },
  ],
  tool: [
    {
      slugId: 'pre-commit',
      title: 'A pre-commit hook for the mistakes you actually make',
      blurb: 'Blocks the committed secret, the stray debugger, the file you meant to ignore.',
      prompt: 'Build a pre-commit hook that catches the mistakes I actually make: a committed '
        + 'secret, a left-in debugger or console.log, a file that should have been ignored, a '
        + 'test that is skipped. Fast enough to never be annoying, installable with one '
        + 'command, and with a documented way to override for a single commit.',
    },
    {
      slugId: 'repo-audit',
      title: 'A one-command audit of every repo you own',
      blurb: 'Which have tests, which have a README, which have not been pushed.',
      prompt: 'Build a tool that walks every repo on my disk and reports a table: has tests, '
        + 'has a README, has a remote, has uncommitted changes, last commit date. Sort by what '
        + 'needs attention most, and add a flag that outputs Markdown so I can paste it.',
    },
  ],
};

/**
 * Builds that only make sense once you have worked in two areas — the whole
 * point of reading the account rather than a list.
 */
const COMBOS = [
  {
    slugId: 'leaderboard-dash',
    needs: ['game', 'viz'],
    icon: 'chart', tags: ['game', 'viz'],
    title: 'A leaderboard with charts for your games',
    blurb: 'Scores in, a dashboard out — the two things you have both built, joined up.',
    prompt: 'Build a leaderboard dashboard for my games: an endpoint games post scores to, '
      + 'and a dashboard showing top scores, scores over time, and how many people played '
      + 'each day. One service, SQLite behind it, and a client snippet a game can drop in.',
  },
  {
    slugId: 'cli-over-api',
    needs: ['cli', 'api'],
    icon: 'terminal', tags: ['cli', 'api'],
    title: 'A CLI that drives your own API',
    blurb: 'The server you built, usable from a terminal without curl gymnastics.',
    prompt: 'Build a CLI client for my own API: subcommands per resource, a config file for '
      + 'the base URL and token, table output by default and --json for piping. Generate the '
      + 'subcommands from the API’s own schema if it has one.',
  },
  {
    slugId: 'collected-dash',
    needs: ['data', 'viz'],
    icon: 'chart', tags: ['data', 'viz'],
    title: 'A dashboard over the data you already collect',
    blurb: 'You are already storing it; this is the page that makes it mean something.',
    prompt: 'Build a dashboard over data I am already collecting: one page, a handful of '
      + 'charts chosen for the shape of each field, a date-range picker, and a cached query '
      + 'layer so it stays fast as the table grows. Pick the chart type from the data, and '
      + 'say in words what each one shows.',
  },
  {
    slugId: 'scheduled-scrape',
    needs: ['bot', 'data'],
    icon: 'bot', tags: ['bot', 'data'],
    title: 'A scheduled collector with a trend it can report',
    blurb: 'The automation you write and the data you keep, as one job.',
    prompt: 'Build a scheduled collector: gather a handful of numbers from the sources I '
      + 'configure, store each run with a timestamp, and post a weekly summary saying what '
      + 'moved and by how much. Keep the schedule and the sources in one config file, and '
      + 'make a failed source a logged warning rather than a dead run.',
  },
  {
    slugId: 'ai-in-browser',
    needs: ['web', 'ai'],
    icon: 'brain', tags: ['web', 'ai'],
    title: 'A browser tool with a model behind one button',
    blurb: 'A page that does something useful on its own, and better when you ask it to.',
    prompt: 'Build a browser tool that works perfectly well on its own and gets better with '
      + 'one button that calls a model — the model is an enhancement, never the critical '
      + 'path. Stream the response into the page, keep the key on a small proxy rather than '
      + 'in the client, and degrade cleanly when the call fails.',
  },
  {
    slugId: 'web-front-for-cli',
    needs: ['web', 'cli'],
    icon: 'globe', tags: ['web', 'cli'],
    title: 'A browser front end for one of your CLIs',
    blurb: 'The tool is good; this is the version you can send someone.',
    prompt: 'Build a browser front end for a CLI I already have: the same options as form '
      + 'controls, the command it would run shown as text I can copy, and the output '
      + 'streamed into the page. Run the work in a small local server the page talks to, and '
      + 'keep the CLI the source of truth rather than duplicating its logic.',
  },
  {
    slugId: 'api-over-collected',
    needs: ['api', 'data'],
    icon: 'server', tags: ['api', 'data'],
    title: 'An API over the data you have been collecting',
    blurb: 'Your own store, queryable by something other than you at a terminal.',
    prompt: 'Build a read API over data I am already collecting: filter, sort, paginate and '
      + 'aggregate, with a cursor rather than offset paging, caching headers that are '
      + 'actually correct, and a generated reference page listing every parameter.',
  },
  {
    slugId: 'game-on-phone',
    needs: ['game', 'mobile'],
    icon: 'phone', tags: ['game', 'mobile'],
    title: 'One of your games, installable on a phone',
    blurb: 'Touch controls, offline, and an icon on the home screen.',
    prompt: 'Turn a browser game into an installable PWA that plays properly on a phone: '
      + 'touch controls that do not fight the browser’s own gestures, no scroll or zoom '
      + 'during play, offline after first load, and scores kept locally. Handle being '
      + 'backgrounded mid-game without corrupting the state.',
  },
  {
    slugId: 'pwa-over-api',
    needs: ['mobile', 'api'],
    icon: 'phone', tags: ['mobile', 'api'],
    title: 'A phone front end for the API you already run',
    blurb: 'You built the server; this is the thing you actually open on the bus.',
    prompt: 'Build an installable phone front end for an API I already run: list, detail and '
      + 'one write action, cached for offline reading, with the write queued when there is no '
      + 'signal. Thumb-reachable controls, and a visible sync state.',
  },
];

/**
 * Builds suggested by the shape of the account rather than its topics — the
 * sort of thing you only notice when you can see everything at once.
 */
const SHAPE = [
  // No "index of every project" here any more: the Projects screen is one.
  {
    slugId: 'push-everything',
    icon: 'upload', tags: ['cli', 'git'],
    when: (a) => a.localOnly.length >= 2,
    title: 'A script that gets every local-only project onto GitHub',
    why: (a) => `${plural(a.localOnly.length, 'project')} exist only on your desktop`,
    blurb: 'Walks the folders, creates what is missing, pushes, and reports what it did.',
    prompt: 'Build a script that finds every git repo on my disk with no remote, and for each '
      + 'one creates a GitHub repository and pushes it — private by default, with a gitignore '
      + 'that fits the stack if there is not one already. Dry run first, print a table of '
      + 'what it would do, and require a flag to act.',
  },
  {
    slugId: 'shared-test-kit',
    icon: 'beaker', tags: ['tooling', 'tests'],
    when: (a) => a.untested >= 2,
    title: 'A test setup you can drop into any of your projects',
    why: (a) => `${plural(a.untested, 'project')} with nothing covered`,
    blurb: 'One command, no framework install, the same shape of suite everywhere.',
    prompt: 'Build a minimal test harness I can drop into any of my projects: a single '
      + 'command that discovers and runs test files, prints a readable summary, exits '
      + 'non-zero on failure, and needs no dependencies. Include the few assertions I '
      + 'actually use and a watch mode.',
  },
  {
    slugId: 'failure-postmortem',
    icon: 'wrench', tags: ['tooling'],
    when: (a) => a.failed >= 2,
    title: 'A tool that reads your failed runs and finds the pattern',
    why: (a) => `${plural(a.failed, 'run')} failed so far`,
    blurb: 'Groups the errors you have actually hit, so the next one is already solved.',
    prompt: 'Build a tool that collects the error output of my failed builds and runs, groups '
      + 'them by root cause with a fingerprint rather than an exact string match, and writes '
      + 'a short playbook entry per group — what it was, what fixed it. Make adding a new '
      + 'failure one command.',
  },
];

/** Openers for an account with nothing to go on yet. */
const OPENERS = [
  {
    slugId: 'snake',
    title: 'A browser snake game with a high-score list',
    blurb: 'The classic, playable on a phone, scores kept locally.',
    prompt: 'Build a snake game that runs in the browser and plays well on a phone: swipe or '
      + 'arrows, a high-score list in localStorage, a pause, and a fixed-timestep loop so it '
      + 'is the same speed everywhere.',
  },
  {
    slugId: 'webp',
    title: 'A CLI that converts any new image to WebP',
    blurb: 'Watches a folder, converts what lands, leaves the original alone.',
    prompt: 'Build a CLI that watches a folder and converts any image that lands in it to '
      + 'WebP at a quality I set, writing alongside the original and never overwriting. Add a '
      + 'one-shot mode for a whole directory, and print what it saved.',
  },
  {
    slugId: 'books',
    title: 'A reading log with a real database behind it',
    blurb: 'Add a book, rate it, see what you actually finished this year.',
    prompt: 'Build a small REST API and a page for tracking books I have read: title, author, '
      + 'finished date, rating, a note. SQLite behind it, a proper migration on startup, and '
      + 'a year-in-review view that counts what I finished.',
  },
  {
    slugId: 'weather',
    title: 'A weather page for your city, deployed',
    blurb: 'One place, one glance, live on the internet rather than on your desktop.',
    prompt: 'Build a static page showing the weather for my city — now, today’s range, and '
      + 'the next three days — from a free API, ready to go live on the web.',
  },
];

// ── reading the account ───────────────────────────────────────────────

/** One project's words: its name, every prompt, every summary written back. */
function corpusOf(slug, jobs, summaries) {
  const mine = jobs.filter((j) => j.project_slug === slug);
  return [
    slug.replace(/[-_]/g, ' '),
    ...mine.map((j) => j.prompt ?? ''),
    ...mine.map((j) => summaries.get(j.id) ?? ''),
  ].join('\n');
}

/**
 * What the account looks like: which themes you work in and which projects
 * are the evidence, which stacks you use, and the few counts the shape ideas
 * read. Exported because it is the interesting half — the view prints it.
 */
export function profile({ jobs = [], projects = [], summaries = new Map() } = {}) {
  const slugs = [...new Set([
    ...jobs.map((j) => j.project_slug).filter(Boolean),
    ...projects.map((p) => p.name),
  ])];

  const themes = new Map();          // theme key -> [slug]
  const untestedProbe = /\btests?\b|\btesting\b|vitest|jest|pytest|mocha|playwright/i;
  const worked = new Set(jobs.map((j) => j.project_slug).filter(Boolean));
  let untested = 0;

  for (const slug of slugs) {
    const words = corpusOf(slug, jobs, summaries);
    for (const [key, theme] of Object.entries(THEMES)) {
      if (!theme.probe.test(words)) continue;
      if (themes.has(key)) themes.get(key).push(slug);
      else themes.set(key, [slug]);
    }
    // A repo you have never run a job against says nothing about tests.
    if (worked.has(slug) && !untestedProbe.test(words)) untested++;
  }

  const allWords = slugs.map((s) => corpusOf(s, jobs, summaries)).join('\n');
  const stack = Object.entries(STACK).filter(([, re]) => re.test(allWords)).map(([k]) => k);

  // Broadest evidence first — the thing you clearly do is the thing to build
  // more of, and ties keep the order THEMES is declared in.
  const ranked = [...themes.entries()].sort((a, b) => b[1].length - a[1].length);

  return {
    slugs,
    themes,
    ranked,
    stack,
    projects,
    localOnly: projects.filter((p) => p.is_local && !p.full_name),
    untested,
    failed: jobs.filter((j) => j.status === 'error').length,
  };
}

/** "because you built alpha and beta" — the evidence, never more than three. */
function evidence(slugs) {
  const names = slugs.slice(0, 3);
  const rest = slugs.length - names.length;
  const list = names.length > 1
    ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
    : names[0];
  return rest > 0 ? `${list} +${rest}` : list;
}

/** A closing line that aims the brief at tools you have already used. */
const stackLine = (stack) => (stack.length
  ? `\n\nWhere it fits, stay in the stack I already use: ${stack.slice(0, 4).join(', ')}.`
  : '');

/**
 * New builds, derived from the account, best-evidenced first and spread
 * across themes so the first screenful isn't four variations on one idea.
 *
 * Shape matches `suggest()` on purpose — id, icon, slug, title, why, prompt —
 * so a view can render either and the one click handler serves both. `slug`
 * is always null: these are new projects, so they open the composer empty.
 */
export function ideas({ jobs = [], projects = [], summaries = new Map(), limit = 24 } = {}) {
  const p = profile({ jobs, projects, summaries });
  const tail = stackLine(p.stack);
  const out = [];

  // 1. Per theme, round-robin so breadth comes before depth.
  const queues = p.ranked.map(([key, from]) => (BY_THEME[key] ?? []).map((it, i) => ({
    id: `idea:${key}:${it.slugId}`,
    kind: 'idea',
    theme: key,
    icon: THEMES[key].icon,
    tags: [THEMES[key].tag],
    slug: null,
    from,
    weight: 900 - i * 100 + Math.min(from.length, 5) * 8,
    title: it.title,
    blurb: it.blurb,
    why: `you work on ${THEMES[key].label} — ${evidence(from)}`,
    prompt: it.prompt + tail,
  })));

  const rounds = Math.max(0, ...queues.map((q) => q.length));
  for (let i = 0; i < rounds; i++) {
    out.push(...queues.map((q) => q[i]).filter(Boolean).sort((a, b) => b.weight - a.weight));
  }

  // 2. Combos: only offered when both halves are things you actually do.
  for (const c of COMBOS) {
    if (!c.needs.every((k) => p.themes.has(k))) continue;
    const from = [...new Set(c.needs.flatMap((k) => p.themes.get(k)))];
    out.push({
      id: `idea:combo:${c.slugId}`,
      kind: 'combo',
      theme: c.needs[0],
      icon: c.icon,
      tags: c.tags,
      slug: null,
      from,
      weight: 860,
      title: c.title,
      blurb: c.blurb,
      why: from.length > 1
        ? `you have built both — ${evidence(from)}`
        : `both halves already show up in ${from[0]}`,
      prompt: c.prompt + tail,
    });
  }

  // 3. Shape: what the account looks like from above.
  for (const s of SHAPE) {
    if (!s.when(p)) continue;
    out.push({
      id: `idea:shape:${s.slugId}`,
      kind: 'shape',
      theme: null,
      icon: s.icon,
      tags: s.tags,
      slug: null,
      from: p.slugs.slice(0, 3),
      weight: 850,
      title: s.title,
      blurb: s.blurb,
      why: s.why(p),
      prompt: s.prompt + tail,
    });
  }

  // 4. Nothing much to go on: openers, so the view is never empty. Not
  //    padding — once there are real ideas they would only dilute them, so
  //    the bar is "this would look broken", not "this could be longer".
  if (out.length < 3) {
    for (const o of OPENERS) {
      out.push({
        id: `idea:opener:${o.slugId}`,
        kind: 'opener',
        theme: null,
        icon: 'bulb',
        tags: ['starter'],
        slug: null,
        from: [],
        weight: 0,
        title: o.title,
        blurb: o.blurb,
        why: 'somewhere to start',
        prompt: o.prompt,
      });
    }
  }

  // Weights are banded so the sort is stable *and* meaningful: a theme's
  // first idea (900s) outranks every theme's second (800s), with combos and
  // shapes slotted between the bands. Breadth before depth, by construction.
  const seen = new Set();
  return out
    .filter((it) => !seen.has(it.id) && seen.add(it.id))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

/** The themes the account actually shows, for a filter row or a sentence. */
export const themeLabel = (key) => THEMES[key]?.label ?? key;
