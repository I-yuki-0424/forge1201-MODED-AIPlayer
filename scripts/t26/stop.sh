#!/usr/bin/env bash
# scripts/t26/stop.sh RUN ["W1 W2 ..."]   stop a batch of scripts/t26/multi.sh: its processes with their children (up.sh, run.sh, timeout), its harness containers by name,
# then the worlds' watchers (they mount the world volumes: left running, the next `up.sh --new` refuses with "the old volume is still there").
# Killing only multi.sh left an up.sh child that started the watchers again after the kill and the next batch did not start (2026-11-25 hb6).
# Never by image or ancestor (the production console shares the node image) and never `pkill -f` with a pattern that matches this shell.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/profile.sh"
RUN=${1:?run}; WS=${2:-"1 2 3 4"}
kids() { local p; for p in $(pgrep -P "$1"); do kids "$p"; echo "$p"; done; }
for p in $(ps -eo pid,args | awk -v r="t26/multi.sh $RUN " '$0 ~ r && !/awk/ {print $1}'); do
  for k in $(kids "$p") "$p"; do kill "$k" 2>/dev/null; done
done
sleep 2
for w in $WS; do for c in $(docker ps --format '{{.Names}}' | grep "^live-$TW_TAG-$w-"); do docker kill "$c" >/dev/null 2>&1; done; done
for w in $WS; do "$TW_REPO/scripts/t26/dev.sh" "$w" stop >/dev/null 2>&1; done
for i in 1 2 3 4 5 6 7 8 9 10; do left=$(docker ps --format '{{.Names}}' | grep -c "^live-$TW_TAG-\|^forgeaip-$TW_TAG-dev-"); [ "$left" = 0 ] && break; sleep 1; done
echo "stopped $RUN; harness containers and watchers left: $left"
