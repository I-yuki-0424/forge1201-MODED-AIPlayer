#!/usr/bin/env bash
# scripts/ci/trigger.sh   the CI trigger (coder's crontab every 15 minutes through kvs-run, job forgeaip:ci-trigger; docs/implemented/CI-v1.md). Starts scripts/ci/regress.sh when
#   - a NEW main commit has stood still for DEBOUNCE_MIN (30) minutes (a burst of pushes is one run, of its last commit), and the last run ended GAP_MIN (60) minutes ago or more, or
#   - nightly: at 21:xx JST when no run started in the last 20 hours (the same commit again: the random-seed repeat and the run-to-run spread),
# and never when a run is going (the lock), in 02:00-06:00 JST (a run must not reach the 03:00 reboot window; regress.sh also skips a test that could not end before 03:00).
# Reads only GitHub's public refs (git ls-remote) and the history; state in /mnt/data/forgeaip-play/t26/out/ci/trigger.state.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CI_HOME=${CI_HOME:-/mnt/data/forgeaip-play/t26/out/ci}; URL=https://github.com/I-yuki-0424/forge1201-MODED-AIPlayer.git
DEBOUNCE_MIN=${DEBOUNCE_MIN:-30}; GAP_MIN=${GAP_MIN:-60}
mkdir -p "$CI_HOME"; ST=$CI_HOME/trigger.state; NOW=$(date +%s); H=$(TZ=Asia/Tokyo date +%-H)
say() { echo "$*"; [ -n "${KVS_RUN_SUMMARY:-}" ] && echo "$*" > "$KVS_RUN_SUMMARY"; return 0; }
if [ "$H" -ge 2 ] && [ "$H" -lt 6 ]; then say "02:00-06:00 JST: no start"; exit 0; fi
if ! flock -n "$CI_HOME/lock" true 2>/dev/null; then say "a run is going"; exit 0; fi
HEAD=$(git ls-remote "$URL" refs/heads/main | cut -c1-40); [[ $HEAD =~ ^[0-9a-f]{40}$ ]] || { say "no main head from GitHub"; exit 1; }
last() { grep -v '"label":"[a-z]' "$CI_HOME/history.jsonl" 2>/dev/null | tail -1 | python3 -I -c "import json,sys; l=sys.stdin.read().strip(); d=json.loads(l) if l else {}; print(d.get('$1') or '')"; }
LAST_SHA=$(last sha); LAST_START=$(last started); LAST_END=$(last ended)
PEND=""; SEEN=0; [ -f "$ST" ] && read -r PEND SEEN < "$ST"
why=""
if [ "$HEAD" != "$LAST_SHA" ]; then
  if [ "$HEAD" != "$PEND" ]; then echo "$HEAD $NOW" > "$ST"; say "new main ${HEAD:0:8}: waiting $DEBOUNCE_MIN min for it to stand still"; exit 0; fi
  [ $((NOW - SEEN)) -ge $((DEBOUNCE_MIN * 60)) ] || { say "main ${HEAD:0:8} seen $(( (NOW - SEEN) / 60 )) min ago: debouncing"; exit 0; }
  [ -z "$LAST_END" ] || [ $((NOW - LAST_END)) -ge $((GAP_MIN * 60)) ] || { say "last run ended $(( (NOW - LAST_END) / 60 )) min ago: waiting for the gap"; exit 0; }
  why=commit
elif [ "$H" = 21 ] && { [ -z "$LAST_START" ] || [ $((NOW - LAST_START)) -ge 72000 ]; }; then why=nightly
else say "nothing to do (main ${HEAD:0:8} tested)"; exit 0; fi
say "starting a CI run ($why) of ${HEAD:0:8}"
exec "$HERE/scripts/ci/regress.sh"
