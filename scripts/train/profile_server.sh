#!/usr/bin/env bash
# Where does the learner process spend its time while serving bots? Runs S simulator shards against the learner under cProfile for
# N seconds (--learn L: 0 = serving and bookkeeping only, 1 = with updates) and prints steps/s and the heaviest functions.
#   scripts/train/profile_server.sh [--shards 6] [--secs 120] [--learn 0] [--cpus 3] [--extra "--scale 8"]
# Uses its own base (prof) and the training tiles; stops everything at the end. Do not run next to a training run.
source "$(dirname "$0")/lib.sh"
DPOD=${DPOD_DIR:-$(cd "$REPO/../Decision-Process-order-driven" && pwd)}
TILES=${SIM_TILES:-/mnt/data/forgeaip/sim-tiles}
BIN=$REPO/tools/sim/target/bookworm/release/forgeaip-sim
shards=6 secs=120 learn=0 cpus=3 extra=""
while [ $# -gt 0 ]; do case $1 in --shards) shards=$2; shift 2;; --secs) secs=$2; shift 2;; --learn) learn=$2; shift 2;; --cpus) cpus=$2; shift 2;; --extra) extra=$2; shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done
[[ $shards =~ ^[0-9]+$ && $secs =~ ^[0-9]+$ && $learn =~ ^[01]$ && $cpus =~ ^[1-6]$ && $extra =~ ^[-a-z0-9\ .]*$ ]] || { echo "bad option value" >&2; exit 2; }
[ -x "$BIN" ] && [ -z "$(find "$REPO/tools/sim/src" "$REPO/tools/sim/data" -newer "$BIN" 2>/dev/null | head -1)" ] || "$REPO/tools/sim/build.sh"
X=$REPO/exchange
docker rm -f forgeaip-prof-policy >/dev/null 2>&1 || true
docker ps -aq --filter name=forgeaip-prof-s | xargs -r docker rm -f >/dev/null 2>&1 || true
rm -rf "$X"/prof "$X"/prof.* "$X"/prof-s*; mkdir -p "$X/prof/train"
docker run -d --name forgeaip-prof-policy --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true --memory 4500m --cpus "$cpus" \
  -e PYTHONDONTWRITEBYTECODE=1 -e XLA_FLAGS="--xla_cpu_multi_thread_eigen=false intra_op_parallelism_threads=$cpus" -v rl-jaxvenv:/venv:ro -v "$DPOD":/dpod:ro -v "$X":/x python:3.12-slim \
  sh -c "exec /venv/bin/python -m cProfile -o /x/prof/profile.out /dpod/scripts/botsystem_goal_ppo.py --root /x --base prof --learn $learn --seed 42 --population 1 --max-queue 4000 $extra" >/dev/null
sleep 3
for i in $(seq 0 $((shards - 1))); do
  docker run -d --name forgeaip-prof-s$i --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true --memory 900m --cpus 0.5 \
    -v "$X":/x -v "$TILES":/tiles:ro -v "$REPO/src/rl":/r:ro -v "$BIN":/forgeaip-sim:ro debian:bookworm-slim /forgeaip-sim run --root /x --base prof --shard "$i" --bots 2 --days 3 \
    --tiles /tiles --world "vps-s$((i % 5))" --reward /r/reward-v6.json --progress /r/progress-list.json --seed "$((2000 + i))" >/dev/null
done
sleep 30                                       # compile + first episodes
s0=$(python3 -I - "$X" <<'PY'
import json, sys, glob
n = 0
for f in glob.glob(sys.argv[1] + "/prof-s*/policy_to_env.jsonl"):
    n += sum(1 for _ in open(f))
print(n)
PY
)
t0=$(date +%s); sleep "$secs"; t1=$(date +%s)
s1=$(python3 -I - "$X" <<'PY'
import json, sys, glob
n = 0
for f in glob.glob(sys.argv[1] + "/prof-s*/policy_to_env.jsonl"):
    n += sum(1 for _ in open(f))
print(n)
PY
)
docker stop -t 60 forgeaip-prof-policy >/dev/null 2>&1
docker ps -aq --filter name=forgeaip-prof-s | xargs -r docker rm -f >/dev/null 2>&1
docker rm -f forgeaip-prof-policy >/dev/null 2>&1 || true
echo "served $((s1 - s0)) actions in $((t1 - t0)) s = $(( (s1 - s0) / (t1 - t0) )) steps/s  (shards $shards x 2 bots, learn $learn, cpus $cpus, extra '$extra')"
docker run --rm --network none -v "$X/prof":/p:ro python:3.12-slim python -c "
import pstats; p = pstats.Stats('/p/profile.out'); p.sort_stats('tottime').print_stats(18)" 2>&1 | sed -n 1,45p
