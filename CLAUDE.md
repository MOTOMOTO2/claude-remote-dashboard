# claude-remote dashboard

A phone-first web app (plain ES modules, **no build step**) for one person, Aden. From a phone it queues coding
jobs to Claude Code, talks to their own assistant and to Claude (`#/ask`), controls a Raspberry Pi smart-home hub
(`#/house`), and shows the subscription's usage limits. It is installed as a PWA and used mostly on a phone.
Everything goes through Supabase (jobs, chats, house, limits); the things that *act* live elsewhere: the PC
runner (another repo), `bridge/` (assistant + house relay) and `host/` + `api/runner.js` (cloud runner on Vercel
Sandbox, for when the PC is off). `README.md` is the long, detailed doc — read its section for any feature.

## Run, test, deploy
- `npm install` (jsdom only). `config.js` is committed on purpose: it holds the *publishable* Supabase key.
- `npm run serve` → http://localhost:5173. It needs a real Supabase login to get past the sign-in screen.
- `npm test` = contrast guard → outbox + field model (`test/offline.mjs`) → jsdom smoke (`test/smoke.mjs`) →
  cloud runner (`test/host.mjs`) → bridge (`test/bridge.mjs`). On macOS, 2026-11-24: 107 colour claims, 74 offline,
  1176 smoke, 178 host, 101 bridge + 1 known macOS failure ("the packed copy runs on its own"; fails on the
  code before the field-reports merge too).
