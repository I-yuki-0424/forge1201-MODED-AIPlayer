#!/usr/bin/env bash
# scripts/t26/speed.sh N [k]   the game speed of test world N (docs/implemented/SPEED-v1.md, TASK-20261125-079): with k, the server ticks at 20*k ticks/s (vanilla `/tick rate`, 1.20.3+; a server
# setting, not a bot cheat: day length, movement, digging, growth and mobs all scale together); without k, prints the current factor. The bots follow by themselves (src/transport/time_scale.js
# follow: the server announces its rate to every client). The rate is not saved with the world: up.sh sets it on every start (the profile's `speed`, or SPEED=k).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/profile.sh"
tw_names "${1:?world number}"
R() { "$TW_REPO/scripts/t26/rcon.sh" "$TW_N" "$@"; }
if [ -n "${2:-}" ]; then
  [[ $2 =~ ^[0-9]+(\.[0-9]+)?$ ]] && python3 -c "import sys; k=float(sys.argv[1]); sys.exit(0 if 0.1 <= k <= 10 else 1)" "$2" || { echo "speed k in [0.1, 10], not $2" >&2; exit 2; }
  R tick rate "$(python3 -c "import sys; print(round(20 * float(sys.argv[1]), 3))" "$2")"
else
  R tick query | python3 -c "import re, sys; m = re.search(r'Target tick rate: ([\d.]+)', sys.stdin.read()); print(round(float(m.group(1)) / 20, 3) if m else '?')"
fi
