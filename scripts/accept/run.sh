#!/usr/bin/env bash
# Run one of scripts/accept/*.js against acceptance world $ACC (default 1): a Fabric server, random seed, peaceful (/mnt/data/forgeaip-play/accept, container forgeaip-accept-N).
#   ACC=2 scripts/accept/run.sh t2_walk.js DIST=2000 LIVE_OUT=/out/t2.json        NAME=value words become environment variables, --flags go to the script
# REPO=/path/to/another/checkout runs that checkout instead. Result files: /mnt/data/forgeaip-play/accept/out (= /out in the container).
set -euo pipefail
N=${ACC:-1}; HOME_=/mnt/data/forgeaip-play/accept; mkdir -p "$HOME_/out"
export XDG_RUNTIME_DIR=/run/user/1000 DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/1000/docker.sock}
. "$HOME_/.env"
SCRIPT=${1:?script}; shift
EXTRA=(); ARGS=(); for a in "$@"; do case "$a" in --*) ARGS+=("$a");; *=*) EXTRA+=(-e "$a");; *) ARGS+=("$a");; esac; done
exec docker run --rm --name "live-accept-$N-$$" --network "forgeaip-accept-${N}_net" -v "${REPO:-/home/coder/projects/forge1201-MODED-AIPlayer}":/app:ro -v /home/coder/projects/forge1201-MODED-AIPlayer/node_modules:/app/node_modules:ro -v "$HOME_/out":/out -w /app \
  -e MC_HOST=accept -e RCON_HOST=accept -e RCON_PASSWORD="$RCON_PASSWORD" -e BOT_REGISTRY=auto "${EXTRA[@]}" \
  node@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 node "scripts/accept/$SCRIPT" "${ARGS[@]}"
