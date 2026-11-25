#!/usr/bin/env bash
# scripts/t26/vacuum.sh N [off]   load (or switch off) the vacuum app on test world N: block drops near a survival player go straight into the pack (docker/tw/vacuum.sc; owner 2026-11-21).
# Only for a profile without an auto-pickup mod (the frozen 26.x worlds); the 1.21.1 worlds run simple-autopickup, which gives a broken block's drops to the one who broke it.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/profile.sh"
tw_names "${1:?world}"; ACT=${2:-on}
if [ "$ACT" = off ]; then "$TW_REPO/scripts/t26/rcon.sh" "$TW_N" vacuum off; exit 0; fi
docker cp "$TW_REPO/docker/tw/vacuum.sc" "$TW_SERVER:/data/world/scripts/vacuum.sc"
"$TW_REPO/scripts/t26/rcon.sh" "$TW_N" script load vacuum global
