#!/usr/bin/env bash
# Recreate training containers with the running training's settings (exchange/.train-env, written by up.sh), e.g. after a
# learner or page code change:  scripts/train/restart.sh train-policy [train-dash ...]
# The learner resumes from its checkpoint and joins the live runs where they are (DPOD botsystem_skill_ppo.catch_up).
source "$(dirname "$0")/lib.sh"
[ -s "$TRAIN_ENV" ] || { echo "no $TRAIN_ENV: start the training with scripts/train/up.sh" >&2; exit 1; }
[ $# -ge 1 ] || { echo "usage: $0 train-policy|train-dash|train-env|train-env-s1..4 ..." >&2; exit 2; }
for s in "$@"; do case $s in train-policy|train-dash|train-env) p=train;; train-env-s[1-4]|train-s[1-4]) p=shard${s##*-s};; *) echo "unknown service $s" >&2; exit 2;; esac
  ps+=(--profile "$p"); done
set -a; source "$TRAIN_ENV"; set +a
compose "${ps[@]}" up -d --force-recreate --no-deps "$@"
