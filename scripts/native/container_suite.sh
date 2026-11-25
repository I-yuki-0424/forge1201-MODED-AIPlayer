#!/usr/bin/env bash
# scripts/native/container_suite.sh [K=3] [NAME=value ...]   container_a on K NEW worlds one after another on test world 7 (this task's only slot), then its
# negative control (CONTROL=noop) on the last one. Results: /mnt/data/forgeaip-play/t26/out/cta-<stamp>-<k>/container_a-w7.json
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
K=${K:-3}; STAMP=$(date +%m%d-%H%M)
for k in $(seq 1 "$K"); do
  h=$(TZ=Asia/Tokyo date +%H); if [ "$h" -ge 3 ] && [ "$h" -lt 6 ]; then echo "03:00-06:00 JST: stop" >&2; exit 3; fi
  "$HERE/scripts/t26/up.sh" 7 --new | tail -1
  REPO=$HERE "$HERE/scripts/t26/run.sh" 7 ../native/container_a.js "RUN=cta-$STAMP-$k" "$@" 2>&1 | grep '\[container_a' | cut -c1-400
done
REPO=$HERE "$HERE/scripts/t26/run.sh" 7 ../native/container_a.js "RUN=cta-$STAMP-noop" CONTROL=noop 2>&1 | grep '\[container_a' | cut -c1-400
