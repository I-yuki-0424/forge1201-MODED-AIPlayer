#!/usr/bin/env bash
# Run one of scripts/work/*_live.js against the demo server like /mnt/data/forgeaip-play/demo/live.sh, but pass extra environment variables through:
#   scripts/work/live-demo.sh move3_live.js MODE=move3 N=2 LIVE_OUT=/out/x.json        (/out is /mnt/data/forgeaip-play/demo/out)
#   NAME=value words become environment variables, everything else (--flag value) goes to the script as arguments
set -euo pipefail
SCRIPT=${1:?script}; shift
DEMO=/mnt/data/forgeaip-play/demo
export XDG_RUNTIME_DIR=/run/user/1000 DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/1000/docker.sock}
. "$DEMO/.env"
EXTRA=(); ARGS=(); for a in "$@"; do case "$a" in --*) ARGS+=("$a");; *=*) EXTRA+=(-e "$a");; *) ARGS+=("$a");; esac; done
exec docker run --rm --name "live-demo-$$" --network forgeaip-demo_demo -v /home/coder/projects/forge1201-MODED-AIPlayer:/app:ro -v "$DEMO/../registry.json":/play/registry.json:ro -v "$DEMO/out":/out -w /app \
  -e MC_HOST=demo -e RCON_HOST=demo -e RCON_PASSWORD="$RCON_PASSWORD" -e BOT_MOD_TABLE=/play/registry.json -e BOT_REGISTRY=auto "${EXTRA[@]}" \
  node@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 node "scripts/work/$SCRIPT" "${ARGS[@]}"
