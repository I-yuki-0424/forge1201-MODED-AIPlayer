#!/usr/bin/env bash
# scripts/t26/speed_ab.sh N TEST "k1 k2 ..." SEED [NAME=value ...]   the same test on the same seed at several game speeds (docs/implemented/SPEED-v1.md, TASK-20261125-079): for each k a
# NEW world N with seed SEED at speed k (suite.sh, one world, graded by the server), the server sampled every 10 s (speed_sample.sh: ms per tick, achieved rate, CPU) and the harness's event loop
# (loop_lag.js). Runs RUN=<PREFIX>-x<k> (PREFIX default spd-<test>); speed_report.py RUN... sets them side by side. REPO=/path runs another checkout's harness.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/profile.sh"
N=${1:?world}; TEST=${2:?test}; SPEEDS=${3:?speeds}; SEED=${4:?seed}; shift 4
for k in $SPEEDS; do
  RUN=${PREFIX:-spd-$TEST}-x$k; OUT=$TW_HOME/out/$RUN; mkdir -p "$OUT"
  "$TW_REPO/scripts/t26/speed_sample.sh" "$N" "$OUT/speed-w$N.jsonl" 10 & SP=$!
  RUN=$RUN SPEED=$k FIRST=$N SEEDS=$SEED "$TW_REPO/scripts/t26/suite.sh" "$TEST" 1 NODE_ARGS='--require ./scripts/t26/loop_lag.js' "$@"
  kill "$SP" 2>/dev/null; wait "$SP" 2>/dev/null
done
