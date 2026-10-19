# The house relay, on the hub itself. Node on Alpine and nothing else: the
# relay has no dependencies on purpose, so there is no install step here and
# no lockfile to go stale.
#
# `relay/` is put here by `npm run addon` (tools/pack-addon.mjs) — a local
# add-on is built on the hub, where the build context is this directory, so
# the files cannot be reached as ../../house.js.
ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base:3.19
FROM ${BUILD_FROM}

# jq reads the add-on's options; nodejs runs the relay.
RUN apk add --no-cache nodejs jq

WORKDIR /opt/relay

# house.js keeps its place at the root of the copy: bridge/house.mjs imports
# it as ../house.js and that has to go on being true.
COPY relay/ /opt/relay/
COPY run.sh /run.sh
RUN chmod +x /run.sh

# Fail the build rather than the hub if the pack script missed something.
RUN node --input-type=module -e "import('/opt/relay/bridge/house.mjs')"

CMD [ "/run.sh" ]
