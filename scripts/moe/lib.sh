#!/usr/bin/env bash
# Shared by scripts/moe/*.sh: paths, the shard launcher and the Python container (moe-venv: jax, optax, xgboost, lightgbm; no network).
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MOE_ROOT=${MOE_ROOT:-/mnt/data/forgeaip/moe}          # exchange files, scenarios, checkpoints, logs (outside the repo)
TILES=${SIM_TILES:-/mnt/data/forgeaip/sim-tiles}
SIMBIN=$REPO/tools/sim/target/bookworm/release/forgeaip-sim
mkdir -p "$MOE_ROOT/x" "$MOE_ROOT/scenarios" "$MOE_ROOT/runs"

# shards_up NAME SCENARIO WORLDS(comma list) COUNT BOTS SEED CPUS : COUNT simulator shards, containers moe-NAME-s<i>, files $MOE_ROOT/x/NAME.s<i>.current
shards_up() {
  local name=$1 scn=$2 worlds=$3 n=$4 bots=$5 seed=$6 cpus=$7 i w
  IFS=, read -ra W <<< "$worlds"
  rm -f "$MOE_ROOT/x/$name.done"
  for i in $(seq 0 $((n - 1))); do
    w=${W[$((i % ${#W[@]}))]}
    docker rm -f "moe-$name-s$i" >/dev/null 2>&1 || true
    docker run -d --name "moe-$name-s$i" --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
      --memory 700m --cpus "$cpus" --label moe=1 -v "$MOE_ROOT/x":/x -v "$TILES":/tiles:ro -v "$REPO/src/rl":/r:ro -v "$MOE_ROOT/scenarios":/s:ro \
      -v "$SIMBIN":/forgeaip-sim:ro debian:bookworm-slim /forgeaip-sim run --root /x --base "$name" --shard "$i" --bots "$bots" --days 3 --tiles /tiles --world "$w" \
      --reward /r/reward-v6.json --progress /r/progress-list.json --seed "$((seed + i))" --scenario "/s/$scn.json" >/dev/null
  done
}
shards_down() { docker ps -aq --filter "name=moe-$1-s" | xargs -r docker rm -f >/dev/null 2>&1 || true; }

# py CPUS MEM ARGS... : python -m moe.cli ARGS in the venv container (repo read-only, exchange read-write)
py() {
  local cpus=$1 mem=$2; shift 2
  docker run --rm --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true --cpus "$cpus" --memory "$mem" \
    -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONPATH=/w -e XLA_FLAGS="--xla_cpu_multi_thread_eigen=false intra_op_parallelism_threads=$cpus" -e JAX_PLATFORMS=cpu \
    -v moe-venv:/venv:ro -v "$REPO":/w:ro -v "$MOE_ROOT":/m -w /w moe-py:1 /venv/bin/python -m moe.cli "$@"
}
