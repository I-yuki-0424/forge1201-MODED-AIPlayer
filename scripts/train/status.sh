#!/usr/bin/env bash
# One screen of training state: containers, holds, current run, last learner line, episodes so far.
source "$(dirname "$0")/lib.sh"
base=${1:-train}
docker ps --filter name=forgeaip-train --format '{{.Names}}\t{{.Status}}'
maint-hold list
run=$(cat "$REPO/exchange/$base.current" 2>/dev/null || true)
echo "run: ${run:-none}"
[ -n "$run" ] && python3 -I "$REPO/scripts/train/summary.py" "$REPO/exchange" "$base"
