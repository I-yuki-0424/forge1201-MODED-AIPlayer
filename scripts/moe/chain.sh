#!/usr/bin/env bash
# The whole chain from a start to the goal item, on the held-out worlds: router + experts as one policy.
#   scripts/moe/chain.sh SCENARIO(chain-placed|chain-natural) ROUTER(rules|xgb|lgb) EXPERTS(net|solver) [EPISODES]   -> $MOE_ROOT/runs/chain.jsonl
source "$(dirname "$0")/lib.sh"
scn=${1:?scenario}; rt=${2:?router}; ex=${3:?experts}; n=${4:-60}
case $rt in rules) r=rules;; xgb|lgb) r=$rt:/m/runs/router/router.$rt;; *) echo "router: rules|xgb|lgb" >&2; exit 2;; esac
case $ex in net) e=net:/m/runs;; solver) e=solver;; *) echo "experts: net|solver" >&2; exit 2;; esac
py 1 1g gen --out /m/scenarios >/dev/null
base=ch-$scn-$rt-$ex
rm -f "$MOE_ROOT/x/$base".s*.current
shards_up "$base" "$scn" vps-s3,vps-s4 2 2 7000 0.5
py 1 2g chain --root /m/x --base "$base" --shards 0,1 --router "$r" --experts "$e" --episodes "$n" --scenario "$scn" --out /m/runs/chain.jsonl
shards_down "$base"
