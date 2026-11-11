#!/usr/bin/env bash
# Run one of scripts/real/*.js against the REAL-WORLD TEST COPY of the play world (/mnt/data/forgeaip-play/real, container forgeaip-real).
#   scripts/real/run.sh real_move.js N=40 SEED=1 LIVE_OUT=/out/move1.json        NAME=value words become environment variables, --flags go to the script
# REPO=/path/to/another/checkout runs that checkout instead (an A/B against an older commit: git worktree add).
# Result files: /mnt/data/forgeaip-play/real/out (= /out in the container).
set -euo pipefail
REAL=/mnt/data/forgeaip-play/real; mkdir -p "$REAL/out"
export XDG_RUNTIME_DIR=/run/user/1000 DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/1000/docker.sock}
. "$REAL/.env"
SCRIPT=${1:?script}; shift
EXTRA=(); ARGS=(); for a in "$@"; do case "$a" in --*) ARGS+=("$a");; *=*) EXTRA+=(-e "$a");; *) ARGS+=("$a");; esac; done
exec docker run --rm --name "live-real-$$" --network forgeaip-real_real -v "${REPO:-/home/coder/projects/forge1201-MODED-AIPlayer}":/app:ro -v "$REAL/../registry.json":/play/registry.json:ro -v /home/coder/projects/forge1201-MODED-AIPlayer/node_modules:/app/node_modules:ro -v "$REAL/out":/out -v /mnt/data/forgeaip-play/console-data:/console:ro -w /app \
  -e MC_HOST=real -e RCON_HOST=real -e RCON_PASSWORD="$RCON_PASSWORD" -e BOT_MOD_TABLE=/play/registry.json -e BOT_REGISTRY=auto "${EXTRA[@]}" \
  node@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 node "scripts/real/$SCRIPT" "${ARGS[@]}"
