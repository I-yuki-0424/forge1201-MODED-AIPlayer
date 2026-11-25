#!/usr/bin/env bash
# scripts/t26/dev.sh N start|stop|logs   the /dev watcher of test world N of the current profile (container <project>-dev; started by up.sh). It reads the world's request file read-only
# and runs tests as children. REPO=/path runs another checkout.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/profile.sh"
tw_names "${1:?world}"; ACT=${2:-start}
SELF=/home/coder/projects/forge1201-MODED-AIPlayer
case $ACT in
stop) docker kill "$TW_DEV" >/dev/null 2>&1 || true; echo "dev watcher $TW_N stopped";;
logs) docker logs --tail 60 "$TW_DEV";;
start)
  docker kill "$TW_DEV" >/dev/null 2>&1 || true; sleep 1
  . "$TW_HOME/.env"; tw_bot_env
  docker run -d --rm --name "$TW_DEV" --network "$TW_NET" --memory 3g -v "$TW_VOL":/mcdata:ro -v "${REPO:-$SELF}":/app:ro -v "$SELF/node_modules":/app/node_modules:ro -v "$TW_HOME/out":/out -w /app \
    "${TW_ENV[@]}" "$NODE_IMG" node scripts/t26/dev_watch.js >/dev/null
  echo "dev watcher $TW_N started (container $TW_DEV)";;
esac
