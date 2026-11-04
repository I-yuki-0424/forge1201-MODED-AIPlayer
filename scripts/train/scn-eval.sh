#!/usr/bin/env bash
# Zero-shot evaluation on a scenario (tools/sim/scenarios, docs/proposed/SCENARIO-v1.md) on the VPS CPU: the policy of a checkpoint (or a fresh,
# untrained network = the chance baseline) acts without learning for N episodes; read the result with tools/sim/scn_report.py.
#   scripts/train/scn-eval.sh --scenario iron-a --base zs-a-runc [--ckpt /mnt/data/forgeaip/pc-runs-20261104/runc.pkl --ckpt-steps 2001738] [--episodes 150] [--days 1]
# --ckpt-steps: the checkpoint's own step count (the learner resumes it and --max-steps counts from there). No network, read-only containers, nothing but exchange/.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd); DPOD=${DPOD_DIR:-$(cd "$REPO/../Decision-Process-order-driven" && pwd)}
BIN=$REPO/tools/sim/target/bookworm/release/forgeaip-sim; TILES=${SIM_TILES:-/mnt/data/forgeaip/sim-tiles}
scn="" base="" ckpt="" cks=0 eps=150 days=1 shards=4 seed=7
while [ $# -gt 0 ]; do case $1 in --scenario) scn=$2; shift 2;; --base) base=$2; shift 2;; --ckpt) ckpt=$2; shift 2;; --ckpt-steps) cks=$2; shift 2;;
  --episodes) eps=$2; shift 2;; --days) days=$2; shift 2;; --shards) shards=$2; shift 2;; --seed) seed=$2; shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done
[[ $scn =~ ^[a-z0-9_-]+$ && $base =~ ^[a-z0-9_-]{1,40}$ && $eps =~ ^[0-9]+$ && $cks =~ ^[0-9]+$ && $days =~ ^[1-9]$ && $shards =~ ^[1-6]$ ]] || { echo "bad option" >&2; exit 2; }
[ -f "$REPO/tools/sim/scenarios/$scn.json" ] || { echo "no scenario $scn" >&2; exit 2; }
X=$REPO/exchange; L=zs-$base; steps=$((cks + eps * 24000 * days / 55 * 3))   # a stop far beyond the target; the episodes are counted below
mkdir -p "$X/$base/train"; rm -f "$X/$base.done"
[ -n "$ckpt" ] && cp "$ckpt" "$X/$base/train/checkpoint.pkl"
cleanup() { docker ps -aq --filter "name=$L-" | xargs -r docker rm -f >/dev/null 2>&1 || true; }
trap cleanup EXIT; cleanup
docker run -d --name $L-learner --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true --memory 3g --cpus 2 -e PYTHONDONTWRITEBYTECODE=1 \
  -e XLA_FLAGS="--xla_cpu_multi_thread_eigen=false intra_op_parallelism_threads=2" -v rl-jaxvenv:/venv:ro -v "$DPOD":/dpod:ro -v "$X":/x python:3.12-slim \
  sh -c "exec /venv/bin/python /dpod/scripts/botsystem_goal_ppo.py --root /x --base $base --learn 0 --seed 42 --population 1 --max-steps $steps" >/dev/null
sleep 3
for i in $(seq 0 $((shards - 1))); do
  docker run -d --name $L-s$i --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true --memory 900m --cpus 0.5 -v "$X":/x -v "$TILES":/tiles:ro \
    -v "$REPO/src/rl":/r:ro -v "$REPO/tools/sim/scenarios":/s:ro -v "$BIN":/forgeaip-sim:ro debian:bookworm-slim \
    /forgeaip-sim run --root /x --base "$base" --shard "$i" --bots 2 --days "$days" --tiles /tiles --world "vps-s$((i % 5))" --reward /r/reward-v6.json --progress /r/progress-list.json \
    --seed "$((seed * 100 + i))" --scenario "/s/$scn.json" >/dev/null
done
echo "eval $base: scenario $scn, $eps episodes, checkpoint ${ckpt:-none}"
# --learn 0 never reaches the learner's step budget (it is checked after an update), so the episodes are counted here, from the shards' own records
while :; do
  n=$(cat "$X"/"$base"-s*-sim*/events.jsonl 2>/dev/null | grep -c '"event":"episode_end"' || true)
  [ "${n:-0}" -ge "$eps" ] && break
  docker ps -q --filter "name=$L-learner" | grep -q . || { echo "learner exited early:" >&2; docker logs --tail 5 $L-learner >&2; exit 1; }
  sleep 15
done
echo "$n" > "$X/$base.done"; echo "done: $n episodes"
