#!/usr/bin/env bash
# scripts/native/fake_trace.sh N [CASES=a,b]   record the server's own player movement on test world N (TASK-20261125-076) and write the golden traces
# tests/golden_native/srv_<case>.jsonl: carpet fake players driven by the scarpet app scripts/native/ntrace.sc (fake players are ServerPlayers: the
# server runs the game's own player physics for them), then scripts/native/fake_convert.js turns the logs into the shared trace format.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../t26/profile.sh"
tw_names "${1:?world number}"; shift
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
RUN=${RUN:-nt$(date +%s)}
docker exec -i "$TW_SERVER" sh -c 'mkdir -p /data/world/scripts && cat > /data/world/scripts/ntrace.sc' < "$HERE/scripts/native/ntrace.sc"
REPO=$HERE "$HERE/scripts/t26/run.sh" "$TW_N" ../native/fake_trace.js "RUN=$RUN" "$@"
mkdir -p "$TW_HOME/out/$RUN/ntrace"
docker exec "$TW_SERVER" sh -c 'cd /data/world/scripts/ntrace.data 2>/dev/null && tar cf - .' | tar xf - -C "$TW_HOME/out/$RUN/ntrace"
docker run --rm --network none -v "$HERE":/w -v "$TW_HOME/out/$RUN":/run_out:ro -w /w "$NODE_IMG" node scripts/native/fake_convert.js /run_out "$TW_MC"
