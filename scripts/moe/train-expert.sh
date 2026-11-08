#!/usr/bin/env bash
# Train one expert on simulator shards (train worlds vps-s0..s2), then evaluate it on the held-out worlds (vps-s3, vps-s4) next to the two controls.
#   scripts/moe/train-expert.sh EXPERT [--steps N] [--shards 3] [--cpus 1.5] [--seed 0] [--skip-eval]
# Results: $MOE_ROOT/runs/EXPERT/{train_log.jsonl,episodes.jsonl,final.npz,checkpoint.npz,eval.jsonl,controls.jsonl}
source "$(dirname "$0")/lib.sh"
e=${1:?expert}; shift
steps=300000 shards=3 cpus=1.5 seed=0 eval=1 episodes=200
while [ $# -gt 0 ]; do case $1 in
  --steps) steps=$2; shift 2;; --shards) shards=$2; shift 2;; --cpus) cpus=$2; shift 2;; --seed) seed=$2; shift 2;; --skip-eval) eval=0; shift;; --episodes) episodes=$2; shift 2;;
  *) echo "unknown option $1" >&2; exit 2;; esac; done
[[ $e =~ ^[a-z_]+$ && $steps =~ ^[0-9]+$ && $shards =~ ^[1-6]$ && $seed =~ ^[0-9]+$ ]] || { echo "bad argument" >&2; exit 2; }
py 1 1g gen --out /m/scenarios >/dev/null
out=$MOE_ROOT/runs/$e; mkdir -p "$out"
base=tr-$e
rm -f "$MOE_ROOT/x/$base".s*.current "$MOE_ROOT/x/$base.done"
shards_up "$base" "$e" vps-s0,vps-s1,vps-s2 "$shards" 2 "$((1000 + seed * 100))" 0.4
trap 'shards_down "$base"' EXIT
ids=$(seq -s, 0 $((shards - 1)))
py "$cpus" 4g train --expert "$e" --root /m/x --base "$base" --shards "$ids" --out "/m/runs/$e" --budget "$steps" --seed "$seed" | tail -1 | tee "$out/train_result.json"
shards_down "$base"
if [ "$eval" = 1 ] && [ -f "$out/final.npz" ]; then
  rm -f "$out/eval.jsonl"
  eb=ev-$e
  rm -f "$MOE_ROOT/x/$eb".s*.current
  shards_up "$eb" "$e" vps-s3,vps-s4 2 2 "$((9000 + seed))" 0.5
  py 1 2g eval --expert "$e" --root /m/x --base "$eb" --shards 0,1 --policy "net:/m/runs/$e/final.npz" --episodes "$episodes" --seed 1 --out "/m/runs/$e/eval.jsonl"
  shards_down "$eb"
fi
