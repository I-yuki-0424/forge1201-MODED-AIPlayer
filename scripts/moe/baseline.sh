#!/usr/bin/env bash
# Controls on one expert's scenario: random and scripted-solver success on the HELD-OUT worlds (vps-s3, vps-s4), before any training.
#   scripts/moe/baseline.sh EXPERT [EPISODES]   -> $MOE_ROOT/runs/EXPERT/controls.jsonl
source "$(dirname "$0")/lib.sh"
e=${1:?expert}; n=${2:-200}
py 1 1g gen --out /m/scenarios >/dev/null
mkdir -p "$MOE_ROOT/runs/$e"
for pol in random solver; do
  base=ctl-$e-$pol
  rm -f "$MOE_ROOT/x/$base".s*.current
  shards_up "$base" "$e" vps-s3,vps-s4 2 2 9000 0.5
  py 1 1g eval --expert "$e" --root /m/x --base "$base" --shards 0,1 --policy $pol --episodes "$n" --out /m/runs/$e/controls.jsonl
  shards_down "$base"
done
