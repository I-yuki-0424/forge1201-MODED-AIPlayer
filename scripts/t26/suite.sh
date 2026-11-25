#!/usr/bin/env bash
# scripts/t26/suite.sh TEST [WORLDS] [NAME=value ...]   the owner's standard run (2026-11-14): WORLDS (default 3) test worlds of the current profile, each regenerated with a NEW random seed,
# TEST run on all of them in parallel, then graded together (suite.js: success only at the test's required rate; 80 % or below = failure, 90 % = WIP, 100 % = success).
# TEST = move_a | move_b | mine_a | mine_b | place_a | place_b. SEEDS="s1 s2 s3" gives world k the k-th seed instead of a random one (an equal-box comparison of two settings: run the
# suite twice with the same SEEDS). FIRST=k uses worlds k..k+WORLDS-1 (two suites side by side). KEEP=1 reuses the running worlds (a debugging run: never evidence).
# TW_PROFILE=<name> runs it on another version. Logs and results: /mnt/data/forgeaip-play/t26/out/<RUN>/.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/profile.sh"
TEST=${1:?test}; shift; WORLDS=${1:-3}; [[ $WORLDS =~ ^[1-9]$ ]] && shift || WORLDS=3
RUN=${RUN:-$TEST-$TW_TAG-$(date +%m%d-%H%M)}; F=${FIRST:-1}; LIST=$(seq "$F" $((F + WORLDS - 1))); OUT=$TW_HOME/out/$RUN; mkdir -p "$OUT"
echo "$TW_PROFILE" > "$OUT/profile.txt"
if [ "${KEEP:-0}" != 1 ]; then i=0; read -ra SD <<< "${SEEDS:-}"; for N in $LIST; do S=(); [ -n "${SD[$i]:-}" ] && S=(--seed "${SD[$i]}"); i=$((i + 1)); "$TW_REPO/scripts/t26/up.sh" "$N" --new "${S[@]}" > "$OUT/up-w$N.log" 2>&1 & done; wait; fi
for N in $LIST; do grep -h " up " "$OUT/up-w$N.log" 2>/dev/null; done
for N in $LIST; do "$TW_REPO/scripts/t26/run.sh" "$N" "$TEST.js" RUN="$RUN" "$@" > "$OUT/$TEST-w$N.log" 2>&1 & done; wait
docker run --rm --network none -v "$TW_REPO":/app:ro -v "$TW_HOME/out":/out -w /app "$NODE_IMG" node scripts/t26/suite.js "/out/$RUN" "$TEST" | tee "$OUT/verdict.txt"
