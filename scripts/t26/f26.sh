#!/usr/bin/env bash
# scripts/t26/f26.sh MODE script.js [NAME=value ...] [--flag ...]   run a harness script of scripts/t26/ against one of the owner's three standing Fabric 26.1.2 servers
# (/mnt/data/fabric26-worlds, compose project fabric26-worlds; seed 1359280 on all three): MODE = creative (100.77.246.23:25601) | survival-hard (25602, no cheats, Hard)
# | survival-op (25603, OP Seia_Y, Normal). The tests are DESTRUCTIVE at the spawn (mine_b digs the spawn chunk, place_b clears a site beside it, the kit replaces a bot's pack):
# run them only when the owner is not building there. T26_WORLD (bot names: Pit<N>, Bld<N> ...) is 1 creative, 2 survival-hard, 3 survival-op. Results: /mnt/data/forgeaip-play/t26/out.
set -euo pipefail
MODE=${1:?creative|survival-hard|survival-op}; shift; SCRIPT=${1:?script}; shift
case $MODE in creative) N=1;; survival-hard) N=2;; survival-op) N=3;; *) echo "unknown mode $MODE" >&2; exit 2;; esac
F=/mnt/data/fabric26-worlds; HOME_=/mnt/data/forgeaip-play/t26; mkdir -p "$HOME_/out"
export XDG_RUNTIME_DIR=/run/user/1000 DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/1000/docker.sock}
. "$F/.env"
SELF=/home/coder/projects/forge1201-MODED-AIPlayer
EXTRA=(); ARGS=(); for a in "$@"; do case "$a" in --*) ARGS+=("$a");; *=*) EXTRA+=(-e "$a");; *) ARGS+=("$a");; esac; done
exec docker run --rm --name "live-f26-$MODE-$$" --network fabric26-worlds_default --memory 3g -v "${REPO:-$SELF}":/app:ro -v "$SELF/node_modules":/app/node_modules:ro -v "$HOME_/out":/out -w /app \
  -e MC_HOST="$MODE" -e RCON_HOST="$MODE" -e RCON_PASSWORD="$RCON_PASSWORD" -e MC_VERSION=26.1 -e BOT_REGISTRY=vanilla -e T26_WORLD="$N" "${EXTRA[@]}" \
  node@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 sh -c 'exec node $NODE_ARGS "$0" "$@"' "scripts/t26/$SCRIPT" "${ARGS[@]}"
