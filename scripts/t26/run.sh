#!/usr/bin/env bash
# scripts/t26/run.sh N script.js [NAME=value ...] [--flag ...]   run a harness script of scripts/t26/ against T26 world N (bots speak 26.1; container live-t26-N-<pid>).
# NAME=value words become environment variables (NODE_ARGS=--cpu-prof... goes to node itself), --flags go to the script. REPO=/path runs another checkout. Results: /mnt/data/forgeaip-play/t26/out (= /out in the container).
set -euo pipefail
N=${1:?world number}; shift; SCRIPT=${1:?script}; shift
HOME_=/mnt/data/forgeaip-play/t26; mkdir -p "$HOME_/out"
export XDG_RUNTIME_DIR=/run/user/1000 DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/1000/docker.sock}
. "$HOME_/.env"
SELF=/home/coder/projects/forge1201-MODED-AIPlayer
EXTRA=(); ARGS=(); for a in "$@"; do case "$a" in --*) ARGS+=("$a");; *=*) EXTRA+=(-e "$a");; *) ARGS+=("$a");; esac; done
exec docker run --rm --name "live-t26-$N-$$" --network "forgeaip-t26-${N}_net" --memory 3g -v "${REPO:-$SELF}":/app:ro -v "$SELF/node_modules":/app/node_modules:ro -v "$HOME_/out":/out -w /app \
  -e MC_HOST=mc -e RCON_HOST=mc -e RCON_PASSWORD="$RCON_PASSWORD" -e MC_PLATFORM=fabric -e MC_VERSION=26.1 -e BOT_REGISTRY=vanilla -e T26_WORLD="$N" "${EXTRA[@]}" \
  node@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 sh -c 'exec node $NODE_ARGS "$0" "$@"' "scripts/t26/$SCRIPT" "${ARGS[@]}"
