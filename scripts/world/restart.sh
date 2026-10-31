#!/usr/bin/env bash
# Restart the build world (after a change of modpack/forgeaip-create.lock.json: up.sh syncs the jars). Snapshots first.
source "$(dirname "$0")/lib.sh"
if running "$WORLD"; then "$(dirname "$0")/snapshot.sh" auto-before-restart; fi
python3 -I "$REPO/modpack/pack.py" server "$MODS"
compose restart world
wait_healthy "$WORLD"
"$(dirname "$0")/up.sh"
if running forgeaip-llm-bot; then compose --profile bot restart llm-bot >/dev/null; fi
