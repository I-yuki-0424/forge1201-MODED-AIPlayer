#!/usr/bin/env bash
# Training on the owner's PC entirely inside WSL2 (Ubuntu 22.04): S simulator shards (the Linux binary of tools/sim, 16 threads of the
# Ryzen) and the GPU learner (DPOD botsystem_goal_ppo.py, CUDA jax from `pc.sh gpu-setup`) next to each other, so the file API stays on
# one ext4 disk. Driven from the VPS by `scripts/train/pc.sh wsl-up|wsl-down|wsl-status`.
#   wsl-sim.sh up [--base pc1] [--shards 8] [--bots 2] [--days 3] [--max-steps 1000000] [--learner-args "..."]
#   wsl-sim.sh down | status
# Layout in WSL: ~/sim/{forgeaip-sim,tiles/,r/} ~/dpod/ ~/gpuvenv/ ; run files in ~/x/<base>*, logs ~/x/logs/*.log, pids ~/x/pids.
# --max-queue (unread observations wait in the files while this many finished segments wait for training) must exceed one update's
# --batch-segs (128 at --scale 8) or the learner stops reading before it can ever train: it did, with 64, on 2026-11-03.
# Quiet hours (owner 2026-11-02): 12:00-18:00 JST every process is stopped (SIGSTOP) and resumed afterwards; `touch ~/x/PAUSE` pauses too.
set -u
X=$HOME/x PY=$HOME/gpuvenv/bin/python SIM=$HOME/sim
cmd=${1:-status}; shift || true
base=pc1 shards=8 bots=2 days=3 maxsteps=1000000 largs="--scale 8 --tf32 1 --n-max 256 --enc-chunk 256 --aux-batch 128 --max-queue 400"
while [ $# -gt 0 ]; do case $1 in --base) base=$2; shift 2;; --shards) shards=$2; shift 2;; --bots) bots=$2; shift 2;; --days) days=$2; shift 2;;
  --max-steps) maxsteps=$2; shift 2;; --learner-args) largs=$2; shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done
[[ $base =~ ^[a-z0-9_-]{1,40}$ && $shards =~ ^[0-9]+$ && $bots =~ ^[1-8]$ && $days =~ ^[0-9]+$ && $maxsteps =~ ^[0-9]+$ && $largs =~ ^[-a-z0-9\ .]*$ ]] || { echo "bad option value" >&2; exit 2; }
case $cmd in
up)
  mkdir -p "$X/logs"; [ -f "$X/pids" ] && "$0" down >/dev/null 2>&1
  rm -f "$X/$base.done"; : > "$X/pids"
  XLA_PYTHON_CLIENT_PREALLOCATE=false XLA_PYTHON_CLIENT_MEM_FRACTION=0.8 PYTHONDONTWRITEBYTECODE=1 setsid nohup "$PY" "$HOME/dpod/scripts/botsystem_goal_ppo.py" --root "$X" --base "$base" --learn 1 --seed 42 \
    --population 1 --max-steps "$maxsteps" $largs > "$X/logs/learner.log" 2>&1 < /dev/null &
  echo $! >> "$X/pids"
  sleep 5
  launch() {  # launch <shard>: one simulator process; its pid is appended to the pid file
    setsid nohup "$SIM/forgeaip-sim" run --root "$X" --base "$base" --shard "$1" --bots "$bots" --days "$days" --tiles "$SIM/tiles" --world "vps-s$(($1 % 5))" \
      --reward "$SIM/r/reward-v6.json" --progress "$SIM/r/progress-list.json" --seed "$((3000 + $1))" >> "$X/logs/shard$1.log" 2>&1 < /dev/null &
    echo $! >> "$X/pids"; eval "pid$1=$!"
  }
  for i in $(seq 0 $((shards - 1))); do launch "$i"; sleep 0.5; done
  # a shard that died at once (3 of 8 did in the first try, silently) is started again, up to three times
  for round in 1 2 3; do
    sleep 6; again=0
    for i in $(seq 0 $((shards - 1))); do eval "p=\$pid$i"; kill -0 "$p" 2>/dev/null || { echo "shard $i died at start (round $round), starting it again"; launch "$i"; again=1; }; done
    [ $again = 0 ] && break
  done
  # quiet hours watcher: stop everything 12:00-18:00 JST (or while ~/x/PAUSE exists), continue afterwards
  setsid nohup bash -c 'while :; do h=$(TZ=Asia/Tokyo date +%H); h=${h#0}; if { [ "$h" -ge 12 ] && [ "$h" -lt 18 ]; } || [ -f "$HOME/x/PAUSE" ]; then s=STOP; else s=CONT; fi
    for p in $(cat "$HOME/x/pids"); do kill -$s $p 2>/dev/null; done; sleep 30; done' > /dev/null 2>&1 < /dev/null &
  echo $! >> "$X/pids"
  echo "wsl-sim up: base=$base shards=$shards x $bots bots, learner args: $largs";;
down)
  [ -f "$X/pids" ] || { echo "not running"; exit 0; }
  # the watcher first (it would CONT what we stop), then the shards, then the learner with time to write its checkpoint
  pids=$(tac "$X/pids"); for p in $pids; do kill -CONT $p 2>/dev/null; done
  for p in $pids; do kill -TERM $p 2>/dev/null; done
  for t in $(seq 1 60); do alive=0; for p in $pids; do kill -0 $p 2>/dev/null && alive=1; done; [ $alive = 0 ] && break; sleep 1; done
  for p in $pids; do kill -KILL $p 2>/dev/null; done; rm -f "$X/pids"; echo "wsl-sim down";;
status)
  n=0; [ -f "$X/pids" ] && for p in $(cat "$X/pids"); do kill -0 $p 2>/dev/null && n=$((n + 1)); done
  echo "processes alive: $n"; nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader 2>/dev/null
  b=$(ls -dt "$X"/*/train 2>/dev/null | head -1)   # the newest base
  if [ -n "$b" ]; then python3 - "$b/train_log.jsonl" <<'PY'
import json, sys
rows = []
try:
    for l in open(sys.argv[1]):
        try: rows.append(json.loads(l))
        except Exception: pass
except OSError: pass
u = [r for r in rows if r.get("event") == "update"]
if u:
    a, b = u[0], u[-1]; dt = b["t"] - a["t"]
    print(f"updates {b['update']}  steps {b['total_steps']}  last update {b['seconds']:.1f} s  queue {b.get('queue')}  devices {b.get('devices')}  mean {((b['total_steps'] - a['total_steps']) / dt if dt > 0 else 0):.0f} steps/s since the first update  ent {b.get('ent', 0):.2f} clipfrac {b.get('clipfrac', 0):.2f} expl_var {b.get('expl_var', float('nan')):.2f}")
else: print("no update yet")
PY
  fi
  tail -2 "$X/logs/learner.log" 2>/dev/null | cut -c1-200;;
*) echo "usage: $0 up|down|status" >&2; exit 2;;
esac
