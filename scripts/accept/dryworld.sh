#!/usr/bin/env bash
# ./dryworld.sh N [tries]   (re)generate acceptance world N with a random seed until its starting chunk is dry land (ACCEPTANCE-v1: a beach or sea chunk is a different problem)
set -uo pipefail
N=${1:?number}; TRIES=${2:-8}; ACCDIR=/mnt/data/forgeaip-play/accept
for i in $(seq 1 "$TRIES"); do
  "$ACCDIR/up.sh" "$N" --new >/dev/null 2>&1 || { echo "world $N did not start" >&2; continue; }
  if ACC=$N "$(dirname "$0")/run.sh" t1_chunk.js DRYCHECK=1 BOTS=1 > /tmp/dryworld.$N.log 2>&1; then echo "world $N: dry starting chunk, try $i, $(grep -m1 -o 'Seed: \[[-0-9]*\]' /tmp/dryworld.$N.log)"; exit 0; fi
  echo "world $N try $i: wet starting chunk ($(grep -m1 -o 'Seed: \[[-0-9]*\]' /tmp/dryworld.$N.log))" >&2
done
exit 1
