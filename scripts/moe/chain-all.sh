#!/usr/bin/env bash
# The chain on both scenarios with every router/expert pairing (rules+solver is the ceiling of the scripted system), PAR runs at a time.
#   scripts/moe/chain-all.sh [--par 2] [--episodes 60]      -> $MOE_ROOT/runs/chain.jsonl
source "$(dirname "$0")/lib.sh"
par=2 n=60
while [ $# -gt 0 ]; do case $1 in --par) par=$2; shift 2;; --episodes) n=$2; shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done
rm -f "$MOE_ROOT/runs/chain.jsonl"
for scn in chain-placed chain-natural; do for combo in "rules solver" "rules net" "xgb net" "lgb net"; do echo "$scn $combo"; done; done \
  | xargs -P "$par" -L 1 sh -c "'$REPO/scripts/moe/chain.sh' \$0 \$1 \$2 $n > /dev/null 2>&1"
