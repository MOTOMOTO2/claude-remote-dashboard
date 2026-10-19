#!/bin/sh
# Turn the add-on's options into the environment bridge/house.mjs expects,
# then hand over to it. Nothing here is clever on purpose: the add-on is a
# thin wrapper so that the relay on the hub and the relay on a PC stay the
# same code, tested once.
set -eu

CONFIG=/data/options.json

# One option, or the empty string. jq is in every Home Assistant base image.
opt() {
  jq -r --arg k "$1" 'if (.[$k] == null) then "" else (.[$k] | tostring) end' "$CONFIG"
}

export SUPABASE_URL="$(opt supabase_url)"
export SUPABASE_ANON_KEY="$(opt supabase_anon_key)"
export SUPABASE_EMAIL="$(opt supabase_email)"
export SUPABASE_PASSWORD="$(opt supabase_password)"

service_key="$(opt supabase_service_key)"
if [ -n "$service_key" ]; then
  export SUPABASE_SERVICE_KEY="$service_key"
fi

# The whole reason this is an add-on: the Supervisor proxies Home Assistant's
# own API at this address, authenticated with a token it hands us on startup.
# There is no long-lived access token to make, and nothing to keep in sync
# when one is rotated.
export HA_URL="http://supervisor/core"
export HA_TOKEN="${SUPERVISOR_TOKEN:-}"

hub_name="$(opt hub_name)"
if [ -n "$hub_name" ]; then
  export HA_NAME="$hub_name"
fi

exclude="$(opt exclude)"
if [ -n "$exclude" ]; then
  export HA_EXCLUDE="$exclude"
fi

if [ "$(opt keep_all_sensors)" = "true" ]; then
  export HA_SENSORS=all
fi

poll="$(opt poll_seconds)"
case "$poll" in
  '' | *[!0-9]*) poll=10 ;;
esac
export HA_POLL_MS=$((poll * 1000))

# This relay is on the hub, so it outranks one on a PC and is the one that
# mirrors devices. HA_URL already says as much — `supervisor` is reachable
# from nowhere else — but being explicit survives someone editing it.
relay_name="$(opt relay_name)"
export HOUSE_RELAY="${relay_name:-hub}"
export HOUSE_RELAY_HOST=hub
export HOUSE_RELAY_PRIORITY=10

if [ -z "$SUPABASE_URL" ]; then
  echo "Set supabase_url on this add-on's Configuration tab first." >&2
  exit 1
fi
if [ -z "${SUPABASE_SERVICE_KEY:-}" ] && [ -z "$SUPABASE_ANON_KEY" ]; then
  echo "Set supabase_anon_key with your email and password, or supabase_service_key." >&2
  exit 1
fi
if [ -z "$HA_TOKEN" ]; then
  echo "No SUPERVISOR_TOKEN — this has to run as an add-on, with homeassistant_api: true." >&2
  exit 1
fi

echo "house relay starting on the hub, relaying to ${SUPABASE_URL}"
exec node /opt/relay/bridge/house.mjs
