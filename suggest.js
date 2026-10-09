// What to build next, read off what you have already built.
//
// Every suggestion is derived from data the dashboard already holds — the
// prompts you sent, how each run ended, and what your desktop reports about
// the repo. Nothing here calls out to a model: it is a handful of signals
// ("this project has no tests yet", "its last run failed") turned into a
// ready-to-send prompt, with the reason shown next to it so you can tell why
// it is being offered.

import { clip, firstLine } from './util.js';

const ACTIVE = new Set(['queued', 'running', 'paused']);

/** Keyword probes over everything that has been said about one project. */
const PROBES = {
  docs:   /\breadme\b|\bdocs?\b|document(ation|ed|s)?\b/i,
  tests:  /\btests?\b|\btesting\b|vitest|jest|pytest|mocha|playwright|npm test/i,
  ci:     /\bci\b|github action|workflow|pipeline|continuous integration/i,
  deploy: /\bdeploy|\bpages\b|netlify|vercel|cloudflare|\bhost(ing|ed)\b|\bpublish/i,
  web:    /\bsite\b|\bweb\b|browser|\bhtml\b|\bcss\b|\bpage\b|\bgame\b|dashboard|react|svelte|\bvue\b|frontend|\bui\b/i,
};

const STARTERS = [
  'Build a snake game I can play in the browser, with a high-score list.',
  'A CLI that watches a folder and converts any new image to WebP.',
  'A small REST API for tracking books I have read, with SQLite behind it.',
  'A static site that shows the weather for my city, live on the web.',
];

/**
 * The recipes, in the order they earn their place. `when` sees one project's
 * digest; the first couple that match become its suggestions.
 */
const RECIPES = [
  {
    kind: 'fix',
    icon: 'wrench',
    weight: 100,
    when: (p) => p.last?.status === 'error',
    title: (p) => `Fix what broke in ${p.slug}`,
    why: (p) => (p.last.error ? `last run failed — ${clip(p.last.error, 64)}` : 'its last run failed'),
    prompt: (p) => `The last run failed${p.last.error ? ` with:\n\n${p.last.error}\n` : '.'}\n`
      + 'Find the cause, fix it, then prove the fix by running the project.',
  },
  {
    kind: 'publish',
    icon: 'upload',
    weight: 80,
    when: (p) => p.done && p.local && !p.remote,
    title: (p) => `Put ${p.slug} on GitHub`,
    why: () => 'it only exists on your desktop',
    prompt: () => 'Create a GitHub repository for this project and push it, with a '
      + '.gitignore that fits the stack and a one-line description on the repo.',
  },
  {
    kind: 'docs',
    icon: 'doc',
    weight: 70,
    when: (p) => p.done && !p.has.docs,
    title: (p) => `Write a README for ${p.slug}`,
    why: () => 'no README has come up yet',
    prompt: () => 'Write a README.md covering what this project is, how to run it, how the '
      + 'code is laid out, and anything surprising about it. Keep it short and honest.',
  },
  {
    kind: 'tests',
    icon: 'beaker',
    weight: 65,
    when: (p) => p.done && !p.has.tests,
    title: (p) => `Add tests to ${p.slug}`,
    why: () => 'nothing is covered by tests yet',
    prompt: () => 'Add a small test suite that covers the core behaviour, plus one command '
      + 'that runs it. Keep it fast and dependency-light, and make it fail loudly.',
  },
  {
    kind: 'ci',
    icon: 'flow',
    weight: 55,
    when: (p) => p.done && p.has.tests && !p.has.ci && p.remote,
    title: (p) => `Run ${p.slug}'s tests on every push`,
    why: () => 'it has tests but no CI',
    prompt: () => 'Add a GitHub Actions workflow that installs dependencies and runs the '
      + 'tests on every push and pull request, then add the status badge to the README.',
  },
  {
    kind: 'deploy',
    icon: 'rocket',
    weight: 50,
    // The host's own record beats the keyword probe: a live link means it is
    // deployed, whatever the prompts did or didn't say.
    when: (p) => p.done && p.has.web && !p.has.deploy && !p.live && p.remote,
    title: (p) => `Put ${p.slug} online`,
    why: () => 'it runs in a browser but nothing is deployed',
    prompt: () => 'Put this online: prepare it for Fly.io with a Dockerfile and a fly.toml, '
      + 'so the desktop deploys it when this run finishes. Say in the README that it is '
      + 'deployed to Fly.io.',
  },
  {
    kind: 'review',
    icon: 'eye',
    weight: 45,
    when: (p) => !p.thread.length,
    title: (p) => `Take a look at ${p.slug}`,
    why: () => 'a repo you have never run a job against',
    prompt: () => 'Read this project and write a short summary of what it does, then list '
      + 'the three highest-value improvements you would make, with a reason for each.',
  },
  {
    kind: 'polish',
    icon: 'wand',
    weight: 30,
    when: (p) => p.done && p.thread.length >= 2,
    title: (p) => `Tighten up ${p.slug}`,
    why: (p) => `${p.thread.length} runs in — worth a cleanup pass`,
    prompt: () => 'Review the code for dead code, duplication and rough edges, then make '
      + 'the smallest set of changes that improves it without changing behaviour.',
  },
];

