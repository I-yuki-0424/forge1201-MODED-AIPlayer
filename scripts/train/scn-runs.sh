#!/usr/bin/env bash
# Scenario runs on the PC (tools/sim/scenarios, docs/proposed/SCENARIO-v1.md): one run per scenario, concurrently, each with its own sim shards and GPU learner in WSL2.
#   scripts/train/scn-runs.sh up iron-a,iron-b,iron-c [--ckpt FILE [--ckpt-steps N]] [--budget 2000000] [--seed 61] [--shards 8] [--days 1] [--tag T] [--gpu-fraction F] [--learner-args "..."]
#   scripts/train/scn-runs.sh status | report iron-a,iron-b [--blocks 5 --entries a,b] [--tag T] | down iron-a,iron-b [--tag T]
# The run base is the scenario id (+ "-T" with --tag), so a second run of one scenario does not resume the first one's checkpoint. --ckpt starts every run from that learner
# checkpoint (the learner resumes it: --ckpt-steps is the step count inside the file, the budget counts from there); without it the policy starts fresh. Same seed in all runs.
# The PC's supervisors pause by themselves 12:00-18:00 JST (owner rule 2026-11-02): launch just before 18:00 (the 2026-11-04 iron runs: user timer forgeaip-iron-launch).
# Default learner settings = run `runc` of 2026-11-04 (the best of the full-game runs).
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd); PC=$REPO/scripts/train/pc.sh
cmd=${1:-status}; shift || true
list=""; case $cmd in up|report|down) list=${1:-}; shift || true; [ -n "$list" ] || { echo "usage: $0 $cmd SCENARIO[,SCENARIO..] [options]" >&2; exit 2; };; esac
ckpt="" cks=0 budget=2000000 seed=61 shards=8 days=1 tag="" frac="" largs="--scale 4 --tf32 1 --n-max 256 --enc-chunk 128 --aux-batch 64 --max-queue 200 --lr 7.5e-5 --ent 0.03" extra=()
while [ $# -gt 0 ]; do case $1 in --ckpt) ckpt=$2; shift 2;; --ckpt-steps) cks=$2; shift 2;; --budget) budget=$2; shift 2;; --seed) seed=$2; shift 2;; --shards) shards=$2; shift 2;;
  --days) days=$2; shift 2;; --tag) tag=$2; shift 2;; --gpu-fraction) frac=$2; shift 2;; --learner-args) largs=$2; shift 2;; --blocks|--entries) extra+=("$1" "$2"); shift 2;;
  *) echo "unknown option $1" >&2; exit 2;; esac; done
[[ $list =~ ^[a-z0-9_,-]*$ && $tag =~ ^[a-z0-9_-]*$ && $cks =~ ^[0-9]+$ && $budget =~ ^[0-9]+$ && $seed =~ ^[0-9]+$ ]] || { echo "bad option value" >&2; exit 2; }
IFS=, read -ra S <<< "$list"
base() { echo "$1${tag:+-$tag}"; }
case $cmd in
up)
  [ -z "$frac" ] && frac=$(python3 -c "print(round(min(0.38, 0.9 / ${#S[@]}), 2))")
  "$PC" wsl-install >/dev/null
  resume=()
  if [ -n "$ckpt" ]; then "$PC" wsl-put "$ckpt" >/dev/null; resume=(--resume-from "/home/sigure/x/seed/$(basename "$ckpt")"); fi
  for s in "${S[@]}"; do
    "$PC" wsl-up --base "$(base "$s")" --seed "$seed" --shards "$shards" --bots 2 --days "$days" --max-steps "$((cks + budget))" --gpu-fraction "$frac" --learner-args "$largs" --scenario "$s" "${resume[@]}"
  done;;
status) "$PC" wsl-status;;
report) bases=(); for s in "${S[@]}"; do bases+=("$(base "$s")"); done; "$PC" wsl-report "${bases[@]}" "${extra[@]}";;
down) for s in "${S[@]}"; do "$PC" wsl-down --base "$(base "$s")"; done;;
*) echo "usage: $0 up|status|report|down ..." >&2; exit 2;;
esac
