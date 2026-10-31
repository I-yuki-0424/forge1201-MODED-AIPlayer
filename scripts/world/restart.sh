#!/usr/bin/env bash
# Restart the build world (after copying mods: they are mirrored into the server on start). Snapshots the world first.
source "$(dirname "$0")/lib.sh"
if running "$WORLD"; then "$(dirname "$0")/snapshot.sh" auto-before-restart; fi
compose restart world
wait_healthy "$WORLD"
"$(dirname "$0")/up.sh"
if running forgeaip-llm-bot; then compose --profile bot restart llm-bot >/dev/null; fi
