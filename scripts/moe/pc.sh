#!/usr/bin/env bash
# MoE training on the owner's PC (WSL2 Ubuntu-22.04), driven from the VPS over ssh (same host and key as scripts/train/pc.sh). Owner permission 2026-11-09: PC resources until
# 2026-11-10 11:30 JST (schedule hold sch_ujHWOWoNZEO8i2-n). Nothing here touches the Windows side beyond C:\forgeaip\dl (transfer folder) and the WSL home.
#   scripts/moe/pc.sh probe                  what the PC has (python, jax, cores, load)
#   scripts/moe/pc.sh install                simulator binary, moe package, scenarios, python deps -> ~/moe in WSL
#   scripts/moe/pc.sh run NAME CMD...        CMD (arguments of scripts/moe/pc/jobs.py) detached in WSL, log ~/moe/logs/NAME.log
#   scripts/moe/pc.sh status                 running jobs, the tail of every log, load, GPU
#   scripts/moe/pc.sh pull [SUBDIR]          ~/moe/runs[/SUBDIR] -> $MOE_ROOT/pc-runs/ here
#   scripts/moe/pc.sh stop [NAME]            stop one job (or all) and its simulator shards
set -u
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MOE_ROOT=${MOE_ROOT:-/mnt/data/forgeaip/moe2}
HOST=${FORGEAIP_PC:-sigure@100.113.219.35}
KEY=${FORGEAIP_PC_KEY:-$HOME/.ssh/id_ed25519_pc}
SSH=(ssh -T -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 -i "$KEY" "$HOST")
scp_to() { scp -q -o BatchMode=yes -o IdentitiesOnly=yes -i "$KEY" "$@"; }
wsl_run() {   # wsl_run <local script> [args...]: the script runs in WSL; exit code is the script's
  local f=$1; shift
  scp_to "$f" "$HOST:C:/forgeaip/dl/_moe_$$.sh"
  "${SSH[@]}" "powershell -NoProfile -Command \"\$ErrorActionPreference='Continue'; wsl.exe -d Ubuntu-22.04 -- bash /mnt/c/forgeaip/dl/_moe_$$.sh $* 2>&1 | ForEach-Object { \\\"\$_\\\" }\"" | tr -d '\r'
}
tmp() { mktemp; }
cmd=${1:-status}; shift || true
case $cmd in
probe)
  f=$(tmp); cat > "$f" <<'EOS'
echo "cores $(nproc)  load $(cut -d' ' -f1-3 /proc/loadavg)  mem $(free -g | awk '/Mem/{print $3"/"$2" GB"}')"
echo "python3 $(python3 --version 2>&1)  gpuvenv: $(~/gpuvenv/bin/python --version 2>&1)"
~/gpuvenv/bin/python - <<'PY'
import importlib
for m in ("numpy", "jax", "jaxlib", "optax", "scipy", "xgboost", "lightgbm"):
    try:
        x = importlib.import_module(m); print(m, getattr(x, "__version__", "?"))
    except Exception as e:
        print(m, "MISSING", type(e).__name__)
PY
command -v uv || ls ~/.local/bin 2>/dev/null | head
ls ~/sim ~/sim/r 2>/dev/null | head -30
ls ~/sim/tiles | wc -l
nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader 2>&1 | head -2
EOS
  wsl_run "$f"; rm -f "$f";;
install)
  T=$(mktemp -d)
  [ -x "$REPO/tools/sim/target/bookworm/release/forgeaip-sim" ] || "$REPO/tools/sim/build.sh"
  (cd "$REPO" && tar czf "$T/moe.tgz" --exclude=__pycache__ moe) || exit 1
  scp_to "$REPO/tools/sim/target/bookworm/release/forgeaip-sim" "$HOST:C:/forgeaip/dl/forgeaip-sim-moe2" "$T/moe.tgz" "$REPO/scripts/moe/pc/jobs.py" "$HOST:C:/forgeaip/dl/" 2>/dev/null \
    || { scp_to "$REPO/tools/sim/target/bookworm/release/forgeaip-sim" "$HOST:C:/forgeaip/dl/forgeaip-sim-moe2"; scp_to "$T/moe.tgz" "$REPO/scripts/moe/pc/jobs.py" "$HOST:C:/forgeaip/dl/"; }
  cat > "$T/install.sh" <<'EOS'
set -e
D=/mnt/c/forgeaip/dl
mkdir -p ~/moe/code ~/moe/logs ~/moe/runs ~/moe/x ~/moe/scenarios ~/sim
cp "$D/forgeaip-sim-moe2" ~/sim/forgeaip-sim-moe2.new && mv -f ~/sim/forgeaip-sim-moe2.new ~/sim/forgeaip-sim-moe2 && chmod +x ~/sim/forgeaip-sim-moe2
rm -rf ~/moe/code.new ~/moe/code.old && mkdir -p ~/moe/code.new && (cd ~/moe/code.new && tar xzf "$D/moe.tgz") && cp "$D/jobs.py" ~/moe/jobs.py
mv ~/moe/code/moe ~/moe/code.old 2>/dev/null || true; mkdir -p ~/moe/code && mv ~/moe/code.new/moe ~/moe/code/moe
for m in scipy xgboost lightgbm; do ~/gpuvenv/bin/python -c "import $m" 2>/dev/null || NEED="$NEED $m"; done
if [ -n "${NEED:-}" ]; then
  if command -v uv >/dev/null || [ -x ~/.local/bin/uv ]; then U=$(command -v uv || echo ~/.local/bin/uv); $U pip install --python ~/gpuvenv/bin/python $NEED 2>&1 | tail -3
  else ~/gpuvenv/bin/python -m pip install $NEED 2>&1 | tail -3; fi
