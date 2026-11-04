#!/usr/bin/env bash
# Scenario training runs on this VPS's CPU (tools/sim/scenarios, docs/proposed/SCENARIO-v1.md): the counterpart of scn-runs.sh (PC, GPU). One run per scenario,
# concurrently: a learner container and S simulator shard containers each (names forgeaip-scn-<base>-learner / -s<i>), no Forge server, no network.
#   scripts/train/scn-vps.sh up iron-a,iron-b,iron-c [--ckpt FILE --ckpt-steps N] [--budget 2000000] [--seed 61] [--shards 3] [--days 1] [--tag T]
#                            [--learner-cpus 3] [--shard-cpus 0.4] [--learner-mem 5g] [--learner-args "..."]
#   scripts/train/scn-vps.sh status [BASE..] | report iron-a,iron-b [--tag T] | resume | down iron-a,iron-b [--tag T]
# Same defaults as scn-runs.sh (run `runc` of 2026-11-04, same seed 61, same shard seeds), so the CPU run and a later PC/GPU run of one scenario are comparable,
# except --tf32 (GPU only). A run base is the scenario id (+ "-T" with --tag). --ckpt starts from that learner checkpoint (copied to exchange/<base>/train/ unless
# one is there; --ckpt-steps = the step count inside the file, the budget counts from there). The learner writes a checkpoint after every update, so a stop,
# a crash or a reboot loses at most one update: `resume` (run at boot by the user unit forgeaip-scn-resume) starts every stopped run that has no exchange/<base>.done.
# The run keeps a maint-hold lease (hold.sh) so the nightly rootwatch maintenance does not reboot under it.
source "$(dirname "$0")/lib.sh"
export XDG_RUNTIME_DIR=/run/user/$(id -u)
DPOD=${DPOD_DIR:-$(cd "$REPO/../Decision-Process-order-driven" && pwd)}
TILES=${SIM_TILES:-/mnt/data/forgeaip/sim-tiles}
BIN=$REPO/tools/sim/target/bookworm/release/forgeaip-sim
X=$REPO/exchange
cmd=${1:-status}; shift || true
list=""; case $cmd in up|report|down) list=${1:-}; shift || true; [ -n "$list" ] || { echo "usage: $0 $cmd SCENARIO[,SCENARIO..] [options]" >&2; exit 2; };; esac
ckpt="" cks=0 budget=2000000 seed=61 shards=3 days=1 tag="" lcpus=3 scpus=0.4 lmem=5g
largs="--scale 4 --n-max 256 --enc-chunk 128 --aux-batch 64 --max-queue 200 --lr 7.5e-5 --ent 0.03" extra=()
while [ $# -gt 0 ]; do case $1 in --ckpt) ckpt=$2; shift 2;; --ckpt-steps) cks=$2; shift 2;; --budget) budget=$2; shift 2;; --seed) seed=$2; shift 2;; --shards) shards=$2; shift 2;;
  --days) days=$2; shift 2;; --tag) tag=$2; shift 2;; --learner-cpus) lcpus=$2; shift 2;; --shard-cpus) scpus=$2; shift 2;; --learner-mem) lmem=$2; shift 2;;
  --learner-args) largs=$2; shift 2;; --blocks|--entries) extra+=("$1" "$2"); shift 2;; *) bases_arg+=("$1"); shift;; esac; done
[[ $list =~ ^[a-z0-9_,-]*$ && $tag =~ ^[a-z0-9_-]*$ && $cks =~ ^[0-9]+$ && $budget =~ ^[0-9]+$ && $seed =~ ^[0-9]+$ && $shards =~ ^[0-9]+$ && $days =~ ^[1-9]$ \
  && $lcpus =~ ^[1-9]$ && $scpus =~ ^[0-9.]+$ && $lmem =~ ^[0-9]+[gm]$ && $largs =~ ^[-a-z0-9\ .]*$ ]] || { echo "bad option value" >&2; exit 2; }
