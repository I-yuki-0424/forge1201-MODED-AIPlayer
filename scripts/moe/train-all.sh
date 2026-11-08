#!/usr/bin/env bash
# Train and evaluate every expert of the catalogue, PAR at a time (default 3), hardest first.
#   scripts/moe/train-all.sh [--par 3] [--steps 300000] [--seed 0] [expert ...]      log: $MOE_ROOT/runs/train-all.log
source "$(dirname "$0")/lib.sh"
par=3 steps=300000 seed=0 list=()
while [ $# -gt 0 ]; do case $1 in --par) par=$2; shift 2;; --steps) steps=$2; shift 2;; --seed) seed=$2; shift 2;; *) list+=("$1"); shift;; esac; done
[ ${#list[@]} -gt 0 ] || list=(raw_iron coal cobblestone iron_ingot log wooden_pickaxe stone_pickaxe furnace iron_pickaxe crafting_table stick planks)
printf '%s\n' "${list[@]}" | xargs -P "$par" -I{} sh -c "'$REPO/scripts/moe/train-expert.sh' {} --steps $steps --seed $seed --shards 3 > '$MOE_ROOT/runs/{}.out' 2>&1; echo \"\$(date +%T) {} finished (exit \$?)\" >> '$MOE_ROOT/runs/train-all.log'"
