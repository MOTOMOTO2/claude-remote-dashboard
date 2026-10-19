# claude-remote — dashboard

The phone half of **claude-remote**: a small web app for queueing coding jobs to
the Claude Code runner on your desktop, talking to the assistant you built
yourself, and watching both work from anywhere.

You type what to build. The job lands in Supabase. Your desktop picks it up,
creates the repo, writes the code, pushes it — and streams its log back here
while it does. You type a question instead, and the same relay carries it to
your own assistant on the same PC, which streams its answer back the same way.

This repo is the dashboard and the small bridge that keeps your assistant
reachable (`bridge/`). The runner that claims coding jobs and drives Claude
Code lives on the PC, in its own repo.

```
┌──────────┐   insert job    ┌──────────┐   claim job    ┌─────────────┐
│ this app │ ──────────────▶ │ Supabase │ ◀───────────── │ desktop     │
│  (phone) │ ◀────────────── │          │ ─────────────▶ │ runner      │
│          │  realtime log   │          │  log + status  └─────────────┘
│          │                 │          │                ┌─────────────┐
│          │   ask a thing   │          │  claims it     │ assistant   │
│          │ ──────────────▶ │          │ ◀───────────── │ bridge      │
└──────────┘ ◀────────────── └──────────┘ ─────────────▶ │ → your AI   │
              the reply, live              streams back  └─────────────┘
```

## What it gives you

