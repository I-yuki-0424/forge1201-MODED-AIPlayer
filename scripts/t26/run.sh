#!/usr/bin/env bash
# scripts/t26/run.sh N script.js [NAME=value ...] [--flag ...]   run a harness script of scripts/t26/ against test world N of the current profile (the bots speak the profile's
# protocol; container live-<tag>-N-<pid>). NAME=value words become environment variables (NODE_ARGS=--cpu-prof... goes to node itself), --flags go to the script.
# REPO=/path runs another checkout (a worktree). Results: /mnt/data/forgeaip-play/t26/out (= /out in the container).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/profile.sh"
tw_names "${1:?world number}"; shift; SCRIPT=${1:?script}; shift
mkdir -p "$TW_HOME/out"
. "$TW_HOME/.env"; tw_bot_env
SELF=/home/coder/projects/forge1201-MODED-AIPlayer
EXTRA=(); ARGS=(); for a in "$@"; do case "$a" in --*) ARGS+=("$a");; *=*) EXTRA+=(-e "$a");; *) ARGS+=("$a");; esac; done
exec docker run --rm --name "live-$TW_TAG-$TW_N-$$" --network "$TW_NET" --memory "${MEM:-3g}" -v "${REPO:-$SELF}":/app:ro -v "$SELF/node_modules":/app/node_modules:ro -v "$TW_HOME/out":/out -w /app \
  "${TW_ENV[@]}" "${EXTRA[@]}" \
  "$NODE_IMG" sh -c 'exec node $NODE_ARGS "$0" "$@"' "scripts/t26/$SCRIPT" "${ARGS[@]}"
