#!/usr/bin/env bash
# scripts/t26/dev.sh N start|stop|logs   the /dev watcher of T26 world N (container forgeaip-t26-dev-N; started by up.sh). It reads the world's request file read-only and runs tests as children.
set -euo pipefail
N=${1:?world}; ACT=${2:-start}; [[ $N =~ ^[1-9]$ ]] || exit 2
SELF=/home/coder/projects/forge1201-MODED-AIPlayer; HOME_=/mnt/data/forgeaip-play/t26
export XDG_RUNTIME_DIR=/run/user/1000 DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/1000/docker.sock}
case $ACT in
stop) docker kill "forgeaip-t26-dev-$N" >/dev/null 2>&1 || true; echo "dev watcher $N stopped";;
logs) docker logs --tail 60 "forgeaip-t26-dev-$N";;
start)
  docker kill "forgeaip-t26-dev-$N" >/dev/null 2>&1 || true; sleep 1
  . "$HOME_/.env"
  docker run -d --rm --name "forgeaip-t26-dev-$N" --network "forgeaip-t26-${N}_net" --memory 3g -v "forgeaip-t26-${N}_data":/mcdata:ro -v "$SELF":/app:ro -v "$SELF/node_modules":/app/node_modules:ro -v "$HOME_/out":/out -w /app \
    -e MC_HOST=mc -e RCON_HOST=mc -e RCON_PASSWORD="$RCON_PASSWORD" -e MC_VERSION=26.1 -e BOT_REGISTRY=vanilla -e T26_WORLD="$N" \
    node@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 node scripts/t26/dev_watch.js >/dev/null
  echo "dev watcher $N started (container forgeaip-t26-dev-$N)";;
esac
