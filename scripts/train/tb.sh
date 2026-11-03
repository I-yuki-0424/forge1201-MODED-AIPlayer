#!/usr/bin/env bash
# Learning-status record and viewer (owner 2026-11-03: "the learning status is completely unknown ... in a general-purpose format that
# can be viewed"). docs/proposed/TRAIN-STATUS-v1.md.
#   scripts/train/tb.sh start [--base sim1]   follower (tools/tblog) for the base + TensorBoard on 127.0.0.1:6006
#   scripts/train/tb.sh stop [--base sim1]    stop the follower of that base (TensorBoard stays while other followers run)
#   scripts/train/tb.sh once  [--base sim1]   rebuild the files once from the logs and print the verdict
#   scripts/train/tb.sh status                the verdict of every base (status.json)
# Files per base: exchange/tb/<base>/{events.out.tfevents.0.forgeaip, metrics.csv, status.json}. View: ssh -L 6006:127.0.0.1:6006 to the VPS,
# then http://127.0.0.1:6006 (no authentication, so loopback only; same rule as the MLflow UI). TensorBoard lives in the docker volume
# tb-venv (pip install tensorboard, made on first use), ~250 MB of RAM.
source "$(dirname "$0")/lib.sh"
BIN=$REPO/tools/tblog/target/bookworm/release/forgeaip-tblog
cmd=${1:-status}; shift || true
base=train block=60
while [ $# -gt 0 ]; do case $1 in --base) base=$2; shift 2;; --block) block=$2; shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done
[[ $base =~ ^[a-z0-9_-]{1,40}$ && $block =~ ^[0-9]{1,4}$ ]] || { echo "bad option value" >&2; exit 2; }
build() { [ -x "$BIN" ] && [ -z "$(find "$REPO/tools/tblog/src" -newer "$BIN" 2>/dev/null | head -1)" ] || "$REPO/tools/tblog/build.sh"; }
follower() { echo forgeaip-tblog-$base; }
case $cmd in
start)
  build
  mkdir -p "$REPO/exchange/tb/$base"
  docker rm -f "$(follower)" >/dev/null 2>&1 || true
  docker run -d --name "$(follower)" --restart on-failure:5 --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --memory 64m --cpus 0.2 \
    -v "$REPO/exchange/$base/train":/in:ro -v "$REPO/exchange/tb/$base":/out -v "$BIN":/tblog:ro debian:bookworm-slim /tblog --dir /in --out /out --follow --block "$block" >/dev/null
  if ! docker volume inspect tb-venv >/dev/null 2>&1 || ! docker run --rm -v tb-venv:/venv:ro python:3.12-slim test -x /venv/bin/tensorboard; then
    docker volume create tb-venv >/dev/null
    docker run --rm -v tb-venv:/venv python:3.12-slim sh -c 'python -m venv /venv && /venv/bin/pip install -q tensorboard'
  fi
  if ! running forgeaip-tensorboard; then
    docker rm -f forgeaip-tensorboard >/dev/null 2>&1 || true
    docker run -d --name forgeaip-tensorboard --restart unless-stopped --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true --memory 600m --cpus 0.5 \
      -p 127.0.0.1:6006:6006 -v tb-venv:/venv:ro -v "$REPO/exchange/tb":/tb:ro -e HOME=/tmp python:3.12-slim \
      /venv/bin/tensorboard --logdir /tb --host 0.0.0.0 --port 6006 --reload_interval 30 --samples_per_plugin scalars=100000 >/dev/null
  fi
  echo "tb: following $base; TensorBoard on 127.0.0.1:6006 (ssh -L 6006:127.0.0.1:6006); verdict: scripts/train/tb.sh status";;
stop)
  docker rm -f "$(follower)" >/dev/null 2>&1 || true
  [ -z "$(docker ps -q --filter name=forgeaip-tblog-)" ] && docker rm -f forgeaip-tensorboard >/dev/null 2>&1 || true
  echo "tb: stopped $base";;
once)
  build; mkdir -p "$REPO/exchange/tb/$base"
  "$BIN" --dir "$REPO/exchange/$base/train" --out "$REPO/exchange/tb/$base" --block "$block";;
status)
  for f in "$REPO"/exchange/tb/*/status.json; do [ -f "$f" ] || continue
    python3 -I - "$f" <<'PY'
import json, sys, os
s = json.load(open(sys.argv[1])); b = os.path.basename(os.path.dirname(sys.argv[1]))
blk = s["progress_blocks"]
print(f"{b}: {s['verdict'].upper()}  episodes {s['episodes']}  updates {s['updates']}  steps {s['last_total_steps']}  z(last vs 2 blocks earlier) {s['z_last_vs_two_blocks_earlier']:+.2f}  deaths/episode {s['deaths_per_episode_last_block']:.1f}")
print("   progress per block of %d episodes: %s" % (s["block"], "  ".join(f"{m:.1f}±{1.96*e:.1f}" for m, e in blk[-6:])))
for x in s["flags"]: print("   ! " + x)
PY
  done;;
*) echo "usage: $0 start|stop|once|status [--base B]" >&2; exit 2;;
esac