/** Everything the recipes need to know about one project, in one object. */
function digest(slug, jobs, projects, summaries) {
  const thread = jobs.filter((j) => j.project_slug === slug)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const project = projects.find((p) => p.name === slug) ?? null;
  const corpus = [
    slug,
    ...thread.map((j) => j.prompt ?? ''),
    ...thread.map((j) => summaries.get(j.id) ?? ''),
  ].join('\n');

  return {
    slug,
    project,
    thread,
    last: thread.at(-1) ?? null,
    busy: thread.some((j) => ACTIVE.has(j.status)),
    done: thread.some((j) => j.status === 'done'),
    local: Boolean(project?.is_local),
    remote: Boolean(project?.full_name),
    live: Boolean(project?.live_url) || thread.some((j) => j.live_url),
    has: Object.fromEntries(Object.entries(PROBES).map(([k, re]) => [k, re.test(corpus)])),
  };
}

/**
 * Suggestions for the whole account, best first and spread across projects so
 * one busy repo can't fill the list.
 *
 * `summaries` is an optional jobId → summary-text map; it only sharpens the
 * keyword probes, so a caller whose logs aren't loaded yet still gets sane
 * answers out of the prompts alone.
 */
export function suggest({ jobs = [], projects = [], summaries = new Map(), limit = 6 } = {}) {
  const slugs = [...new Set([
    ...jobs.map((j) => j.project_slug).filter(Boolean),
    ...projects.map((p) => p.name),
  ])];

  // A project the host can no longer see anywhere has nothing left to build on.
  const live = (slug) => !projects.length || projects.some((p) => p.name === slug);

  const perProject = slugs.filter(live).map((slug) => {
    const d = digest(slug, jobs, projects, summaries);
    if (d.busy) return [];                      // already working — leave it alone
    return RECIPES.filter((r) => r.when(d)).slice(0, 2).map((r) => ({
      id: `${r.kind}:${slug}`,
      kind: r.kind,
      icon: r.icon,
      slug,
      weight: r.weight,
      title: r.title(d),
      why: r.why(d),
      prompt: r.prompt(d).trim(),
    }));
  });

  // Round-robin one per project, so the first screenful spans your work.
  const rounds = Math.max(0, ...perProject.map((list) => list.length));
  const out = [];
  for (let i = 0; i < rounds; i++) {
    out.push(...perProject.map((list) => list[i]).filter(Boolean)
      .sort((a, b) => b.weight - a.weight));
  }

  // A thin list gets topped up with openers, so the view is never half-empty.
  if (out.length < limit) {
    for (const text of STARTERS) {
      out.push({
        id: `starter:${text.slice(0, 24)}`,
        kind: 'starter',
        icon: 'spark',
        slug: null,
        weight: 0,
        title: firstLine(text),
        why: 'a fresh project',
        prompt: text,
      });
    }
  }

  return out.slice(0, limit);
}
