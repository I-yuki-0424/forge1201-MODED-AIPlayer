#!/usr/bin/env bash
# Called by forgeaip-train-hold.timer: while the learner runs, keep a maint-hold lease (480 min, renewed every 30 min)
# so rootwatch's daily maintenance does not reboot the VPS under a training run. Releases it when the learner is gone.
source "$(dirname "$0")/lib.sh"
if running forgeaip-train-policy || running forgeaip-train-env; then maint-hold forgeaip-train 480 "RL training run (forge1201-MODED-AIPlayer scripts/train)"
else maint-hold release forgeaip-train >/dev/null 2>&1 || true; fi