IFS=, read -ra S <<< "$list"
base() { echo "$1${tag:+-$tag}"; }
LBL=forgeaip.scn=1
start_run() {   # start_run BASE SCENARIO MAXSTEPS   (containers must not exist)
  local b=$1 s=$2 max=$3 i
  docker run -d --name forgeaip-scn-$b-learner --label $LBL --label forgeaip.scn.base=$b --restart on-failure:20 --network none --read-only --tmpfs /tmp --cap-drop ALL \
    --security-opt no-new-privileges:true --ulimit core=0 --memory "$lmem" --cpus "$lcpus" -e PYTHONDONTWRITEBYTECODE=1 \
    -e XLA_FLAGS="--xla_cpu_multi_thread_eigen=false intra_op_parallelism_threads=$lcpus" -v rl-jaxvenv:/venv:ro -v "$DPOD":/dpod:ro -v "$X":/x python:3.12-slim \
    sh -c "exec /venv/bin/python /dpod/scripts/botsystem_goal_ppo.py --root /x --base $b --learn 1 --seed 42 --population 1 --max-steps $max $largs" >/dev/null
  sleep 3
  for i in $(seq 0 $((shards - 1))); do
    docker run -d --name forgeaip-scn-$b-s$i --label $LBL --label forgeaip.scn.base=$b --restart on-failure:50 --network none --read-only --tmpfs /tmp --cap-drop ALL \
      --security-opt no-new-privileges:true --memory 900m --cpus "$scpus" -v "$X":/x -v "$TILES":/tiles:ro -v "$REPO/src/rl":/r:ro -v "$REPO/tools/sim/scenarios":/s:ro \
      -v "$BIN":/forgeaip-sim:ro debian:bookworm-slim /forgeaip-sim run --root /x --base "$b" --shard "$i" --bots 2 --days "$days" --tiles /tiles --world "vps-s$((i % 5))" \
      --reward /r/reward-v6.json --progress /r/progress-list.json --seed "$((seed * 100 + i))" --scenario "/s/$s.json" >/dev/null
  done
}
case $cmd in
up)
  [ -x "$BIN" ] && [ -z "$(find "$REPO/tools/sim/src" "$REPO/tools/sim/data" -newer "$BIN" 2>/dev/null | head -1)" ] || "$REPO/tools/sim/build.sh"
  ls "$TILES"/*.tile >/dev/null 2>&1 || { echo "no tiles in $TILES" >&2; exit 1; }
  mkdir -p "$X"
  for s in "${S[@]}"; do
    [ -f "$REPO/tools/sim/scenarios/$s.json" ] || { echo "no scenario $s" >&2; exit 2; }
    b=$(base "$s")
    docker ps -aq --filter "name=forgeaip-scn-$b-" | grep -q . && { echo "run $b exists (down it first, or use resume)" >&2; exit 1; }
    rm -f "$X/$b.done"; mkdir -p "$X/$b/train"
    [ -n "$ckpt" ] && { [ -f "$X/$b/train/checkpoint.pkl" ] || cp "$ckpt" "$X/$b/train/checkpoint.pkl"; }
    start_run "$b" "$s" "$((cks + budget))"
    # remember how to restart it after a reboot (resume)
    printf 'scenario=%s\nmax=%s\nshards=%s\n' "$s" "$((cks + budget))" "$shards" > "$X/$b.scn-run"
    echo "run $b: scenario $s, learner ${lcpus} cpus, $shards shards x 2 bots, budget $((cks + budget)) steps${ckpt:+, from $(basename "$ckpt")}"
  done
  for u in service timer; do systemctl --user link "$REPO/scripts/train/systemd/forgeaip-train-hold.$u" >/dev/null 2>&1 || true; done
  systemctl --user enable --now forgeaip-train-hold.timer >/dev/null 2>&1 || true
  "$REPO/scripts/train/hold.sh" || true;;
resume)   # after a reboot: bring back every run that was not finished (no .done), keep its shard count and budget
  for f in "$X"/*.scn-run; do [ -f "$f" ] || continue; b=$(basename "$f" .scn-run); [ -f "$X/$b.done" ] && continue
    docker ps -q --filter "name=forgeaip-scn-$b-learner" | grep -q . && continue
    s=$(sed -n 's/^scenario=//p' "$f"); max=$(sed -n 's/^max=//p' "$f"); shards=$(sed -n 's/^shards=//p' "$f")
    docker ps -aq --filter "name=forgeaip-scn-$b-" | xargs -r docker rm -f >/dev/null 2>&1 || true
    start_run "$b" "$s" "$max"; echo "run $b: resumed"
  done
  "$REPO/scripts/train/hold.sh" || true;;
status)
  docker ps -a --filter label=$LBL --format '{{.Names}}\t{{.Status}}' | sort
  for f in "$X"/*.scn-run; do [ -f "$f" ] || continue; b=$(basename "$f" .scn-run)
    python3 -I "$REPO/scripts/train/summary.py" "$X" "$b" 2>/dev/null | tail -n 6 || true; [ -f "$X/$b.done" ] && echo "$b DONE: $(cat "$X/$b.done") steps"; done;;
report) bases=(); for s in "${S[@]}"; do bases+=("$(base "$s")"); done; python3 -I "$REPO/tools/sim/scn_report.py" "$X" "${bases[@]}" "${extra[@]}";;
down)
  for s in "${S[@]}"; do b=$(base "$s")
    docker stop -t 90 forgeaip-scn-$b-learner >/dev/null 2>&1 || true     # the learner writes its checkpoint first
    docker ps -aq --filter "name=forgeaip-scn-$b-" | xargs -r docker rm -f >/dev/null 2>&1 || true
    rm -f "$X/$b.scn-run"; echo "run $b: stopped (checkpoint and logs kept in exchange/$b)"
  done
  "$REPO/scripts/train/hold.sh" || true;;
*) echo "usage: $0 up|status|resume|report|down ..." >&2; exit 2;;
esac
