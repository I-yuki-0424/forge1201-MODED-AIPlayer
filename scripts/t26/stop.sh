#!/usr/bin/env bash
# scripts/t26/stop.sh RUN ["W1 W2 ..."]   stop a batch of scripts/t26/multi.sh: its processes with their children (up.sh, run.sh, timeout), its harness containers by name,
# then the worlds' watchers (they mount the world volumes: left running, the next `up.sh --new` refuses with "the old volume is still there").
# Killing only multi.sh left an up.sh child that started the watchers again after the kill and the next batch did not start (2026-11-25 hb6).
# Never by image or ancestor (the production console shares the node image) and never `pkill -f` with a pattern that matches this shell.
set -u
RUN=${1:?run}; WS=${2:-"1 2 3 4"}; R=$(cd "$(dirname "$0")/../.." && pwd)
kids() { local p; for p in $(pgrep -P "$1"); do kids "$p"; echo "$p"; done; }
for p in $(ps -eo pid,args | awk -v r="t26/multi.sh $RUN " '$0 ~ r && !/awk/ {print $1}'); do
  for k in $(kids "$p") "$p"; do kill "$k" 2>/dev/null; done
done
sleep 2
for c in $(docker ps --format '{{.Names}}' | grep '^live-t26-'); do docker kill "$c" >/dev/null 2>&1; done
for w in $WS; do "$R/scripts/t26/dev.sh" "$w" stop >/dev/null 2>&1; done
for i in 1 2 3 4 5 6 7 8 9 10; do left=$(docker ps --format '{{.Names}}' | grep -c '^live-t26-\|^forgeaip-t26-dev-'); [ "$left" = 0 ] && break; sleep 1; done
echo "stopped $RUN; harness containers and watchers left: $left"
