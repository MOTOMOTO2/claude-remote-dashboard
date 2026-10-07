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

- **Home** — one hero figure (agents running right now), what each one is doing
  this second, your 5-hour and weekly usage as meters, and the counts that
  matter: projects, finished, needs a look.
- **A chat per project** — your prompts and the agent's replies in one thread,
  with its summary rendered as Markdown, a live log while it works, and a folded
  log once it's done. Stop a run, copy a summary or log, or load an old prompt
  back into the composer to run it again.
- **Live everything** — jobs, log lines and usage arrive over Supabase realtime,
  so nothing needs refreshing. A finished job raises a toast; the running count
  shows up in the tab title and on the installed app's icon.
- **Light and dark** — follows the system by default, with a three-way switch in
  the sidebar footer. Both themes were picked for contrast, not inverted.
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

### On a phone

Open the URL, then **Add to Home Screen**. Sign in *inside that app* — on iOS a
home-screen install gets its own storage, separate from Safari, so a session
created in the browser is not visible to it. If storage is blocked entirely
(Private tabs do this), the sign-in screen says so rather than silently failing.

## Tests

```sh
npm test
```

Boots the real app in jsdom against a fake Supabase and walks the screens: sign
in, home, a project thread, sending a follow-up, stopping a run, a job finishing
over realtime, the new-project flow, clearing a chat, the drawer, keyboard
shortcuts, theming, and the Markdown renderer. It also checks the static
invariants a vanilla app has no compiler for — every `$('id')` exists in the
HTML, every icon referenced is in the sprite, and every module is listed in the
service-worker shell.

The Supabase CDN import is swapped for a local fake by a Node module loader
(`test/loader.mjs`), so the app runs in the test exactly as the browser loads
it — there is no test-only seam in the app code.

## Looking at the design

```sh
node --import ./test/register.mjs tools/preview.mjs home dark
```

Renders one screen against the test fixtures and freezes it to
`preview/<view>-<theme>.html`, which you can open or screenshot without a
Supabase project at all. Views: `home`, `chat`, `new`, `auth`. Themes: `light`,
`dark`. (`preview/` is gitignored.)

## The files

| File | What's in it |
|---|---|
| `index.html` | All the markup, plus the SVG icon sprite |
| `style.css` | The design system: tokens, layout, components |
| `app.js` | Entry point — boot, auth, view switching, composer, shortcuts |
| `store.js` | Supabase client, the in-memory mirror, realtime, mutations |
| `views.js` | Rendering. Reads state, writes DOM; never queries |
| `router.js` | Hash routing |
| `ui.js` | Theme, drawer, toasts, confirm dialog, the one-second ticker |
| `md.js` | A small Markdown subset, escape-first so output is safe |
| `util.js` | Escaping, time and text helpers |
| `sw.js` | Service worker: caches the app shell, never Supabase traffic |

## Data it expects

Tables in the Supabase project, all read through row-level security scoped to
the signed-in user:

| Table | Columns used |
|---|---|
| `jobs` | `id, owner, prompt, mode, project_slug, repo_visibility, effort, usage_cap_pct, status, created_at, claimed_at, resume_at, num_turns, repo_url, error, cancel_requested` |
| `job_events` | `id, job_id, kind, text` — `kind` is one of `tool`, `assistant`, `status`, `error`, `result` |
| `usage_windows` | `window_type, pct, resets_at` |
| `projects` | `name, full_name, is_local, private, pushed_at` |
| `hosts` | `name, last_seen` |

A job's `status` is `queued`, `running`, `paused`, `done` or `error`. A desktop
counts as online if its `last_seen` is under 30 seconds old.

## Notes on the design

- The clay accent is brand and interaction only — it never encodes data.
- State uses a reserved status ramp (good / warning / serious / critical) and
  always ships as a dot plus a word, so colour is never the only channel.
- A ratio against a limit is a **meter**, not a chart: the fill carries severity
  and the track is a lighter step of the same ramp, with the percentage written
  out beside it.
- One hero figure per view, in proportional figures; `tabular-nums` is reserved
  for columns of numbers that have to line up.
- Every text colour clears 4.5:1 on the surface it sits on in both themes, and
  every meter fill clears 3:1. Those were measured, not guessed.

## Keyboard

| Key | Does |
|---|---|
| `Enter` | Send (on a real keyboard; `Shift+Enter` for a newline) |
| `⌘/Ctrl+Enter` | Send, anywhere |
| `/` | Focus the composer |
| `n` | New project |
| `Esc` | Close the drawer, the options panel, or unfocus the composer |
