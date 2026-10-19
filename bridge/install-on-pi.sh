#!/bin/sh
# Install the house relay on the hub, as a systemd service.
#
# Run this *on the Pi*, from a clone of this repo:
#
#   git clone <this repo> && cd claude-remote-dashboard
#   sudo sh bridge/install-on-pi.sh
#
# What it does, and nothing else: copies four files to /opt/house-relay,
# makes a system user that owns nothing, writes /etc/house-relay.env for you
# to fill in, and enables bridge/house-relay.service. It opens no port and
# installs no dependencies — the relay has none.
#
# On Home Assistant OS there is no systemd to install into. Use bridge/addon
# there instead: same relay, installed from the Add-on store, and it needs no
# access token at all.
set -eu

# Overridable so the test suite can run this against a temp directory rather
# than taking the machine's word for it. Left alone, they are the real paths.
: "${DEST:=/opt/house-relay}"
: "${ENV_FILE:=/etc/house-relay.env}"
: "${UNIT:=/etc/systemd/system/house-relay.service}"
: "${USER_NAME:=house-relay}"
: "${DRY_RUN:=0}"

say() { printf '  %s\n' "$*"; }
die() { printf '\n  %s\n\n' "$*" >&2; exit 1; }

printf '\n'

if [ "$DRY_RUN" = 0 ] && [ "$(id -u)" != 0 ]; then
  die "Run this with sudo — it writes to /opt and /etc."
fi

# The repo root is the parent of this script's directory.
HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(dirname -- "$HERE")
[ -f "$ROOT/house.js" ] || die "Run this from a clone of the dashboard repo: sudo sh bridge/install-on-pi.sh"

command -v node >/dev/null 2>&1 || die "No node. Install it first: sudo apt install -y nodejs"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 18 ] || die "Node $NODE_MAJOR is too old — the relay uses fetch, so it needs 18 or newer."
NODE_BIN=$(command -v node)
say "node $(node -v) at $NODE_BIN"

# ── a user that owns nothing ──────────────────────────────────────────
if [ "$DRY_RUN" != 0 ]; then
  say "dry run: skipping the $USER_NAME user"
elif id "$USER_NAME" >/dev/null 2>&1; then
  say "user $USER_NAME is already there"
else
  useradd --system --no-create-home --shell /usr/sbin/nologin "$USER_NAME" \
    || die "Could not make the $USER_NAME user."
  say "made the $USER_NAME system user"
fi

# ── the four files it runs ─────────────────────────────────────────────
# house.js keeps its place at the root: bridge/ imports it as ../house.js.
mkdir -p "$DEST/bridge"
cp "$ROOT/house.js" "$DEST/house.js"
cp "$ROOT/bridge/env.mjs" "$ROOT/bridge/ha.mjs" "$ROOT/bridge/house.mjs" "$DEST/bridge/"
if [ "$DRY_RUN" = 0 ]; then
  chown -R root:root "$DEST"
  chmod -R a=rX,u=rwX "$DEST"
fi
say "copied the relay to $DEST"

# ── what it needs to know ──────────────────────────────────────────────
mkdir -p "$(dirname -- "$ENV_FILE")" "$(dirname -- "$UNIT")"

if [ -f "$ENV_FILE" ]; then
  say "$ENV_FILE is already there — left alone"
else
  umask 077
  cat > "$ENV_FILE" <<'ENV'
# The house relay, on the hub. Fill in the Supabase half and HA_TOKEN, then
#   sudo systemctl restart house-relay
#
# This file holds a password and a key for your house. It is mode 600 and
# read by systemd, so nothing it contains is visible in `ps`.

# ── where the dashboard's relay is ────────────────────────────────────
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co

# Sign in as yourself: the publishable key, row-level security still on.
SUPABASE_ANON_KEY=sb_publishable_xxxxxxxxxxxxxxxxxxxx
SUPABASE_EMAIL=you@example.com
SUPABASE_PASSWORD=

# Or, instead of the three lines above, the service-role key.
# SUPABASE_SERVICE_KEY=

# ── the hub, which is this machine ────────────────────────────────────
# Loopback, because the relay and Home Assistant are on the same Pi — which
# is also how the relay works out that it is the one on the hub.
HA_URL=http://127.0.0.1:8123
# Home Assistant → your profile → Security → Long-lived access tokens.
HA_TOKEN=

# What the dashboard calls the house. Optional.
# HA_NAME=home

# Keep every diagnostic sensor (wifi strength, uptime, update available).
# HA_SENSORS=all

# A regex of entity ids to leave out entirely.
# HA_EXCLUDE=^light\.test_

# ── this relay's name on the dashboard ────────────────────────────────
# Optional. On the hub this relay outranks one on a PC by default, so the
# PC's stays on standby and obeys taps without fighting over the mirror.
# HOUSE_RELAY=hub
# HOUSE_RELAY_PRIORITY=10
ENV
  if [ "$DRY_RUN" = 0 ]; then chown root:root "$ENV_FILE"; fi
  chmod 600 "$ENV_FILE"
  say "wrote $ENV_FILE — fill it in"
fi

# ── the service ────────────────────────────────────────────────────────
sed "s#^ExecStart=.*#ExecStart=$NODE_BIN $DEST/bridge/house.mjs#" \
  "$ROOT/bridge/house-relay.service" > "$UNIT"
chmod 644 "$UNIT"
if [ "$DRY_RUN" != 0 ]; then
  say "dry run: wrote $UNIT, left systemd alone"
else
  systemctl daemon-reload
  systemctl enable house-relay >/dev/null 2>&1 || die "Could not enable the service."
  say "installed and enabled house-relay.service"
fi

printf '\n  Two things left:\n\n'
printf '    sudo nano %s        the Supabase half, and HA_TOKEN\n' "$ENV_FILE"
printf '    sudo systemctl restart house-relay\n\n'
printf '  Then watch it come up:\n\n'
printf '    journalctl -u house-relay -f\n\n'
printf '  It should say which relay it is and that it is mirroring the house.\n'
printf '  The dashboard then shows the hub as online whether or not your PC\n'
printf '  is awake, which is the whole point.\n\n'