- See a screen: `npm run preview -- <view> <theme>` writes `preview/*.html` (views and themes: README, "Looking at
  the design"). Measure the phone layout in a real browser: `CHROME=/path/to/chrome-headless-shell npm run mobile`
  (or `npm run mobile agents 320`). A runner has no browser: `npm i playwright` in a *scratch dir outside the
  repo*, `npx playwright install chromium-headless-shell`, `sudo npx playwright install-deps` (worked here).
- Deploy: a push to `main` deploys to Vercel (repo root served as static files; `vercel.json`, `.vercelignore`).
  `api/runner.js` is the only function. `npm run cloud:setup` / `npm run bridge:setup` are the interactive setups.
- Git: no identity is configured on the runner. Commit with `git -c user.name=Claude -c user.email=noreply@anthropic.com`.

## Layout
- `index.html` all markup + SVG sprite · `style.css` tokens, layout, components · `app.js` boot, auth, composer,
  wiring · `store.js` Supabase client, in-memory mirror, realtime + polling · `views.js` rendering (reads state,
  writes DOM, never queries) · `router.js` hash routes · `ui.js` theme, drawer, sheets, toasts, ticker.
- **Pure, unit-tested models** (rows in, plain data out): `usage.js` limits, `fleet.js` slots/queue, `assistant.js`,
  `house.js`, `suggest.js`, `ideas.js`, `catalog.js`, `field.js` (sites with unsent reports laid over them).
  Put logic that must be *right* here, not in `views.js`.
- **Offline:** `outbox.js` (durable send queue, ported from Field Reports / `offline-sync-pwa`) over `idb.js`
  (IndexedDB, in-memory fallback in jsdom/private windows). `store.js` holds the senders, the flush, and the
  "saved copy" snapshot the app opens on with no signal.
- `bridge/` PC half (assistant bridge, house relay, HA add-on, `schema.sql`); `host/` + `api/` cloud runner;
  `test/` jsdom harness with a fake Supabase (`fake-supabase.mjs`) and a module loader that swaps the CDN import;
  `tools/` contrast checker, preview freezer, mobile audit, static server.
- Routes: `#/` and `#/agents` (front page) · `#/ask[/id]` · `#/house` · `#/field[/<site id>]` · `#/outbox` ·
  `#/projects` · `#/ideas` · `#/new` · `#/p/<slug>` · `#/j/<id>` (the id may be the phone's own, before the job is
  sent). **There is no home view** (removed 2026-11-24 at the owner's request).

## Conventions and decisions (with reasons)
- **Class names and element ids are the contract.** JS uses `$('id')`; the smoke test fails if one is missing from
  `index.html`, or an icon from the sprite, or a module from `sw.js`'s `FILES`. New `.js` file → add it to `FILES`
  and bump `SHELL` in `sw.js`, or installed phones keep the old shell.
- **`usage.js` decides what a limit reading means.** A `usage_windows` row is `{window_type, pct, resets_at}`
  written by a runner in another repo, so `resets_at` may be ISO, epoch s/ms, null or past. States: *live* (reset
  ahead), *idle* (0% + no reset = starts with your next message), *stale* (reset already passed — never drawn as
  "nearly out"), *unknown* (used, no reset). Never print "unknown" for the first three; each answers "how long do I
  have" differently. `host/dispatch.mjs` already ignores a window past its reset, so screen and runner agree.
- **Limits are always the same meter** (front page, the sheet behind the topbar chip, the New screen, the desktop
  sidebar). The chip shows `88% · 2d 19h`; its tap opens `#usage-sheet` (a native `<dialog>`, with an `open`
  attribute fallback because jsdom has no `showModal`). Not a toast: a reset needs more than five seconds to read.
- **Design is flat.** Surface + hairline, no card shadows (shadows only for floating things), grouped lists, sentence
  case, nothing under 11px. State is always a dot *and* a word. The violet accent is brand/interaction only.
- **`tools/contrast.mjs` parses `style.css`** by selector text. Keep the three token blocks' openers exactly
  (`:root {`, `:root[data-theme="dark"] {\n  color-scheme: dark;`, `:root:not([data-theme="light"]) {\n    color-scheme: dark;`)
  and keep the two dark blocks identical. Every ink must clear 4.5:1 and every mark 3:1.
- **Every write that matters goes through the outbox** (jobs, Ask messages, field reports, new sites): kept in
  IndexedDB first, sent after; ids made on the phone (`client_id` on jobs/chat_messages, a report's primary key)
  make a retry's 23505 mean "already sent". **House taps are deliberately not queued.** A read that fails must
  keep what is on screen (no clearing before the result is known) and never flip a `*Ready` flag to "tables
  missing" on a network error or lapsed token (`unreadable` in store.js).
- **Phone nav is five tabs** (Agents · Ask · New · House · Projects); Ideas, Field and Outbox are in the menu. The bar hides
  on views with a composer (Ask, New, project threads) by design — the composer owns the bottom there.
- **Wrapping is invisible to the audit.** `npm run mobile` measures overflow, not how text breaks; also look at a
  320px screenshot (that is how the meter-heading and freshness-line wraps were found).
- Tests wait with `tick()` (harness), which drains the app's pending animation frames; never add flat sleeps.
- The suites avoid test-only seams in app code: the app runs in jsdom exactly as in the browser.

## Known problems and sensible next steps
- **Unverified:** `host/memory.mjs` `usageRow` writes a limit row only when Claude Code's `rate_limit_event` carries a
  numeric `utilization`. I could not check a real stream; if meters stay empty with the PC off, look there first.
- The tab bar disappears on Ask and New (documented, but a visible wart: you leave via the menu or Back).
- `test/bridge.mjs` "killing the keeper takes the bridge with it" is Windows-only and is skipped on POSIX.
- The four counts and 14-day activity strip that lived on Home were dropped; `git show e4a44f8^:views.js` has them.
- `usage_windows` has no migration in this repo (it predates `bridge/schema.sql`); its column types are inferred.
- README is long; prune when a section stops being true rather than adding beside it.
- Field reports and `client_id` need `bridge/schema.sql` run in Supabase (`field_sites`, `field_reports`, two
  triggers, the `client_id` columns). Without it the Field screen shows its setup card, and jobs/messages send
  without the duplicate guard (PGRST204 → resent without the column).

## Recent work
- 2026-10-18 — Ask tab: talk to the assistant you built, over the Supabase relay; `bridge/` runs on the PC.
- 2026-10-19 — `npm run bridge:setup` (checks the four setup steps); phone layout fixes and `tools/mobile-audit.mjs`.
- 2026-10-19 — Smart-home hub: `#/house`, `bridge/house.mjs` + `ha.mjs`, assistant tools for the house.
- 2026-10-19 — The hub relay also runs on the Pi (HA add-on / systemd), so the house works with the PC off.
- 2026-11-23 — Cloud runner on Vercel Sandbox (`host/`, `api/runner.js`) so jobs and Ask work with the PC off.
- 2026-11-24 — Removed Home (front page is Agents); limits say when they reset and how long is left (`usage.js`,
  topbar chip, usage sheet); restyled every screen flat and quiet, five-tab bar; fixed a flaky test timer.
- 2026-11-24 — Field Reports moved in (`#/field`, Supabase tables + triggers); the outbox and saved copy make jobs,
  Ask, reports and sites work with no signal (`outbox.js`, `idb.js`, `#/outbox`, topbar pill, offline bar).
