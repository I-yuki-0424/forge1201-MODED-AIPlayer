#!/usr/bin/env bash
# RL-MOVE-v3 / pit-expert training on the owner's PC GPU (WSL2 Ubuntu-22.04, ~/gpuvenv), driven from the VPS over ssh (same host and key as scripts/moe/pc.sh).
# Owner permission 2026-11-11 (chat): PC resources may be used. Polite by design: nice 10, a GPU memory cap (XLA_PYTHON_CLIENT_PREALLOCATE=false, MEM_FRACTION 0.35),
# and a pause file the owner can touch: C:\forgeaip\rl3\PAUSE (training sleeps while it exists).
#   scripts/rl3/pc.sh probe                 python/jax/GPU on the PC
#   scripts/rl3/pc.sh install               copy rl3/ (the python package) to ~/rl3/code in WSL
#   scripts/rl3/pc.sh run NAME ARGS...      "python -m rl3.cli ARGS" detached, log ~/rl3/logs/NAME.log (--out /out/NAME maps to ~/rl3/runs/NAME)
#   scripts/rl3/pc.sh status | tail NAME [N] | pull NAME | stop NAME
set -u
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${RL3_OUT:-/mnt/data/forgeaip/rl3}
HOST=${FORGEAIP_PC:-sigure@100.113.219.35}
KEY=${FORGEAIP_PC_KEY:-$HOME/.ssh/id_ed25519_pc}
SSH=(ssh -T -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 -i "$KEY" "$HOST")
scp_to() { scp -q -o BatchMode=yes -o IdentitiesOnly=yes -i "$KEY" "$@"; }
wsl_run() {
  local f=$1; shift
  scp_to "$f" "$HOST:C:/forgeaip/dl/_rl3_$$.sh"
  "${SSH[@]}" "powershell -NoProfile -Command \"\$ErrorActionPreference='Continue'; wsl.exe -d Ubuntu-22.04 -- bash /mnt/c/forgeaip/dl/_rl3_$$.sh $* 2>&1 | ForEach-Object { \\\"\$_\\\" }\"" | tr -d '\r'
}
cmd=${1:-status}; shift || true
case $cmd in
probe)
  f=$(mktemp); cat > "$f" <<'EOS'
~/gpuvenv/bin/python - <<'PY'
import jax; print("jax", jax.__version__, jax.devices())
PY
nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader
EOS
  wsl_run "$f"; rm -f "$f";;
install)
  T=$(mktemp -d); (cd "$REPO" && tar czf "$T/rl3.tgz" --exclude=__pycache__ --exclude=tests rl3) || exit 1
  scp_to "$T/rl3.tgz" "$HOST:C:/forgeaip/dl/rl3.tgz"
  cat > "$T/i.sh" <<'EOS'
set -e
mkdir -p ~/rl3/code ~/rl3/logs ~/rl3/runs /mnt/c/forgeaip/rl3
rm -rf ~/rl3/code/rl3 && (cd ~/rl3/code && tar xzf /mnt/c/forgeaip/dl/rl3.tgz)
echo "installed: $(find ~/rl3/code/rl3 -name '*.py' | wc -l) files"
EOS
  wsl_run "$T/i.sh"; rm -rf "$T";;
run)
  name=${1:?name}; shift
  [[ $name =~ ^[a-z0-9_-]{1,40}$ ]] || { echo "bad name" >&2; exit 2; }
  for a in "$@"; do [[ $a =~ ^[A-Za-z0-9_.,:=/+-]+$ ]] || { echo "bad argument $a" >&2; exit 2; }; done
  f=$(mktemp); cat > "$f" <<EOS
cd ~/rl3/code
mkdir -p ~/rl3/runs/$name
nohup nice -n 10 env PYTHONPATH=\$HOME/rl3/code RL3_PAUSE=/mnt/c/forgeaip/rl3/PAUSE XLA_PYTHON_CLIENT_PREALLOCATE=false XLA_PYTHON_CLIENT_MEM_FRACTION=0.35 TF_CPP_MIN_LOG_LEVEL=2 setsid \$HOME/gpuvenv/bin/python -m rl3.cli $* > ~/rl3/logs/$name.log 2>&1 < /dev/null &
echo \$! > ~/rl3/logs/$name.pid
sleep 1; echo "started $name pid \$(cat ~/rl3/logs/$name.pid)"
EOS
  wsl_run "$f"; rm -f "$f";;
status)
  f=$(mktemp); cat > "$f" <<'EOS'
echo "load $(cut -d' ' -f1-3 /proc/loadavg)  $(date '+%F %T')"
for p in ~/rl3/logs/*.pid; do [ -f "$p" ] || continue; n=$(basename "$p" .pid); if kill -0 "$(cat "$p")" 2>/dev/null; then s=RUNNING; else s=ended; fi; echo "== $n [$s] $(tail -n 2 ~/rl3/logs/$n.log | cut -c1-230 | tr '\n' '|')"; done
nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader 2>&1 | head -1
[ -f /mnt/c/forgeaip/rl3/PAUSE ] && echo "PAUSE file present"
EOS
  wsl_run "$f"; rm -f "$f";;
tail)
  name=${1:?name}; n=${2:-30}; [[ $name =~ ^[a-z0-9_-]+$ && $n =~ ^[0-9]+$ ]] || exit 2
  f=$(mktemp); echo "tail -n $n ~/rl3/logs/$name.log | cut -c1-260" > "$f"; wsl_run "$f"; rm -f "$f";;
pull)
  name=${1:?name}; [[ $name =~ ^[a-z0-9_-]+$ ]] || exit 2
  f=$(mktemp); cat > "$f" <<EOS
rm -rf /mnt/c/forgeaip/dl/rl3-pull; mkdir -p /mnt/c/forgeaip/dl/rl3-pull
cp -r ~/rl3/runs/$name /mnt/c/forgeaip/dl/rl3-pull/ && du -sh /mnt/c/forgeaip/dl/rl3-pull
EOS
  wsl_run "$f"; rm -f "$f"
  mkdir -p "$OUT" && scp -q -r -o BatchMode=yes -o IdentitiesOnly=yes -i "$KEY" "$HOST:C:/forgeaip/dl/rl3-pull/$name" "$OUT/" && echo "pulled to $OUT/$name";;
stop)
  name=${1:?name}; [[ $name =~ ^[a-z0-9_-]+$ ]] || exit 2
  f=$(mktemp); echo "[ -f ~/rl3/logs/$name.pid ] && kill \$(cat ~/rl3/logs/$name.pid) 2>/dev/null; echo stopped $name" > "$f"; wsl_run "$f"; rm -f "$f";;
*) echo "usage: pc.sh probe|install|run|status|tail|pull|stop" >&2; exit 2;;
esac
