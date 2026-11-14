#!/usr/bin/env bash
# scripts/t26/suite.sh TEST [WORLDS] [NAME=value ...]   the owner's standard run (2026-11-14): WORLDS (default 3) T26 worlds, each regenerated with a NEW random seed, TEST run on all of them
# in parallel, then graded together (suite.js: success only at the test's required rate; 80 % or below = failure, 90 % = WIP, 100 % = success). TEST = move_a | move_b | mine_a | mine_b | place_a | place_b.
# FIRST=k uses worlds k..k+WORLDS-1 (two suites side by side). KEEP=1 reuses the running worlds (a debugging run: never evidence). Logs and results: /mnt/data/forgeaip-play/t26/out/<RUN>/.
set -uo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TEST=${1:?test}; shift; WORLDS=${1:-3}; [[ $WORLDS =~ ^[1-9]$ ]] && shift || WORLDS=3
RUN=${RUN:-$TEST-$(date +%m%d-%H%M)}; F=${FIRST:-1}; LIST=$(seq "$F" $((F + WORLDS - 1))); OUT=/mnt/data/forgeaip-play/t26/out/$RUN; mkdir -p "$OUT"
if [ "${KEEP:-0}" != 1 ]; then for N in $LIST; do "$REPO/scripts/t26/up.sh" "$N" --new > "$OUT/up-w$N.log" 2>&1 & done; wait; fi
for N in $LIST; do grep -h "up:" "$OUT/up-w$N.log" 2>/dev/null; done
for N in $LIST; do "$REPO/scripts/t26/run.sh" "$N" "$TEST.js" RUN="$RUN" "$@" > "$OUT/$TEST-w$N.log" 2>&1 & done; wait
node_img=node@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
docker run --rm --network none -v "$REPO":/app:ro -v /mnt/data/forgeaip-play/t26/out:/out -w /app "$node_img" node scripts/t26/suite.js "/out/$RUN" "$TEST" | tee "$OUT/verdict.txt"
