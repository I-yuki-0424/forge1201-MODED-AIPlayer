#!/usr/bin/env bash
# Training on the owner's PC entirely inside WSL2 (Ubuntu 22.04): per run S simulator shards (the Linux binary of tools/sim) and one GPU learner
# (DPOD botsystem_goal_ppo.py, CUDA jax from `pc.sh gpu-setup`), all on one ext4 disk. Several runs can share the machine (own base name, own
# GPU memory share). Each run has a supervisor that restarts whatever dies, pauses in the quiet hours and writes the status. Driven from the VPS by
# `scripts/train/pc.sh wsl-up|wsl-down|wsl-status`.
#   wsl-sim.sh up --base A [--seed 42] [--shards 8] [--bots 2] [--days 3] [--max-steps 2000000] [--gpu-fraction 0.38] [--learner-args "..."]
#   wsl-sim.sh down [--base A]      (no base: every run)        wsl-sim.sh status
# Layout in WSL: ~/sim/{forgeaip-sim,forgeaip-tblog,tiles/,r/} ~/dpod/ ~/gpuvenv/ ; run files ~/x/<base>*, logs ~/x/logs/<base>-*.log, status ~/x/status.<base>.txt
# (all runs together also in C:\forgeaip\status.txt), learning-status files ~/x/tb/<base>/ (TensorBoard: http://localhost:6006 in the Windows browser).
# --max-queue must exceed one update's --batch-segs (the learner stops reading otherwise: it did with 64 < 128 on 2026-11-03).
# Quiet hours (owner 2026-11-02): 12:00-18:00 JST every process of a run is stopped (SIGSTOP) and resumed afterwards; `touch ~/x/PAUSE` pauses too.
set -u
X=$HOME/x PY=$HOME/gpuvenv/bin/python SIM=$HOME/sim
cmd=${1:-status}; shift || true
base="" seed=42 shards=8 bots=2 days=3 maxsteps=2000000 frac=0.38 largs="--scale 4 --tf32 1 --n-max 256 --enc-chunk 128 --aux-batch 64 --max-queue 200"
while [ $# -gt 0 ]; do case $1 in --base) base=$2; shift 2;; --seed) seed=$2; shift 2;; --shards) shards=$2; shift 2;; --bots) bots=$2; shift 2;; --days) days=$2; shift 2;;
  --max-steps) maxsteps=$2; shift 2;; --gpu-fraction) frac=$2; shift 2;; --learner-args) largs=$2; shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done
[[ ${base:-x} =~ ^[a-z0-9_-]{1,40}$ && $seed =~ ^[0-9]+$ && $shards =~ ^[0-9]+$ && $bots =~ ^[1-8]$ && $days =~ ^[0-9]+$ && $maxsteps =~ ^[0-9]+$ && $frac =~ ^0\.[0-9]+$ && $largs =~ ^[-a-z0-9\ .]*$ ]] || { echo "bad option value" >&2; exit 2; }
mkdir -p "$X/logs" "$X/tb"

