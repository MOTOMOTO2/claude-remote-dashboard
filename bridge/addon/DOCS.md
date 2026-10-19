# House relay

Mirrors this hub into your [claude-remote dashboard](https://claude-remote-dashboard.fly.dev/)
and obeys what you tap there, so your house is reachable from anywhere —
without forwarding a port, opening a tunnel, or leaving a PC awake.

## Why it runs here and not on your PC

The dashboard is on the internet and your hub is not, so something on your
network has to carry one to the other. That relay used to run on the desktop,
which worked right up until the moment it mattered: a desktop is asleep
exactly when you are out of the house and want the hall light.

This add-on is the same relay, on the hub. The hub is already on all the time
— that is what a hub is — so there is nothing extra to keep awake.

Nothing listens for inbound connections. The relay talks *outward* to
Supabase, and inward to Home Assistant through the Supervisor, so:

- no port is forwarded and no tunnel is opened,
- there is **no long-lived access token to make** — `homeassistant_api: true`
  is the whole of its access to your house,
- your Supabase password stays in this add-on's own options, which live on
  the hub.

## Setting it up

You need the Supabase project the dashboard already uses — **Settings → API**
in Supabase has both values.

1. **supabase_url** — `https://xxxxxxxxxxxx.supabase.co`
2. Either sign in as yourself (preferred — row-level security still applies,
   so this add-on can only ever reach your own rows):
   - **supabase_anon_key** — the publishable key
   - **supabase_email** / **supabase_password** — your dashboard sign-in
3. …or paste **supabase_service_key** instead of those three. It bypasses
   row-level security, so only do this if the key is already on this hub.

Then start the add-on and watch its log. It should say which relay it is and
that it is mirroring the house, and `#/house` on the dashboard goes green
within ten seconds.

If the house tables are not in your Supabase project yet, the log says so —
paste `bridge/schema.sql` from the dashboard repo into the Supabase SQL
editor first.

## The rest of the options

| Option | What it does |
| --- | --- |
| `relay_name` | What the dashboard calls this relay. Defaults to `hub`. |
| `hub_name` | What it calls the house. Defaults to your Home Assistant location name. |
| `keep_all_sensors` | Off by default: a real install has hundreds of diagnostic sensors (wifi strength, uptime, update available) and a house screen is not for those. On keeps every one. |
| `exclude` | A regex of entity ids to leave out entirely, e.g. `^light\.test_`. |
| `poll_seconds` | How often to read the hub. 10 by default. |

## Running it here *and* on your PC

That is fine, and it is the better setup. Both relays check in, the dashboard
lists both, and either can obey a tap — so whichever is awake does the work.
Only one of them mirrors devices, and this one wins, because a relay on the
hub outranks a relay on a PC. If this add-on is restarting, the PC takes the
mirror over for a minute rather than leaving the screen frozen.

## When something is wrong

The dashboard separates the two halves on purpose, because they need
different fixes:

- **waiting for your PC** / **no relay running** — nothing is checking in.
  Start this add-on. Taps you made are queued, not lost, and run when it is
  back.
- **hub not answering** — this add-on is up but Home Assistant did not answer
  it. Almost always Home Assistant restarting; the log says what it got.
- **online** — both halves are there, and taps take effect now.