fi
cd ~/moe/code && PYTHONPATH=~/moe/code JAX_PLATFORMS=cpu ~/gpuvenv/bin/python -m moe.cli gen --out ~/moe/scenarios | wc -l
echo "installed: sim $(ls -l ~/sim/forgeaip-sim-moe2 | awk '{print $5}') bytes, $(ls ~/sim/tiles | wc -l) tiles, scenarios $(ls ~/moe/scenarios | wc -l)"
EOS
  wsl_run "$T/install.sh"; rm -rf "$T";;
run)
  name=${1:?name}; shift
  [[ $name =~ ^[a-z0-9_-]{1,40}$ ]] || { echo "bad name" >&2; exit 2; }
  for a in "$@"; do [[ $a =~ ^[A-Za-z0-9_.,:=/+-]+$ ]] || { echo "bad argument $a" >&2; exit 2; }; done
  f=$(tmp); cat > "$f" <<EOS
cd ~/moe
nohup env PYTHONPATH=\$HOME/moe/code JAX_PLATFORMS=cpu OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 XLA_FLAGS="--xla_cpu_multi_thread_eigen=false intra_op_parallelism_threads=1" setsid \$HOME/gpuvenv/bin/python jobs.py $* > logs/$name.log 2>&1 < /dev/null &
echo \$! > logs/$name.pid
echo "started $name pid \$(cat logs/$name.pid)"
EOS
  wsl_run "$f"; rm -f "$f";;
status)
  f=$(tmp); cat > "$f" <<'EOS'
echo "load $(cut -d' ' -f1-3 /proc/loadavg)  $(date '+%F %T')"
for p in ~/moe/logs/*.pid; do [ -f "$p" ] || continue; n=$(basename "$p" .pid); if kill -0 "$(cat "$p")" 2>/dev/null; then s=RUNNING; else s=ended; fi; echo "== $n [$s] $(tail -n 3 ~/moe/logs/$n.log | cut -c1-220)"; done
echo "sim shards: $(pgrep -fc forgeaip-sim-moe2)   trainers: $(pgrep -fc 'moe.cli')"
nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader 2>&1 | head -1
EOS
  wsl_run "$f"; rm -f "$f";;
peek)   # load, cpu split, the last update of every training of TAG (default: the newest)
  tag=${1:-}
  f=$(tmp); cat > "$f" <<EOS
cut -d' ' -f1-3 /proc/loadavg
echo "cpu: sim \$(ps -eo pcpu,args | awk '/forgeaip-sim-moe2/ && !/awk/{s+=\$1} END{print s+0}')  python \$(ps -eo pcpu,args | awk '/moe.cli/ && !/awk/{s+=\$1} END{print s+0}')"
cd ~/moe/runs; t=${tag:-\$(ls -t | head -1)}
for d in \$t/*/; do e=\$(basename \$d); [ -f \$d/train_log.jsonl ] || continue
  tail -n1 \$d/train_log.jsonl | python3 -c "
import sys, json
for l in sys.stdin:
    d = json.loads(l); print('%-16s steps %8d  success_recent %s  sps %s' % ('\$e', d['steps'], d['success_recent'], d['sps']))"
  [ -f \$d/final.npz ] && echo "                 final: \$(cat \$d/train_result.json 2>/dev/null | cut -c1-150)"; done
tail -n 20 ~/moe/logs/*.log | grep -a "held-out" | cut -c1-260
EOS
  wsl_run "$f"; rm -f "$f";;
pull)
  sub=${1:-}
  [[ $sub =~ ^[A-Za-z0-9_./-]*$ ]] || { echo "bad subdir" >&2; exit 2; }
  f=$(tmp); cat > "$f" <<EOS
rm -rf /mnt/c/forgeaip/dl/moe-pull; mkdir -p /mnt/c/forgeaip/dl/moe-pull
cd ~/moe/runs && tar cf - --exclude='episodes.jsonl' --exclude='checkpoint.npz' ${sub:-.} | (cd /mnt/c/forgeaip/dl/moe-pull && tar xf -)
du -sh /mnt/c/forgeaip/dl/moe-pull
EOS
  wsl_run "$f"; rm -f "$f"
  mkdir -p "$MOE_ROOT/pc-runs/${sub%/*}" && scp -q -r -o BatchMode=yes -o IdentitiesOnly=yes -i "$KEY" "$HOST:C:/forgeaip/dl/moe-pull/*" "$MOE_ROOT/pc-runs/${sub%/*}/" && echo "pulled to $MOE_ROOT/pc-runs/${sub%/*}";;
stop)
  name=${1:-}
  f=$(tmp); cat > "$f" <<EOS
for p in ~/moe/logs/${name:-*}.pid; do [ -f "\$p" ] && kill "\$(cat "\$p")" 2>/dev/null; done
sleep 2; pkill -f forgeaip-sim-moe2 2>/dev/null; pkill -f 'moe.cli' 2>/dev/null; pkill -f 'jobs.py' 2>/dev/null; echo stopped
EOS
  wsl_run "$f"; rm -f "$f";;
*) echo "usage: pc.sh probe|install|run|status|pull|stop" >&2; exit 2;;
esac
