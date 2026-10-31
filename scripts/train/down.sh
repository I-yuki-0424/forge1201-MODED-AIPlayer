#!/usr/bin/env bash
# Stop RL training (learner first, so its last checkpoint is written), then bring back what up.sh stopped.
source "$(dirname "$0")/lib.sh"
systemctl --user disable --now forgeaip-train-hold.timer 2>/dev/null || true
maint-hold release forgeaip-train >/dev/null 2>&1 || true
compose --profile train stop -t 60 train-policy train-env train
grep -qx world "$TRAIN_STATE" 2>/dev/null && "$REPO/scripts/world/up.sh"
grep -qx llm-bot "$TRAIN_STATE" 2>/dev/null && "$REPO/scripts/world/bot-up.sh"
rm -f "$TRAIN_STATE"
echo "training stopped"
