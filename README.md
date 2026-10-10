# claude-remote — dashboard

The phone half of **claude-remote**: a small web app for queueing coding jobs to
the Claude Code runner on your desktop, and watching them work from anywhere.

You type what to build. The job lands in Supabase. Your desktop picks it up,
creates the repo, writes the code, pushes it — and streams its log back here
while it does. This repo is only the dashboard; the runner that claims jobs and
drives Claude Code lives on the PC.

```
┌──────────┐   insert job    ┌──────────┐   claim job    ┌─────────────┐
│ this app │ ──────────────▶ │ Supabase │ ◀───────────── │ desktop     │
│  (phone) │ ◀────────────── │          │ ─────────────▶ │ runner      │
└──────────┘  realtime log   └──────────┘  log + status  └─────────────┘
```

## What it gives you

- **Home** — one hero figure (agents running right now) over the line that says
  what the lead agent is doing this second, the live runs, the limit that will
  stop you first, what to do next, and four counts with their context. The rest
  — the fortnight of runs, the finished jobs, the desktop itself — is one tap
  behind *More detail* on a phone and the right-hand column on a wide screen.
  See [Less on screen at once](#less-on-screen-at-once).
- **Several agents at once** — `#/agents` is the fleet: a card per agent with
  what it is doing this second and the tail of its own log, a ceiling you set
  (1–6) that your desktop claims against, and a queue where every job says what
  it is waiting for — a free slot, its own project, or a desktop that isn't
  there. See [Several agents at once](#several-agents-at-once).
- **Suggestions from your own work** — "fix what broke in beta", "put gamma on
  GitHub", "write a README for alpha", each shown with the reason it was
  offered. Tap one and it opens that project's chat with the prompt loaded; you
  still press send. See [Where suggestions come from](#where-suggestions-come-from).
- **An Ideas screen full of things to build** — `#/ideas` is the long version:
  every next step for what you already have, plus whole new projects derived
  from the kinds of thing you build. It opens by showing you what it read —
  "games: alpha · command-line tools: gamma · browser apps: beta" — then offers
  builds that follow from it, each citing the projects that earned it a place.
  See [Where the ideas come from](#where-the-ideas-come-from).
- **Every project, and where it's live** — `#/projects` lists every repo on
  your GitHub account and every folder on your desktop, one card each: what it
  is, its language, when it last moved, how many runs it has had, and its live
  link if it has one. Search, filter by language or to what's live, sort by
  recent or A–Z. A web project built from here is put on Fly.io when its run
  finishes, so its link shows up without you doing anything.
  See [Where the projects come from](#where-the-projects-come-from).
- **Limits that say *when*** — a meter per window with the percentage, the
  headroom left, the severity in a word, and the reset as a **day and a time**
  with a live countdown: "resets Sat 6:20 p.m. · in 2d 19h". The tightest window
  also rides in the topbar, so a weekly cap is never a surprise. The block says
  when it last read and when the numbers last moved, because a stuck meter and
  a quiet account look identical otherwise.
- **A chat per project** — your prompts and the agent's replies in one thread,
  with its summary rendered as Markdown, a live log while it works, and a folded
  log once it's done. Each reply carries the facts it ran with — effort, usage
  cap, turns — and the header totals the project: runs, done, failed, turns,
  last activity. Stop a run, copy a summary or log, or load an old prompt back
  into the composer to run it again.
- **Live everything** — jobs and log lines arrive over Supabase realtime, so
  nothing needs refreshing. Usage is polled every ten seconds as well, since
  realtime on `usage_windows` depends on that table being in the publication.
  A finished job raises a toast; the running count shows up in the tab title
  and on the installed app's icon.
- **Tell me when it's done** — the bell in the sidebar footer turns on browser
  notifications, which fire only while the page is in the background. No push
  server is involved; nothing is sent anywhere.
- **Light and dark** — follows the system by default, with a three-way switch in
  the sidebar footer. Both themes were picked for contrast, not inverted, and
  `npm run contrast` fails the build if one of them stops clearing it.
- **Installable** — a PWA with an offline shell, so it opens instantly and still
  shows the last synced state with no signal.

## Running it

No build step. It is plain ES modules, served as files.

```sh
cp config.example.js config.js     # then fill in your Supabase URL + anon key
npm install                        # only needed for the tests
npm run serve                      # → http://localhost:5173
```

It must be served over http:// — ES modules and the service worker don't work
from `file://`. Any static host will do: GitHub Pages, Netlify, Cloudflare
Pages, `python -m http.server`.

Both values in `config.js` are safe to publish. The anon key only grants what
row-level security allows, and every policy is scoped to `auth.uid()`. The
service-role key must never appear there.

### On the web

`Dockerfile` and `fly.toml` are here, so this deploys to Fly.io as it stands:

```sh
fly launch --no-deploy     # first time only
fly deploy
```

The image is `node:22-alpine` with the files copied in and `tools/serve.mjs`
as the server — the same dependency-free static server `npm run serve` uses,
reading `PORT` (8080 in the container) and binding `0.0.0.0`. No build step.

**It needs no secrets.** `config.js` is publishable by design — the anon key
only grants what row-level security allows — so the app boots with nothing
set and there is no `fly secrets set` to run. Pointing a deployment at a
different Supabase project means editing `config.js`, because a static file
is read by the browser, not by the container.

### On a phone

Open the URL, then **Add to Home Screen**. Sign in *inside that app* — on iOS a
home-screen install gets its own storage, separate from Safari, so a session
created in the browser is not visible to it. If storage is blocked entirely
(Private tabs do this), the sign-in screen says so rather than silently failing.

## Several agents at once

Queueing more than one job was never the problem; saying how many should
*run* together was. `#/agents` is that screen, and the number on it is a real
setting rather than a label:

- **A ceiling, 1 to 6.** It is written to a `settings` row in Supabase, so it
  follows you between devices — and so the desktop runner can read it and
  claim that many queued jobs at a time.
- **A slot is an agent.** One that paused on your usage cap keeps its slot: it
  resumes where it left off rather than starting over.
- **One agent per project.** Two agents in one folder would fight over the same
  working copy, so a second job on a busy project waits for the first.

Which is why nothing here is ever just "queued". A waiting job says *waiting
for a free slot · 2 ahead*, or *waiting for gamma to finish*, or *your desktop
is offline*. `fleet.js` is that arithmetic, pure and unit-tested, because
"waiting for a slot" while the desktop sits idle is worse than a crash.

Each agent gets a card — the live activity line, the last lines of its log,
the effort and cap it ran with, its thread, and a stop. **Stop all** appears
once there are two. The hero figure is the running count and the pips under it
are the slots: filled is an agent, outlined is room for another, and the count
beside them says the same thing in words.

### The table it wants

```sql
create table if not exists settings (
  owner        uuid primary key references auth.users on delete cascade,
  max_parallel int  not null default 3 check (max_parallel between 1 and 6),
  updated_at   timestamptz not null default now()
);
alter table settings enable row level security;
create policy "own settings" on settings
  for all using (auth.uid() = owner) with check (auth.uid() = owner);
```

Nothing is written until you tap a number, and the hint under the control says
which of the three states you are in: published, not published yet, or kept on
this device because the table isn't there. The other half is the runner — claiming up to `max_parallel` jobs, one per project
folder — and it lives in the agent-host repo. A runner that predates the
setting ignores it and keeps working one job at a time; you would see the
queue stack up behind it on this screen, which is the honest picture either
way.

## Less on screen at once

The phone was carrying eight stacked blocks on home and a drawer as the only
way between screens. What changed:

- **Bottom tabs on narrow screens** — Home · Agents · New · Projects · Ideas.
  They own the bottom of the window on every view you don't type into, and
  step aside for the composer on the two you do, so the two never stack up.
- **Home leads rather than lists.** Three live rows and a door to the rest.
  The limits block leads with the window that will actually stop you and folds
  the others behind their own count. The activity strip, the finished runs and
  the desktop card sit behind one *More detail* toggle.
- **Tighter under 600px** — a smaller hero figure, denser tiles, less padding
  everywhere, two log lines on an agent card instead of three.

Nothing was dropped to make room. A wide screen still opens with all of it, as
the two-column dashboard it was; everything else is one tap away.

## Where suggestions come from

`suggest.js` is a few rules over data the dashboard already has — no model is
called, nothing leaves the page. For each project it builds a digest (the
thread, how the last run ended, whether the repo is local-only, and a keyword
probe over every prompt and summary) and runs the recipes against it:

| It notices | It offers |
|---|---|
| the last run failed | **Fix what broke in X** — with the real error pasted into the prompt |
| finished, but only on your desktop | **Put X on GitHub** |
| finished, and no README has come up | **Write a README for X** |
| finished, and nothing has mentioned tests | **Add tests to X** |
| has tests, has a remote, no workflow | **Run X's tests on every push** |
| browser-ish, nothing deployed | **Put X online** |
| a repo you have never run a job against | **Take a look at X** |
| several runs in, nothing else to say | **Tighten up X** |

A project with a job in flight is skipped — it's already busy. No project
contributes more than two, the list round-robins so the first screenful spans
your work, and if it comes up short it is topped up with openers for a fresh
project. A project your desktop can no longer see is never suggested.

The probes are deliberately crude (`/\btests?\b/` and friends over the prompts
and summaries), so a project whose README job you ran before connecting this
dashboard may still be offered one. Dismissing is one tap: send something else.

## Where the ideas come from

`suggest.js` answers *what next for this repo?*. `ideas.js` answers the other
question — *what should I build at all?* — off the same corpus: every prompt you
have sent and every summary an agent wrote back. Also pure, also no model.

Ten themes are matched against each project's words. A hit means that project is
evidence for that theme, and the themes you actually work in are what the view
is built from:

| Theme | Found by words like |
|---|---|
| games | game, snake, arcade, player, high-score |
| browser apps | site, html, css, react, landing |
| command-line tools | cli, terminal, argv, flags, stdout |
| APIs and servers | api, rest, endpoint, express, webhook |
| data wrangling | scrape, csv, sqlite, dataset, query |
| dashboards and charts | dashboard, chart, plot, visualise |
| bots and automations | bot, discord, cron, watcher, notify |
| AI projects | llm, prompt, embedding, agent, tokens |
| phone-first apps | pwa, mobile, offline-first, service worker |
| developer tooling | linter, bundler, codegen, pre-commit |

From those it builds four kinds of thing:

- **Per theme** — three or four concrete projects each, round-robined so the
  first screenful spans your interests rather than being four variations on
  one. *"you work on command-line tools — gamma"*.
- **Combos** — offered only when both halves are things you have actually
  built. Games *and* charts gets you a leaderboard with charts; a CLI *and* an
  API gets you a CLI that drives it.
- **Shape** — what the account looks like from above: two projects that exist
  only on your desktop, two with nothing tested, two runs that failed. These
  cite the count, not a project.
- **Openers** — only when there is genuinely nothing to read off. A fallback,
  not padding: once there are real ideas, openers would only dilute them.

Each one is a whole brief rather than a title, because the brief is the thing
you send. If a stack shows up in your work — node, python, sqlite, react — the
brief says to stay in it.

Same caveats as the suggestions, and one more: a theme only registers if it came
up *in words*. A project whose topic was never written down anywhere won't be
counted, which is why the view opens by showing you exactly what it did read.

## Where the projects come from

The desktop runner writes them. Every few minutes it lists your GitHub repos and
the folders in its workspace into the `projects` table, and for each one fills
in what this screen shows:

| Field | Read from |
|---|---|
| description | the GitHub description, or else the README's first real paragraph |
| language | GitHub's primary language |
| live link | the repo's homepage, else a deployed Fly app its `fly.toml` names, else GitHub Pages |

`catalog.js` adds the dashboard's own half — the runs each project has had, and
whether one is in flight — and a project being built right now gets a card
before the runner has listed it. A finished job re-reads the list, because the
runner deploys and re-syncs before it marks a job done: the new live link is
already there.

A **site** button appears on a project's chat header, and on the reply whose
run deployed it. A live link only ever becomes a link if it is `http(s)://`.

The description and live-link columns come from the "project catalogue" block
of the runner's `supabase/schema.sql`. Without it the screen still lists every
project, it just has less to say about each.

## Tests

```sh
npm test            # contrast guard, then the app in jsdom
npm run contrast    # just the colour claims
```

Boots the real app in jsdom against a fake Supabase and walks the screens: sign
in, home, a project thread, sending a follow-up, stopping a run, a job finishing
over realtime, the new-project flow, the agents view (a second agent arriving
mid-watch, a live log line landing on its card, the ceiling changed from another
device and published from this one, a job queued behind its own project, stop
all), the phone layout (home folding its reference blocks, the limits block
leading with the tightest window, tabs and composer never sharing the bottom of
the window), the ideas view and its filters, the projects view with its search,
filters and sort, re-reading and failing to read the limits, clearing a chat,
the drawer, keyboard shortcuts, theming, and the Markdown renderer. It also checks the static invariants a
vanilla app has no compiler for — every `$('id')` exists in the HTML, every icon
referenced is in the sprite, every module is listed in the service-worker shell,
and the recurring timer still re-reads usage (it stopped once, and nothing else
in here would have noticed).

Five things get unit coverage against fixed inputs rather than fixtures,
because a plausible-looking wrong answer is worse there than a crash: the reset
labels (`dayClock`, `until`, `span` — a weekly limit must never claim it resets
this afternoon), the suggestion engine (a busy project is left alone, a lost one
is never offered, the list spans your projects, a live one is not asked to
deploy), the idea engine (a theme is only claimed when the words are there, a
combo needs both halves, openers never pad out a list that has real ideas) and
the project catalogue (a lost project stays out, a deploy shows before the next
sync, a link that isn't a web address never becomes one) and the fleet model (a
paused agent keeps its slot, a second job on a busy project waits for the
project rather than a slot, the queue is read in the order the runner would
claim it, a ceiling lowered under a running fleet is reported rather than
hidden).

`npm run contrast` is the other half of the net. It parses the tokens out of
`style.css` and asserts the claims this README makes about them: every ink
clears 4.5:1 on each surface it is actually set on, every mark — status dot,
meter fill, chart bar — clears 3:1, the two dark scopes (OS preference and the
theme toggle) agree token for token, and nothing in the brand or status ramp
sits in the orange band. It is not decoration: it caught a status dot at 2.96:1
and chart bars at 1.6:1 when this palette went in.

The Supabase CDN import is swapped for a local fake by a Node module loader
(`test/loader.mjs`), so the app runs in the test exactly as the browser loads
it — there is no test-only seam in the app code.

## Looking at the design

```sh
npm run preview -- home dark
```

Renders one screen against the test fixtures and freezes it to
`preview/<view>-<theme>.html`, which you can open or screenshot without a
Supabase project at all. Views: `home`, `agents`, `chat`, `new`, `ideas`,
`projects`, `auth`, `empty`. Themes: `light`, `dark`, `mobile`. (`preview/` is gitignored.)

To screenshot one headlessly:

```sh
chrome --headless --hide-scrollbars --force-device-scale-factor=2   --window-size=500,900 --screenshot=home.png preview/home-light.html
```

Chrome will not open a window narrower than ~500px, so for a true phone width
point it at a wrapper page holding `<iframe src="home-light.html" width="390">`.

## The files

| File | What's in it |
|---|---|
| `index.html` | All the markup, plus the SVG icon sprite |
| `style.css` | The design system: tokens, layout, components |
| `app.js` | Entry point — boot, auth, view switching, composer, shortcuts |
| `store.js` | Supabase client, the in-memory mirror, realtime, mutations |
| `views.js` | Rendering. Reads state, writes DOM; never queries |
| `fleet.js` | Slots, what holds them, and what each queued job waits for. Pure |
| `suggest.js` | The next step for a project you have, read off its thread. Pure |
| `ideas.js` | Whole new projects, read off the themes your work shows. Pure |
| `catalog.js` | The Projects screen's model: every project, its runs, its live link. Pure |
| `router.js` | Hash routing |
| `ui.js` | Theme, drawer, toasts, confirm dialog, the one-second ticker |
| `md.js` | A small Markdown subset, escape-first so output is safe |
| `util.js` | Escaping, time and text helpers |
| `sw.js` | Service worker: caches the app shell, never Supabase traffic |
| `tools/contrast.mjs` | Asserts the colour claims against `style.css` |
| `tools/icon.mjs` | Redraws `icon.png` from the brand geometry |
| `tools/preview.mjs` | Freezes one screen to static HTML for a look |
| `tools/serve.mjs` | The static server — in development and in the container |
| `Dockerfile`, `fly.toml` | What Fly.io builds and runs |

## Data it expects

Tables in the Supabase project, all read through row-level security scoped to
the signed-in user:

| Table | Columns used |
|---|---|
| `jobs` | `id, owner, prompt, mode, project_slug, repo_visibility, effort, usage_cap_pct, status, created_at, claimed_at, resume_at, num_turns, repo_url, live_url, error, cancel_requested` |
| `job_events` | `id, job_id, kind, text` — `kind` is one of `tool`, `assistant`, `status`, `error`, `result` |
| `usage_windows` | `window_type, pct, resets_at` |
| `projects` | `name, full_name, is_local, private, pushed_at`, and from the catalogue migration `description, language, topics, stars, is_fork, is_archived, live_url, live_kind` |
| `hosts` | `name, last_seen` |
| `settings` | `owner, max_parallel` — optional; see [Several agents at once](#several-agents-at-once) |

A job's `status` is `queued`, `running`, `paused`, `done` or `error`. A desktop
counts as online if its `last_seen` is under 30 seconds old.

## Notes on the design

- **The violet accent is brand and interaction only** — it never encodes data.
  `#6d28d9` on light, `#b79cff` on dark; the neutrals are cool so they sit with
  it rather than fighting it.
- **Nothing is orange.** The accent used to be a clay, and the status ramp used
  to spend an orange on "serious". Now: a job in progress is **blue** (it is
  work, not a warning), paused is **amber**, done is **green**, failed is
  **red**, queued is grey. The amber sits at hue 49° in light and 46° in dark —
  past the orange band on purpose — and its light step is darkened to `#9e8000`
  so it clears 3:1 on white, which the shipped amber does not.
- **State always ships as a dot plus a word**, so colour is never the only
  channel. Same for meters: a severity word rides next to the fill.
- A ratio against a limit is a **meter**, not a chart: the fill carries
  severity, the track is a lighter step of the same ramp, and the percentage,
  the headroom and the reset day are all written out beside it.
- The **runs-per-day strip** is one series, so it gets no legend: the heading
  names it and totals it, today is the only coloured column, and the busiest
  day is the only one labelled. Bars cap at 24px with a 2px surface gap, a 4px
  rounded data end, and a hover title per day. Its neutral is a token (`--bar`)
  held to the same 3:1 as any other mark.
- One hero figure per view, in proportional figures; `tabular-nums` is reserved
  for columns of numbers that have to line up.
- Every text colour clears 4.5:1 on the surface it sits on in both themes, and
  every mark clears 3:1. Those are measured by `npm run contrast` on every test
  run, not guessed.

## Calls that were judgement, not instruction

- **Violet** is this build's answer to "not orange". It was picked over blue
  because blue is already spoken for — a running job wears it — and the two
  were kept 17 ΔE apart (OKLab, unsimulated) so the brand can never be mistaken
  for a state. Swapping it is a two-line change: `--accent` and `--accent-text`
  in each of the three scopes in `style.css`, then `npm run contrast`.
- **Suggestions and ideas are rules, not a model.** They had to work offline,
  instantly, and without sending your prompts anywhere, so they are keyword
  probes and a weighted recipe list. They aim at a project and fill the
  composer; they never queue anything on their own. The cost is that a theme
  only registers if it was written down — which is why the ideas view leads
  with what it read, rather than presenting the result as insight.
- **Usage is polled, not just subscribed.** Realtime on `usage_windows` needs
  that table in the Supabase publication, and when it isn't there the failure
  is silent: the meters simply never move. A ten-second poll costs one small
  query and removes a whole class of "it looks broken" — and the block says
  when it last read, so you can tell a stuck feed from a quiet week.
- **Three agents at once is the default**, not one and not six. One is what
  you already had; six is more than a desktop with a single working copy per
  project tends to enjoy. It is one tap to change and the change is published,
  so the default only has to be defensible, not right.
- **The ceiling is advisory, and the screen admits it.** The dashboard cannot
  make a runner parallel — all it can do is publish the number and describe
  the queue that follows from it. So the hint under the control says whether
  the number reached Supabase at all, and the queue reasons are derived from
  rules the runner is expected to keep (a slot per agent, one agent per
  project) rather than from anything this page can observe.
- **Tabs on a phone, a drawer on a desktop.** The drawer still holds the
  project list, the search and the account controls, but navigating with it
  meant two taps and a slide for every screen. The tabs cost a strip at the
  bottom of the views that have no composer — and on the two that do, the
  composer is the more useful thing to have under your thumb.
- **Home folds rather than drops.** Every block that moved behind *More
  detail* is still rendered, still one tap away, and still open by default on
  a wide screen. Hiding a number because the screen is small is how a
  dashboard starts lying by omission.
- **Dates follow the browser's locale** (`toLocaleDateString`), so a reset
  reads "Sat 6:20 p.m." or "Sa 18:20" depending on the phone. The weekday is
  shown for anything two to six days out, a date beyond that.
- **The 14-day window** on the activity strip is fixed; it is the span that
  fits a phone at a 24px bar cap without becoming a scrubber.

## Keyboard

| Key | Does |
|---|---|
| `Enter` | Send (on a real keyboard; `Shift+Enter` for a newline) |
| `⌘/Ctrl+Enter` | Send, anywhere |
| `/` | Focus the composer |
| `n` | New project |
| `a` | Agents |
| `i` | Ideas |
| `p` | Projects |
| `Esc` | Close the drawer, the options panel, or unfocus the composer |
