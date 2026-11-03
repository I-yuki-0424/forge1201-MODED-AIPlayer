#!/usr/bin/env bash
# Is the Rust simulator close to the real Forge game? Same policy (the DPOD scripted teacher), same worlds, same start sites, same
# episode rules, run once on two real Forge training servers and once on the simulator; both write steps.jsonl through the same
# stand-in policy (tools/sim/tests/smoke_policy.py); tools/sim/compare.py compares them.
#   scripts/train/validate-sim.sh real [minutes]     real Forge (2 servers x 2 bots, speed 2, 3-day episodes): leaves exchange/val-real-s{0,1}.jsonl
#   scripts/train/validate-sim.sh sim  [minutes]     the simulator on the same sites:                          exchange/val-sim-s{0,1}.jsonl
#   scripts/train/validate-sim.sh stop               stop the real servers (the build world comes back with scripts/train/down.sh)
# Needs exchange/sites-val.json and /mnt/data/forgeaip/sim-tiles-val (sites with tiles in both worlds; see docs/proposed/SIM-RUST-v1.md).
source "$(dirname "$0")/lib.sh"
export XDG_RUNTIME_DIR=/run/user/$(id -u)
DPOD=${DPOD_DIR:-$(cd "$REPO/../Decision-Process-order-driven" && pwd)}
mode=${1:-real}; mins=${2:-70}
pol() {  # pol <shard> <base> <steps file> <seconds>: the stand-in policy in a container
  docker run -d --rm --name "forgeaip-val-pol-$1" --network none -v "$REPO/exchange":/x -v "$REPO/tools/sim/tests":/t:ro -v "$DPOD/scripts":/d:ro -v rl-jaxvenv:/jax:ro \
    -e PYTHONPATH=/jax/lib/python3.12/site-packages python:3.12-slim python /t/smoke_policy.py /x "$2" "$1" "$4" /d teacher "/x/$3" >/dev/null
}
case $mode in
real)
  touch "$TRAIN_STATE"
  if running "$WORLD"; then "$REPO/scripts/world/snapshot.sh" before-train; grep -qx world "$TRAIN_STATE" || echo world >> "$TRAIN_STATE"; fi
  compose --profile bot stop llm-bot >/dev/null 2>&1 || true; compose stop world >/dev/null 2>&1 || true
  export TRAIN_BASE=val TRAIN_BOTS=2 TRAIN_LEARN=0 TRAIN_SPEED=2 TRAIN_DAYS=3 TRAIN_CANDIDATES=sites-val.json TRAIN_MEMORY=2G TRAIN_MEM_LIMIT=2800m
  rm -f "$REPO"/exchange/val-real-s*.jsonl "$REPO/exchange/sites/val-s0.json" "$REPO/exchange/sites/val-s1.json"
  compose --profile train --profile shard1 up -d train train-s1
  wait_healthy forgeaip-train; wait_healthy forgeaip-train-s1
  compose --profile train --profile shard1 up -d train-env train-env-s1
  pol 0 val val-real-s0.jsonl $((mins * 60)); pol 1 val val-real-s1.jsonl $((mins * 60))
  echo "real validation running for $mins min: exchange/val-real-s{0,1}.jsonl";;
sim)
  rm -f "$REPO"/exchange/val-sim-s*.jsonl
  for i in 0 1; do
    docker run -d --rm --name forgeaip-val-sim-$i --network none --read-only --tmpfs /tmp --memory 900m --cpus 1 -v "$REPO/exchange":/x -v /mnt/data/forgeaip/sim-tiles-val:/tiles:ro \
      -v "$REPO/src/rl":/r:ro -v "$REPO/tools/sim/target/bookworm/release/forgeaip-sim":/forgeaip-sim:ro debian:bookworm-slim /forgeaip-sim run --root /x --base valsim --shard $i --bots 2 --days 3 \
      --tiles /tiles --world vps-s$i --reward /r/reward-v6.json --progress /r/progress-list.json --seed $((77 + i)) >/dev/null
    pol $i valsim val-sim-s$i.jsonl $((mins * 60))
  done
  echo "sim validation running for $mins min: exchange/val-sim-s{0,1}.jsonl";;
stop)
  docker ps -aq --filter name=forgeaip-val- | xargs -r docker rm -f >/dev/null 2>&1 || true
  compose --profile train --profile shard1 stop -t 60 train-env train-env-s1 train train-s1 >/dev/null 2>&1 || true
  echo "validation stopped (scripts/train/down.sh brings the build world back)";;
*) echo "usage: $0 real|sim|stop [minutes]" >&2; exit 2;;
esac
