#!/usr/bin/env bash
# scripts/t26/batch.sh RUN "W1 W2 ..." "V1 V2 ..."   build_t on new random worlds in parallel: worlds W* the Overworld blueprint, worlds V* the Nether one. Logs: /mnt/data/forgeaip-play/t26/out/RUN-w<N>.log
set -u
RUN=${1:?run}; OW=${2:-}; NW=${3:-}; D=/mnt/data/forgeaip-play/t26/out; R=$(cd "$(dirname "$0")/../.." && pwd)
for w in $OW; do ( "$R/scripts/t26/up.sh" "$w" --new >/dev/null 2>&1 && timeout 14000 "$R/scripts/t26/run.sh" "$w" build_t.js LITEMATIC=/app/tests/fixtures/iron-farm-34.litematic BOTS=8 LIMIT_MIN=200 RUN="$RUN" ) > "$D/$RUN-w$w.log" 2>&1 & done
for w in $NW; do ( "$R/scripts/t26/up.sh" "$w" --new >/dev/null 2>&1 && timeout 14000 "$R/scripts/t26/run.sh" "$w" build_t.js LITEMATIC=/app/tests/fixtures/iron-farm-34-nether-side-main.litematic DIM=nether BOTS=8 LIMIT_MIN=200 RUN="$RUN" ) > "$D/$RUN-w$w.log" 2>&1 & done
wait
