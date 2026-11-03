#!/usr/bin/env bash
# Training on the Rust simulator (tools/sim, docs/proposed/SIM-RUST-v1.md): S simulator shards (each 2 bots in its own world tile,
# taken from the real servers' region files) and the learner. No Forge server, no JVM; the learner is the limit, so the learner
# applies backpressure (--max-queue) and stops by itself after --max-steps (marker exchange/<base>.done; the shards then exit).
#   scripts/train/sim.sh up [--shards 10] [--bots 2] [--days 3] [--base sim1] [--max-steps 1000000] [--cpus 4] [--init FILE]
#   scripts/train/sim.sh down | status     (down also brings the build world back; a watcher unit does that by itself after the budget)
# Restart-safe: containers restart on failure (not after a clean exit), the learner resumes from exchange/<base>/train/checkpoint.pkl.
source "$(dirname "$0")/lib.sh"
export XDG_RUNTIME_DIR=/run/user/$(id -u)   # the user bus (hold timer, watcher) even from a shell whose runtime dir is wrong
DPOD=${DPOD_DIR:-$(cd "$REPO/../Decision-Process-order-driven" && pwd)}
TILES=${SIM_TILES:-/mnt/data/forgeaip/sim-tiles}
BIN=$REPO/tools/sim/target/bookworm/release/forgeaip-sim
cmd=${1:-status}; shift || true
shards=10 bots=2 days=3 base=sim1 maxsteps=1000000 cpus=4 init="" extra=""
while [ $# -gt 0 ]; do case $1 in
  --shards) shards=$2; shift 2;; --bots) bots=$2; shift 2;; --days) days=$2; shift 2;; --base) base=$2; shift 2;;
  --max-steps) maxsteps=$2; shift 2;; --cpus) cpus=$2; shift 2;; --init) init=$2; shift 2;; --learner-args) extra=$2; shift 2;;
  *) echo "unknown option $1" >&2; exit 2;; esac; done
[[ $shards =~ ^[0-9]+$ && $shards -ge 1 && $shards -le 30 && $bots =~ ^[1-8]$ && $days =~ ^[1-9][0-9]?$ && $maxsteps =~ ^[0-9]+$ && $cpus =~ ^[1-6]$ ]] || { echo "bad option value" >&2; exit 2; }
[[ $extra =~ ^[-a-z0-9\ .]*$ ]] || { echo "--learner-args: [-a-z0-9 .]" >&2; exit 2; }
[[ $base =~ ^[a-z0-9_-]{1,40}$ ]] || { echo "--base: [a-z0-9_-]" >&2; exit 2; }
learner=forgeaip-sim-policy
# Memory (11 GB box): the owner's build world and its LLM bot step aside while the learner runs, exactly as scripts/train/up.sh does,
# and come back at the end (restore), by hand with `down` or by itself when the learner has spent its budget (watch).
step_aside() {
  touch "$TRAIN_STATE"
  if running "$WORLD"; then "$REPO/scripts/world/snapshot.sh" before-train; grep -qx world "$TRAIN_STATE" || echo world >> "$TRAIN_STATE"; fi
  running forgeaip-llm-bot && { grep -qx llm-bot "$TRAIN_STATE" || echo llm-bot >> "$TRAIN_STATE"; }
  compose --profile bot stop llm-bot >/dev/null 2>&1 || true
  compose stop world >/dev/null 2>&1 || true
}
restore() {
  grep -qx world "$TRAIN_STATE" 2>/dev/null && "$REPO/scripts/world/up.sh"
  grep -qx llm-bot "$TRAIN_STATE" 2>/dev/null && "$REPO/scripts/world/bot-up.sh"
  rm -f "$TRAIN_STATE"
}
case $cmd in
watch)   # internal: started by `up`; waits for the learner to finish for good, then puts everything back
  while :; do
    docker wait $learner >/dev/null 2>&1 || break
    [ -f "$REPO/exchange/$base.done" ] && break
    sleep 40
    [ "$(docker inspect -f '{{.State.Running}}{{.State.Restarting}}' $learner 2>/dev/null)" = "falsefalse" ] && break
  done
  "$0" down --base "$base";;
