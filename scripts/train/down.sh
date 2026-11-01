#!/usr/bin/env bash
# Stop RL training (learner first, so its last checkpoint is written), then bring back what up.sh stopped.
source "$(dirname "$0")/lib.sh"
systemctl --user disable --now forgeaip-train-hold.timer 2>/dev/null || true
maint-hold release forgeaip-train >/dev/null 2>&1 || true
compose --profile train --profile shard1 --profile shard2 --profile shard3 stop -t 60 train-policy train-env train-env-s1 train-env-s2 train-env-s3 train-dash train train-s1 train-s2 train-s3
tailscale serve --tcp 3021 off >/dev/null 2>&1 || true
grep -qx world "$TRAIN_STATE" 2>/dev/null && "$REPO/scripts/world/up.sh"
grep -qx llm-bot "$TRAIN_STATE" 2>/dev/null && "$REPO/scripts/world/bot-up.sh"
rm -f "$TRAIN_STATE"
echo "training stopped"