- **Home** — one hero figure (agents running right now) over the line that says
  what the lead agent is doing this second, the live runs, the limit that will
  stop you first, what to do next, and four counts with their context. The rest
  — the fortnight of runs, the finished jobs, the desktop itself — is one tap
  behind *More detail* on a phone and the right-hand column on a wide screen.
  See [Less on screen at once](#less-on-screen-at-once).
- **Your own assistant, from anywhere** — `#/ask` is the AI you built,
  talked to the way you talk to Claude: threads, Markdown replies, an answer
  that streams in word by word. It runs on your PC and is reachable for
  exactly as long as the PC is on, through the same relay the agents use —
  no port open, no tunnel, nothing sent to anyone else's model. A reply
  always says where it is: *typing…*, *waiting its turn · 2 ahead*, or
  *waiting for your PC*. Not set up yet? `npm run bridge:setup` says exactly
  what is left, and the screen itself carries the SQL and the link to paste it
  into. See [Your own assistant](#your-own-assistant).
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

Two more worth knowing: `npm run bridge:setup` walks you through making your
own assistant reachable ([below](#setting-it-up)), and `npm run mobile`
measures the phone layout in a real browser
([below](#measuring-it-instead-of-squinting-at-it)).

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

The assistant needs nothing here either. Its bridge runs on your PC and talks
*outward* to Supabase, so a deployment of this app never holds a key for it —
which is also why the container can scale to zero and your assistant stays
reachable regardless.

### On a phone

Open the URL, then **Add to Home Screen**. Sign in *inside that app* — on iOS a
home-screen install gets its own storage, separate from Safari, so a session
created in the browser is not visible to it. If storage is blocked entirely
(Private tabs do this), the sign-in screen says so rather than silently failing.

## Your own assistant

The dashboard already knew how to reach your PC from a phone without opening
a port: write a row to Supabase, let the desktop claim it, stream the result
back. That path works just as well for a conversation as for a build — so
`#/ask` is the assistant *you* wrote, talked to the way you talk to Claude.

```
┌──────────┐  your message   ┌──────────┐   claims it    ┌─────────────┐
│ this app │ ──────────────▶ │ Supabase │ ◀───────────── │  bridge.mjs │
│  (phone) │ ◀────────────── │          │ ─────────────▶ │  → your AI  │
└──────────┘ the reply, live └──────────┘  streams back  └─────────────┘
```

Nothing listens for inbound connections, nothing needs a static IP or a
tunnel, and your messages reach no model but yours. The assistant is
reachable for exactly as long as the bridge process is up — which is to say,
as long as the PC is on.

- **Threads, not transcripts.** A conversation per subject, named after the
  first thing you asked, newest open by default. Replies render as Markdown,
  the same renderer an agent's summary uses.
- **The answer arrives as it is written.** The bridge streams into one row
  and the dashboard draws it growing. Before the first word there are three
  dots; while it writes, the header says *typing…*.
- **A reply always says where it is.** This is the part that had to be right:
  a message sent to a sleeping PC says **waiting for your PC — answered as
  soon as it is on again**, one behind others says **waiting its turn · 2
  ahead**, and *typing…* is only ever printed over something that is actually
  typing. Those sentences come from `assistant.js`, which is pure and unit
  tested, for the same reason `fleet.js` is.
- **Ask with the PC off.** The message and the empty reply it is owed are
  written together, so the thread shows an answer on its way either way. Put
  the phone down; the reply lands when the machine wakes, and says so.
- **The two halves meet.** An answer worth building has a *hand to an agent*
  button: it opens the new-project composer with the text already in it.
- **It tells you when it answered.** A reply that lands while you are on
  another screen raises a toast and a notification. One that lands while you
  are watching does not — the words appearing are the news.

### The bridge

`bridge/bridge.mjs` is the PC half: one dependency-free Node script, about
300 lines, that claims whatever you send, asks your assistant, and streams
the answer back. It does not know what your assistant *is*. It knows two ways
to ask something a question:

| Set this | For |
|---|---|
| `ASSISTANT_CMD` | a command — a Python script, a Node script, a CLI you wrote |
| `ASSISTANT_URL` | an HTTP endpoint — yours, Ollama, llama.cpp, LM Studio, anything OpenAI-shaped |

A command gets the question three ways, so it fits whatever your script
already reads:

```sh
$ASSISTANT_PROMPT        # the latest question
$ASSISTANT_TRANSCRIPT    # the whole conversation as plain text
stdin                    # {"messages":[{"role","content"}],"prompt":"…"}
```

Whatever it prints on stdout is the reply, streamed to your phone as it is
printed. Exit non-zero and whatever went to stderr becomes the error shown in
the chat, so a broken assistant says why rather than going quiet.

An endpoint is sent `{messages, prompt, input, stream}` — over-complete on
purpose, so one request body fits every dialect — and may answer with
server-sent events, newline-delimited JSON, one JSON body, or plain text.
`bridge/reply.mjs` unwraps OpenAI, Anthropic and Ollama shapes, and falls
back to `reply` / `text` / `answer` / `output` / `response` for an endpoint
you wrote yourself. A line it cannot parse is passed through as prose rather
than dropped, because losing the answer is worse than printing a stray brace.

### Setting it up

```sh
npm run bridge:setup
```

One command that says where you are. Four things have to be true before
`#/ask` works, and it checks all four, does the two it can do on its own, and
prints the exact next command for the rest:

| | | |
|---|---|---|
| 1 | the relay | read out of `config.js` — you already filled that in |
| 2 | the tables | `bridge/schema.sql`, pasted into the SQL editor once |
| 3 | `bridge/.env` | **written for you**, with the Supabase project already in it |
| 4 | your assistant | `ASSISTANT_CMD` or `ASSISTANT_URL` — and it is asked, to be sure |

It never writes to Supabase, and it never overwrites a `.env` you already
have — the bottom half of that file is a password. For step 2 it prints the
SQL editor URL for *your* project, derived from the one in `config.js`. For
step 4, if nothing is configured yet, it knocks on the ports a local
assistant usually answers on (Ollama, LM Studio, llama.cpp and friends) and
offers the line to paste for each one that answers. Run it again after each
change; it exits non-zero while anything is outstanding.

**From the phone instead.** The Assistant screen says the same thing, with
the buttons to act on it: *copy the SQL*, *open the SQL editor*, and *check
again*. So the migration can be run from the laptop and confirmed from the
device that was complaining, without a reload.

**Where this checkout stands.** `bridge/.env` is written and holds the
Supabase project from `config.js` and the account to sign in as. Two things
are deliberately left, because neither can be done from inside this repo:

1. **`SUPABASE_PASSWORD=`** in `bridge/.env` — the one secret. Nothing else
   is missing from that file.
2. **The tables.** `chats`, `chat_messages`, `assistants` and `settings` are
   all absent from the project right now; adding them needs the SQL editor,
   which needs your login. Step 2 above is the whole of it.

`ASSISTANT_CMD` currently points at `bridge/example-assistant.mjs`, the
stand-in — so the moment those two are done, `#/ask` works end to end and
proves the relay. Pointing it at the assistant you actually built is then one
line, and `npm run bridge:setup` will tell you it answered.

```sh
node bridge/bridge.mjs --try "hello"    # the adapter, with no Supabase in the way
node bridge/bridge.mjs                  # leave it running
```

`--try` runs the adapter and nothing else: it prints the reply as it streams
and tells you how many characters came back. If that works, the phone works.
There is also `--once`, which answers a single message and exits.

`bridge/example-assistant.mjs` is a stand-in that answers a few questions
with `if` statements, so step 3 works before your own assistant is wired in.
It is also the shape to copy.

**Keeping it up.** "Reachable as long as the PC is on" is only true if
something starts the bridge when the PC starts. On Windows:

```powershell
powershell -ExecutionPolicy Bypass -File bridge\run-at-logon.ps1
```

That registers a Scheduled Task — at logon, restarted if it stops, no console
window — and prints how to start it now, check on it, and undo it. Nothing in
this repo runs it for you. Anywhere else, the usual suspects work: `pm2 start
bridge/bridge.mjs`, a systemd unit, `launchd`.

**Signing in.** Prefer `SUPABASE_ANON_KEY` with `SUPABASE_EMAIL` and
`SUPABASE_PASSWORD`: the bridge signs in as you, row-level security still
applies, and no service-role key ends up on that disk. It re-signs-in by
itself when the hour-long token expires. If you would rather reuse the
service key the coding runner already has, set `SUPABASE_SERVICE_KEY`
instead — it bypasses RLS, so keep it on that one machine.

### The tables it wants

`bridge/schema.sql` adds four, and changes nothing that is already there:

| Table | What is in it |
|---|---|
| `chats` | one row per conversation: `id, owner, title, created_at, updated_at` |
| `chat_messages` | one row per turn: `chat_id, role, text, status, error, cancel_requested` |
| `assistants` | the bridge's heartbeat: `owner, name, model, last_seen` |
| `settings` | the agent ceiling: `owner, max_parallel` — not the assistant's, but the other table the dashboard asks for and keeps working without, so that one paste brings an account all the way up to date |

A message's `status` is `queued`, `streaming`, `done` or `error`. An
assistant counts as online if `last_seen` is under 30 seconds old — the same
rule the desktop runner gets.

All four are optional. An account whose schema predates this keeps working;
the Assistant screen says which migration has not run rather than throwing,
exactly like the agent ceiling.

The schema also adds `chat_messages` to the realtime publication and sets its
replica identity, because a reply streams in as repeated `UPDATE`s to one
row. Skip that and replies arrive in lumps instead of not at all: the app
polls the newest messages every 1.5 seconds *while something is pending*, and
stops the moment nothing is.

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

### Measuring it, instead of squinting at it

Dense is one decision away from *cut off*, and the smoke test cannot tell the
difference: jsdom has no layout engine, so a box clipped to a third of its
text looks exactly like one that fits.

```sh
npm run mobile              # every view at 390px
npm run mobile home 320     # one view, one width
```

`tools/mobile-audit.mjs` renders each screen with the preview tool, re-opens
the frozen file in headless Chrome with a probe appended, and reports:

| It looks for | Because |
|---|---|
| content wider than its own box | a sentence ellipsised down to a fragment |
| boxes past the viewport edge | the right-hand column of a card, gone |
| the page scrolling sideways at all | one wide child is enough to do it |
| content left under the bottom bar | the last row you can never reach |
| tap targets under 40px | counting any hit area grown with `::after`, so a dense control that is still catchable is not a finding |
| controls whose own middle belongs to something else | the fix for the line above, overdone |

It finds the browser itself — Playwright's Chromium, Chrome, or Edge,
whichever is installed — or takes `CHROME=`. There is no new dependency.

What it caught, and what changed in answer:

- **Suggestions were losing most of their sentence.** `last run failed — npm
  install failed: ETARGET no matching version for vite@99` was one ellipsised
  line: 161 of its 232 pixels hidden at 390px, 231 of 393 at 320px. Titles and
  reasons now clamp to two lines rather than one — still bounded, so a long
  one cannot push a card around.
- **Headings were squeezing into the column their own buttons left over.** On
  a phone the chat and assistant titles take the line, and the actions wrap
  under them.
- **The topbar was spending 150px of 390 on two pills**, which left a project
  name ellipsising itself. Under 440px the desktop badge is its dot — the name
  stays in `aria-label`, `title`, and the toast tapping it already raised.
- **The bottom tabs sagged in the middle**: New's bigger icon pushed its own
  label 5px below the five beside it. The tabs share one fixed icon row now.
- **The smallest controls grew a hit area, not padding.** A 19px-tall link is
  a thumb's worth of guessing, but a 44px chip is a different app. They keep
  the size they look and stretch an invisible `::after` instead, so the screens
  stay as dense as they were.

Every view is clean at 390px and 320px.

## Where suggestions come from

`suggest.js` is a few rules over data the dashboard already has — no model is
called, nothing leaves the page. For each project it builds a digest (the
thread, how the last run ended, whether the repo is local-only, and a keyword
probe over every prompt and summary) and runs the recipes against it:

| It notices | It offers |
|---|---|
| the last run failed | **Fix what broke in X** — with the real error pasted into the prompt — unless the desktop was signed out (below) |
| finished, but only on your desktop | **Put X on GitHub** |
| finished, and no README has come up | **Write a README for X** |
| finished, and nothing has mentioned tests | **Add tests to X** |
| has tests, has a remote, no workflow | **Run X's tests on every push** |
| browser-ish, nothing deployed | **Put X online** |
| a repo you have never run a job against | **Take a look at X** |
| several runs in, nothing else to say | **Tighten up X** |

A run that dies because Claude Code on the desktop is signed out ("Failed to
authenticate: OAuth session expired…") is not the project's fault, so no fix is
offered for it. Instead the chat says so, home shows a *desktop signed out*
chip until a later run finishes, and the toast says what to do: run `claude`
on the PC, `/login`, then *run again*.

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
npm test            # contrast guard, the app in jsdom, then the bridge
npm run contrast    # just the colour claims
```

Boots the real app in jsdom against a fake Supabase and walks the screens: sign
in, home, a project thread, sending a follow-up, stopping a run, a job finishing
over realtime, the new-project flow, the agents view (a second agent arriving
mid-watch, a live log line landing on its card, the ceiling changed from another
device and published from this one, a job queued behind its own project, stop
all), the phone layout (home folding its reference blocks, the limits block
leading with the tightest window, tabs and composer never sharing the bottom of
the window), the assistant screen (an answered thread, sending a message, the answer
streaming in and finishing, a PC that is switched off, a reply queued behind
another, an answer that failed, a bridge that has never checked in, a schema
that predates the feature — and the setup card offering the SQL, the editor for
the configured project, and a re-check that keeps the card up while the tables
are still missing — handing an answer to an agent, deleting a
conversation), the ideas view and its filters, the projects view with its
search, filters and sort, re-reading and failing to read the limits, clearing
a chat, the drawer, keyboard shortcuts, theming, and the Markdown renderer. It also checks the static invariants a
vanilla app has no compiler for — every `$('id')` exists in the HTML, every icon
referenced is in the sprite, every module is listed in the service-worker shell,
and the recurring timer still re-reads usage (it stopped once, and nothing else
in here would have noticed).

Seven things get unit coverage against fixed inputs rather than fixtures,
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
hidden), the assistant model (a bridge that has never checked in is not the
same as one that is offline, a reply with the PC asleep never claims to be
typing, a streaming reply does even if the heartbeat went stale, a
conversation with nothing in it still has a name) and the bridge's adapters
(every response dialect it claims to understand, a stream split mid-token, an
error arriving mid-stream thrown rather than printed as the answer, and a
line it cannot parse kept as prose rather than dropped).

`npm run contrast` is the other half of the net. It parses the tokens out of
`style.css` and asserts the claims this README makes about them: every ink
clears 4.5:1 on each surface it is actually set on, every mark — status dot,
meter fill, chart bar — clears 3:1, the two dark scopes (OS preference and the
theme toggle) agree token for token, and nothing in the brand or status ramp
sits in the orange band. It is not decoration: it caught a status dot at 2.96:1
and chart bars at 1.6:1 when this palette went in.

`test/bridge.mjs` is the third part, and it runs the real thing: it starts a
server that answers the way PostgREST does, runs `bridge/bridge.mjs --once`
against it as an actual child process, and reads what it left behind. Covered
that way: the claim is filtered on the status, so two bridges can never take
the same message; the answer is written several times over rather than once
at the end, which is what makes it read like typing; a stop lands as *done*
with "(stopped)" rather than as a failure; an assistant that exits non-zero
leaves the reply in `error` with its own stderr in it; and with nothing
queued the bridge still checks in before it stops. Deleting the status filter
from the claim fails that suite, which is the point of writing it.

The Supabase CDN import is swapped for a local fake by a Node module loader
(`test/loader.mjs`), so the app runs in the test exactly as the browser loads
it — there is no test-only seam in the app code.

## Looking at the design

```sh
npm run preview -- home dark
```

Renders one screen against the test fixtures and freezes it to
`preview/<view>-<theme>.html`, which you can open or screenshot without a
Supabase project at all. Views: `home`, `agents`, `ask`, `chat`, `new`,
`ideas`, `projects`, `auth`, `empty`, and `setup` — the assistant screen as an
account that has not run the migration sees it. Themes: `light`, `dark`,
`mobile`. (`preview/` is gitignored.)

To screenshot one headlessly:

```sh
chrome-headless-shell --headless --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=390,844 --screenshot=home.png preview/home-mobile.html
```

`chrome-headless-shell` — Playwright ships one, under
`~/AppData/Local/ms-playwright/chromium_headless_shell-*/` on Windows — does
honour a window narrower than 500px, where a full Chrome build clamps it. Use
`--dump-dom` with a `<script>` appended to the frozen file to measure the page
instead of looking at it; `tools/mobile-audit.mjs` is that trick, written down.

## The files

| File | What's in it |
|---|---|
| `index.html` | All the markup, plus the SVG icon sprite |
| `style.css` | The design system: tokens, layout, components |
| `app.js` | Entry point — boot, auth, view switching, composer, shortcuts |
| `store.js` | Supabase client, the in-memory mirror, realtime, mutations |
| `views.js` | Rendering. Reads state, writes DOM; never queries |
| `fleet.js` | Slots, what holds them, and what each queued job waits for. Pure |
| `assistant.js` | Your assistant: presence, where a reply is, conversations. Pure |
| `suggest.js` | The next step for a project you have, read off its thread. Pure |
| `ideas.js` | Whole new projects, read off the themes your work shows. Pure |
| `catalog.js` | The Projects screen's model: every project, its runs, its live link. Pure |
| `router.js` | Hash routing |
| `ui.js` | Theme, drawer, toasts, confirm dialog, the one-second ticker |
| `md.js` | A small Markdown subset, escape-first so output is safe |
| `util.js` | Escaping, time and text helpers |
| `sw.js` | Service worker: caches the app shell, never Supabase traffic |
| `test/bridge.mjs` | Runs the real bridge against a stand-in for PostgREST |
| `tools/contrast.mjs` | Asserts the colour claims against `style.css` |
| `tools/icon.mjs` | Redraws `icon.png` from the brand geometry |
| `tools/preview.mjs` | Freezes one screen to static HTML for a look |
| `tools/mobile-audit.mjs` | Measures the narrow layout in a real browser: what is cut off, what is unreachable |
| `tools/serve.mjs` | The static server — in development and in the container |
| `bridge/bridge.mjs` | The PC half: claims what you asked, streams the answer back |
| `bridge/reply.mjs` | The two adapters, and every guess about a response shape |
| `bridge/setup.mjs` | Says which of the four setup steps are done, and does the two it can |
| `bridge/schema.sql` | The four tables this account needs, in one paste |
| `bridge/example-assistant.mjs` | A stand-in assistant, and the shape to copy |
| `bridge/run-at-logon.ps1` | Registers the bridge as a Windows task. You run it |
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
| `chats` | `id, owner, title, created_at, updated_at` — optional; see [Your own assistant](#your-own-assistant) |
| `chat_messages` | `id, chat_id, owner, role, text, status, error, cancel_requested, created_at` |
| `assistants` | `owner, name, model, last_seen` |

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
- **The bridge is an adapter, not an integration.** Your assistant lives in
  another folder on this machine, outside this project, so this repo was
  written without reading a line of it. Rather than guess at its interface,
  the bridge takes a command or a URL and normalises whatever comes back —
  which also means swapping the assistant behind it is one line of `.env`
  and no code. `--try` exists for the same reason: the first thing to find
  out is whether *your* half answers, with none of this in the way.
- **One message at a time.** The bridge answers serially even though the
  agents run in parallel. Your assistant is one process on one machine, and
  two replies streaming at once would only fight over it — so the queue says
  "2 ahead" instead, which is true and visible.
- **The empty reply row is written up front.** The alternative is for the
  bridge to create it when it claims the message, which is tidier right up
  until the PC is off: then a message you sent has nothing to show for
  itself. Writing it with the question means the thread can say *waiting for
  your PC* instead of looking like it was never sent.
- **Six tabs, not five.** Five is the convention and one of these could have
  been demoted to the drawer instead. But the assistant is the thing you
  reach for with a phone in your hand, and burying it behind a slide-out
  would have made "always accessible" quietly untrue. The labels elide and
  shrink below 390px rather than anything being dropped.
- **`bridge/setup.mjs` does not run the SQL.** It could ask for a service-role
  key or a database password and do the migration itself. That would mean one
  more credential on disk, with permission to drop tables, to save one paste —
  so instead it finds out which tables are missing with the publishable key
  that is already in `config.js` (a table that is not there answers
  `PGRST205`; one that is answers `[]`, because row-level security hides your
  rows from an unauthenticated read), prints the editor URL for your project,
  and checks again when you ask it to.
- **The setup card is on the screen that is complaining.** Telling someone
  holding a phone to go and find a file in a repo is a dead end, so the
  Assistant screen carries the SQL, the link to the editor, and the re-check.
  The SQL is fetched from `bridge/schema.sql` rather than copied into a
  JavaScript string, so there is one of it; `.dockerignore` keeps `bridge/`
  in the image for that reason and excludes only `bridge/.env`.
- **Two lines, not one or unbounded.** A suggestion's reason could wrap
  freely. Clamping it at two keeps a pathological summary from turning a row
  into a paragraph and shoving the next card off the screen, while leaving
  room for every real one in the fixtures. The number is a guess that the
  audit can check, not a principle.
- **Hit areas grew; the controls did not.** The honest fix for a 19px-tall
  link is a 44px-tall link, and this is a dashboard that was asked to be
  dense. So the small controls keep the size they look and stretch an
  invisible `::after` past their own edges — and because that trick can
  silently swallow a neighbour's taps, the audit also checks that the middle
  of every control still belongs to it.
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
| `k` | As**k** your assistant |
| `i` | Ideas |
| `p` | Projects |
| `Esc` | Close the drawer, the options panel, or unfocus the composer |
