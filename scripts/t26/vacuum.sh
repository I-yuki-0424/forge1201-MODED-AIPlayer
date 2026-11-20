#!/usr/bin/env bash
# scripts/t26/vacuum.sh N [off]   load (or switch off) the vacuum app on T26 world N: block drops near a survival player go straight into the pack (docker/t26/vacuum.sc; owner 2026-11-21).
set -euo pipefail
N=${1:?world}; ACT=${2:-on}; REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
export XDG_RUNTIME_DIR=/run/user/1000 DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/1000/docker.sock}
if [ "$ACT" = off ]; then "$REPO/scripts/t26/rcon.sh" "$N" vacuum off; exit 0; fi
docker cp "$REPO/docker/t26/vacuum.sc" "forgeaip-t26-$N:/data/world/scripts/vacuum.sc"
"$REPO/scripts/t26/rcon.sh" "$N" script load vacuum global
