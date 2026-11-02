#!/usr/bin/env bash
# Quiet hours for the whole training (owner 2026-11-02: the PC is for private life and work, so no heavy load there 12:00-18:00 JST;
# the learner runs on the PC and the VPS groups cannot act without it, so both sides pause together).
#   scripts/train/window.sh check|pause|resume
# check (called every 5 minutes by forgeaip-train-window.timer, idempotent, survives reboots): inside the window -> pause, outside ->
# resume, when training is on (exchange/.train-state exists, written by up.sh, removed by down.sh). Nothing is lost by a pause: the
# worlds are saved by the servers' stop, the learner's checkpoint is written after every update, the relay and the page stay up.
source "$(dirname "$0")/lib.sh"
PAUSED=$REPO/exchange/.train-paused
PCENV=$REPO/exchange/.train-pc-env
FROM=${QUIET_FROM:-12} TO=${QUIET_TO:-18}
inwin() { local h; h=$((10#$(TZ=Asia/Tokyo date +%H))); [ "$h" -ge "$FROM" ] && [ "$h" -lt "$TO" ]; }
cmd=${1:-check}
[ -e "$TRAIN_STATE" ] || exit 0                       # no training on
all=(--profile train --profile shard1 --profile shard2 --profile shard3 --profile shard4)
pause() {
  [ -e "$PAUSED" ] && return 0
  touch "$PAUSED"
  [ -s "$PCENV" ] && "$REPO/scripts/train/pc.sh" pause || true
  compose "${all[@]}" stop -t 60 train-policy >/dev/null 2>&1 || true
  # the environments first (they end their episodes), then the servers (stop saves the world)
  compose "${all[@]}" stop -t 60 train-env train-env-s1 train-env-s2 train-env-s3 train-env-s4 >/dev/null 2>&1 || true
  compose "${all[@]}" stop -t 90 train train-s1 train-s2 train-s3 train-s4 >/dev/null 2>&1 || true
  echo "training paused (quiet hours $FROM-$TO JST)"
}
resume() {
  [ -e "$PAUSED" ] || return 0
  [ -s "$TRAIN_ENV" ] || { echo "no $TRAIN_ENV" >&2; return 1; }
  set -a; source "$TRAIN_ENV"; set +a
  [ -s "$PCENV" ] && "$REPO/scripts/train/pc.sh" resume || true
  profiles=(--profile train); servers=(train); envs=(train-env)
  for i in $(seq 1 $((TRAIN_SHARDS - 1))); do profiles+=(--profile "shard$i"); servers+=("train-s$i"); envs+=("train-env-s$i"); done
  learner=(train-policy); [ -s "$PCENV" ] && learner=()
  compose "${profiles[@]}" up -d "${servers[@]}"
  for s in "${servers[@]}"; do wait_healthy "forgeaip-$s"; done
  compose "${profiles[@]}" up -d "${envs[@]}" "${learner[@]}"
  rm -f "$PAUSED"
  echo "training resumed"
}
case $cmd in
  check) if inwin; then pause; else resume; fi;;
  pause) pause;; resume) resume;;
  *) echo "usage: $0 check|pause|resume" >&2; exit 2;;
esac