launch_learner() {  # appends to the log; resumes from the checkpoint if there is one
  XLA_PYTHON_CLIENT_PREALLOCATE=false XLA_PYTHON_CLIENT_MEM_FRACTION=$frac PYTHONDONTWRITEBYTECODE=1 setsid nohup "$PY" "$HOME/dpod/scripts/botsystem_goal_ppo.py" --root "$X" --base "$base" --learn 1 --seed "$seed" \
    --population 1 --max-steps "$maxsteps" $largs >> "$X/logs/$base-learner.log" 2>&1 < /dev/null &
  LPID=$!
}
launch_shard() {  # launch_shard <i>
  setsid nohup "$SIM/forgeaip-sim" run --root "$X" --base "$base" --shard "$1" --bots "$bots" --days "$days" --tiles "$SIM/tiles" --world "vps-s$(($1 % 5))" \
    --reward "$SIM/r/reward-v6.json" --progress "$SIM/r/progress-list.json" --seed "$((seed * 100 + $1))" >> "$X/logs/$base-shard$1.log" 2>&1 < /dev/null &
  SPID[$1]=$!
}
status_text() {
  python3 - "$X" "$base" "$1" <<'PY'
import json, os, sys, time
X, base, note = sys.argv[1:4]
def jl(p):
    out = []
    try:
        for l in open(p):
            try: out.append(json.loads(l))
            except Exception: pass
    except OSError: pass
    return out
u = [r for r in jl(f"{X}/{base}/train/train_log.jsonl") if r.get("event") == "update"]
st = {}
try: st = json.load(open(f"{X}/tb/{base}/status.json"))
except Exception: pass
print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} JST  run {base}: {note}")
if u:
    a, b = u[0], u[-1]; dt = b["t"] - a["t"]; recent = u[-10:]; dr = recent[-1]["t"] - recent[0]["t"]
    print(f"  steps {b['total_steps']:,}   updates {b['update']}   speed {((b['total_steps'] - a['total_steps']) / dt if dt > 0 else 0):.0f} steps/s overall, "
          f"{((recent[-1]['total_steps'] - recent[0]['total_steps']) / dr if dr > 0 else 0):.0f} now   device {b.get('devices')}")
    print(f"  policy: entropy {b.get('ent', 0):.2f}  clipfrac {b.get('clipfrac', 0):.2f}  kl {b.get('kl', 0):.3f}  critic explained variance {b.get('expl_var', float('nan')):.2f}  teacher level {b.get('teacher', {}).get('level', float('nan')):.2f}")
if st:
    print(f"  VERDICT: {st['verdict'].upper()}  after {st['episodes']} episodes;  progress per block of {st['block']} episodes (mean +- 95 %): " + "  ".join(f"{m:.1f}+-{1.96 * e:.1f}" for m, e in st["progress_blocks"][-5:]) + f";  deaths/episode {st['deaths_per_episode_last_block']:.1f}")
    for f in st.get("flags", []): print("  ! " + f)
    print("  (STALLED = no gain of two standard errors over the earlier best in the last three blocks: stop and rethink the design; LEARNING = keep going)")
PY
}
case $cmd in
up)
  [ -n "$base" ] || { echo "--base required" >&2; exit 2; }
  [ -f "$X/$base.sup.pid" ] && kill -0 "$(cat "$X/$base.sup.pid")" 2>/dev/null && { echo "run $base is already running"; exit 1; }
  rm -f "${X:?}/${base:?}.done"
  setsid nohup "$0" supervise --base "$base" --seed "$seed" --shards "$shards" --bots "$bots" --days "$days" --max-steps "$maxsteps" --gpu-fraction "$frac" --learner-args "$largs" > "$X/logs/$base-supervisor.log" 2>&1 < /dev/null &
  echo $! > "$X/$base.sup.pid"
  # the learning-status viewer, once for every run: TensorBoard on the PC's own localhost
  if ! pgrep -f "tensorboard --logdir $X/tb" >/dev/null; then
    [ -x "$HOME/gpuvenv/bin/tensorboard" ] || "$HOME/.local/bin/uv" pip install --python "$PY" -q tensorboard >> "$X/logs/tensorboard.log" 2>&1
    setsid nohup "$HOME/gpuvenv/bin/tensorboard" --logdir "$X/tb" --host 0.0.0.0 --port 6006 --reload_interval 30 --samples_per_plugin scalars=100000 >> "$X/logs/tensorboard.log" 2>&1 < /dev/null &
  fi
  echo "wsl-sim up: run $base, $shards shards x $bots bots, budget $maxsteps steps, gpu share $frac; learner args: $largs";;
