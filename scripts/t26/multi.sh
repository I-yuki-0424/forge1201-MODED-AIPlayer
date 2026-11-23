#!/usr/bin/env bash
# scripts/t26/multi.sh RUN "W1 W2 ..." [OW=2] [NE=2]   several crews per NEW random world at once (owner 2026-11-23 list 4 problem 9: more finished runs per hour):
# on each world OW crews of 8 bots build iron-farm-34 in the Overworld and NE crews of 2 bots the Nether side, each crew on its own site (build_t.js CREW=k).
# Every world is made new first, so no crew runs on old code. Logs: /mnt/data/forgeaip-play/t26/out/RUN-w<N>c<k>.log. Server: CPUS=3, 6 GB.
set -u
RUN=${1:?run}; WS=${2:?worlds}; OW=${3:-2}; NE=${4:-2}; D=/mnt/data/forgeaip-play/t26/out; R=$(cd "$(dirname "$0")/../.." && pwd)
for w in $WS; do (
  CPUS=${CPUS:-3} MEM_LIMIT=${MEM_LIMIT:-6g} HEAP=${HEAP:-5000M} "$R/scripts/t26/up.sh" "$w" --new > "$D/$RUN-w$w-up.log" 2>&1 || exit 1
  for ((k = 0; k < OW; k++)); do
    ( for try in 1 2 3; do timeout 14000 "$R/scripts/t26/run.sh" "$w" build_t.js LITEMATIC=/app/tests/fixtures/iron-farm-34.litematic BOTS=8 CREW=$k LIMIT_MIN=${LIMIT_MIN:-200} RUN="$RUN" > "$D/$RUN-w${w}c$k.log" 2>&1
        grep -q "no place for the chest\|no ground under the site" "$D/$RUN-w${w}c$k.log" || break; done ) &          # a site without room for the chest: another draw
    sleep 20          # crews set up one after the other (site draw, chest fill by RCON)
  done
  for ((k = OW; k < OW + NE; k++)); do
    MEM=1500m timeout 14000 "$R/scripts/t26/run.sh" "$w" build_t.js LITEMATIC=/app/tests/fixtures/iron-farm-34-nether-side-main.litematic DIM=nether BOTS=2 CREW=$k LIMIT_MIN=${LIMIT_MIN:-200} RUN="$RUN" > "$D/$RUN-w${w}c$k.log" 2>&1 &
    sleep 20
  done
  wait ) & done
wait
