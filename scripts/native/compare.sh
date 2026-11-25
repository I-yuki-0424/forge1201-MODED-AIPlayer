#!/usr/bin/env bash
# scripts/native/compare.sh TEST SEED [NAME=value ...]   one equal-seed comparison on test world 7 (TASK-20261125-076's slot): TEST with mineflayer's physics, clicks and dig
# time, then with the native ones (NATIVE_PHYSICS / NATIVE_INVENTORY / NATIVE_DIG / NATIVE_INPUTS=1), each on a NEW world of the same seed (suite.sh SEEDS, FIRST=7).
# Refuses to start between 03:00 and 06:00 JST (the reboot window). Results: /mnt/data/forgeaip-play/t26/out/cmp-<test>-<seed>-{mf,native}/verdict.txt
set -euo pipefail
TEST=${1:?test}; SEED=${2:?seed}; shift 2
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
h=$(TZ=Asia/Tokyo date +%H); if [ "$h" -ge 3 ] && [ "$h" -lt 6 ]; then echo "03:00-06:00 JST: not started" >&2; exit 3; fi
for mode in ${MODES:-mf native}; do
  h=$(TZ=Asia/Tokyo date +%H); if [ "$h" -ge 3 ] && [ "$h" -lt 6 ]; then echo "03:00-06:00 JST: $mode not started" >&2; exit 3; fi
  EXTRA=(); [ "$mode" = native ] && EXTRA=(NATIVE_PHYSICS=1 NATIVE_INVENTORY=1 NATIVE_DIG=1 NATIVE_INPUTS=1)
  REPO=$HERE SEEDS="$SEED" FIRST=7 RUN="cmp-$TEST-$SEED-$mode" "$HERE/scripts/t26/suite.sh" "$TEST" 1 "${EXTRA[@]}" "$@" | tail -3
done