up)
  [ -x "$BIN" ] && [ -z "$(find "$REPO/tools/sim/src" "$REPO/tools/sim/data" -newer "$BIN" 2>/dev/null | head -1)" ] || "$REPO/tools/sim/build.sh"
  ls "$TILES"/*.tile >/dev/null 2>&1 || { echo "no tiles in $TILES (tools/sim export, docs/proposed/SIM-RUST-v1.md)" >&2; exit 1; }
  mkdir -p "$REPO/exchange"; rm -f "$REPO/exchange/$base.done"
  step_aside
  docker rm -f $learner >/dev/null 2>&1 || true
  initarg=""; [ -n "$init" ] && initarg="--init /x/$init"
  # The learner: CPU jax in the shared venv volume. XLA threads = cpus; no network; nothing writable but the exchange and /tmp.
  docker run -d --name $learner --restart on-failure:5 --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
    --ulimit core=0 --memory 4500m --cpus "$cpus" -e PYTHONDONTWRITEBYTECODE=1 -e XLA_FLAGS="--xla_cpu_multi_thread_eigen=false intra_op_parallelism_threads=$cpus" \
    -v rl-jaxvenv:/venv:ro -v "$DPOD":/dpod:ro -v "$REPO/exchange":/x python:3.12-slim \
    sh -c "exec /venv/bin/python /dpod/scripts/botsystem_goal_ppo.py --root /x --base $base --learn 1 --seed 42 --population 1 --max-queue 48 --max-steps $maxsteps $initarg $extra" >/dev/null
  sleep 3
  for i in $(seq 0 $((shards - 1))); do
    docker rm -f forgeaip-sim-s$i >/dev/null 2>&1 || true
    docker run -d --name forgeaip-sim-s$i --restart on-failure:20 --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
      --memory 900m --cpus 0.5 -v "$REPO/exchange":/x -v "$TILES":/tiles:ro -v "$REPO/src/rl":/r:ro -v "$BIN":/forgeaip-sim:ro debian:bookworm-slim \
      /forgeaip-sim run --root /x --base "$base" --shard "$i" --bots "$bots" --days "$days" --tiles /tiles --world "vps-s$((i % 5))" \
      --reward /r/reward-v6.json --progress /r/progress-list.json --seed "$((1000 + i))" >/dev/null
  done
  "$REPO/scripts/train/tb.sh" start --base "$base" || echo "tb: not started (the training is unaffected)" >&2
  for u in service timer; do systemctl --user link "$REPO/scripts/train/systemd/forgeaip-train-hold.$u" >/dev/null 2>&1 || true; done
  systemctl --user enable --now forgeaip-train-hold.timer >/dev/null 2>&1 || true
  "$REPO/scripts/train/hold.sh" || true
  systemctl --user stop forgeaip-sim-watch.service >/dev/null 2>&1 || true
  systemd-run --user --collect --quiet --unit=forgeaip-sim-watch "$REPO/scripts/train/sim.sh" watch --base "$base" || echo "watcher not started: run sim.sh down by hand when done" >&2
  echo "sim training up: base=$base shards=$shards x $bots bots, days=$days, budget $maxsteps steps, learner cpus=$cpus"
  echo "log: exchange/$base/train/train_log.jsonl   status: scripts/train/sim.sh status --base $base   stop: scripts/train/sim.sh down";;
down)
  docker stop -t 90 $learner >/dev/null 2>&1 || true
  docker ps -aq --filter name=forgeaip-sim-s | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker rm -f $learner >/dev/null 2>&1 || true
  "$REPO/scripts/train/tb.sh" stop --base "$base" >/dev/null 2>&1 || true
  systemctl --user disable --now forgeaip-train-hold.timer >/dev/null 2>&1 || true
  maint-hold release forgeaip-train >/dev/null 2>&1 || true
  restore
  echo "sim training stopped";;
status)
  docker ps -a --filter name=forgeaip-sim --format '{{.Names}}\t{{.Status}}' | sort
  python3 -I "$REPO/scripts/train/summary.py" "$REPO/exchange" "$base" 2>/dev/null | tail -n 12 || true
  "$REPO/scripts/train/tb.sh" status 2>/dev/null | head -8 || true
  [ -f "$REPO/exchange/$base.done" ] && echo "DONE: $(cat "$REPO/exchange/$base.done") steps";;
*) echo "usage: $0 up|down|status [options]" >&2; exit 2;;
esac