supervise)
  mkdir -p "$X/$base/train" "$X/tb/$base"
  trap 'exit 0' TERM
  declare -a SPID; restarts=0; lrestarts=0; last_status=0; paused=0
  launch_learner; sleep 5
  for i in $(seq 0 $((shards - 1))); do launch_shard "$i"; sleep 0.5; done
  setsid nohup "$SIM/forgeaip-tblog" --dir "$X/$base/train" --out "$X/tb/$base" --follow --block 60 > "$X/logs/$base-tblog.log" 2>&1 < /dev/null &
  TPID=$!
  allpids() { echo $LPID $TPID ${SPID[@]}; }
  note="running"
  while :; do
    h=$(TZ=Asia/Tokyo date +%H); h=${h#0}
    if { [ "$h" -ge 12 ] && [ "$h" -lt 18 ]; } || [ -f "$X/PAUSE" ]; then
      [ $paused = 0 ] && { for p in $(allpids); do kill -STOP "$p" 2>/dev/null; done; paused=1; }
      note="PAUSED (quiet hours 12:00-18:00 JST or ~/x/PAUSE)"
    else
      [ $paused = 1 ] && { for p in $(allpids); do kill -CONT "$p" 2>/dev/null; done; paused=0; }
      note="running"
      if [ ! -f "$X/$base.done" ]; then
        kill -0 "$LPID" 2>/dev/null || {
          lrestarts=$((lrestarts + 1)); echo "$(date +%T) learner died (restart $lrestarts); last log lines:" >> "$X/logs/$base-supervisor.log"; tail -3 "$X/logs/$base-learner.log" >> "$X/logs/$base-supervisor.log"
          if [ $lrestarts -gt 30 ]; then note="FAILED: the learner died 30 times, see ~/x/logs/$base-learner.log"; status_text "$note" > "$X/status.$base.txt"; exit 1; fi
          launch_learner; note="learner restarted ($lrestarts so far)"; }
        for i in $(seq 0 $((shards - 1))); do kill -0 "${SPID[$i]}" 2>/dev/null || { restarts=$((restarts + 1)); echo "$(date +%T) shard $i died, restart $restarts" >> "$X/logs/$base-supervisor.log"; launch_shard "$i"; }; done
        kill -0 "$TPID" 2>/dev/null || { setsid nohup "$SIM/forgeaip-tblog" --dir "$X/$base/train" --out "$X/tb/$base" --follow --block 60 >> "$X/logs/$base-tblog.log" 2>&1 < /dev/null & TPID=$!; }
      else
        kill -0 "$LPID" 2>/dev/null || { note="DONE: step budget reached ($(cat "$X/$base.done") steps), final checkpoint written"; status_text "$note" > "$X/status.$base.txt"; cat "$X"/status.*.txt > /mnt/c/forgeaip/status.txt 2>/dev/null; exit 0; }
      fi
    fi
    now=$(date +%s)
    if [ $((now - last_status)) -ge 60 ]; then last_status=$now; { status_text "$note (learner restarts $lrestarts, shard restarts $restarts)"; } > "$X/status.$base.txt"; cat "$X"/status.*.txt > /mnt/c/forgeaip/status.txt 2>/dev/null; fi
    sleep 15
  done;;
down)
  # `down --base A` touches only run A (its supervisor, learner, shards, follower); without a base, every run and TensorBoard.
  for s in "$X"/*.sup.pid; do [ -f "$s" ] || continue; b=$(basename "$s" .sup.pid); [ -n "$base" ] && [ "$base" != "$b" ] && continue
    kill -CONT "$(cat "$s")" 2>/dev/null; kill -TERM "$(cat "$s")" 2>/dev/null; rm -f "${s:?}"
    pat_l="botsystem_goal_ppo.py --root $X --base $b "; pat_s="forgeaip-sim run --root $X --base $b "
    for p in $(pgrep -f -- "$pat_s") $(pgrep -f -- "$pat_l") $(pgrep -f -- "forgeaip-tblog --dir $X/$b/"); do kill -CONT "$p" 2>/dev/null; kill -TERM "$p" 2>/dev/null; done   # the learner writes its checkpoint first
    for t in $(seq 1 90); do pgrep -f -- "$pat_l" > /dev/null || break; sleep 1; done
    pkill -KILL -f -- "$pat_l" 2>/dev/null; pkill -KILL -f -- "$pat_s" 2>/dev/null
    printf '%s JST  run %s: STOPPED by wsl-down (checkpoint and logs kept)\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$b" > "$X/status.$b.txt"
    echo "run $b: stopped"
  done
  [ -z "$base" ] && pkill -f "tensorboard --logdir $X/tb" 2>/dev/null
  echo "wsl-sim down";;
status)
  for f in "$X"/status.*.txt; do [ -f "$f" ] && cat "$f"; done
  echo "processes: learners $(pgrep -fc 'botsystem_goal_ppo.py --root') shards $(pgrep -fc 'forgeaip-sim run')"; nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader 2>/dev/null;;
*) echo "usage: $0 up|down|status [options]" >&2; exit 2;;
esac
