# Shared prelude of scripts/world/*.sh (sourced). The owner arrives as root (`ssh vps`); the world containers belong to
# coder's rootless Docker, so a root caller is re-run as coder with coder's Docker socket.
set -euo pipefail
if [ "$(id -u)" = 0 ]; then
  exec sudo -u coder -H env XDG_RUNTIME_DIR=/run/user/1000 DOCKER_HOST=unix:///run/user/1000/docker.sock bash "$0" "$@"
fi
export XDG_RUNTIME_DIR=/run/user/1000 DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/1000/docker.sock}
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
COMPOSE_DIR=$REPO/docker/world-server
SNAPS=/mnt/data/forgeaip/snapshots
MODS=/mnt/data/forgeaip/mods
WORLD=forgeaip-world
compose() { docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/compose.yaml" "$@"; }
# rcon-cli appends an ANSI reset to every reply (docs/LESSONS.md L4).
rcon() { docker exec "${RCON_CONTAINER:-$WORLD}" rcon-cli "$@" | sed 's/\x1b\[[0-9;]*m//g'; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }
wait_healthy() {
  for _ in $(seq 1 120); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = healthy ] && return 0
    sleep 5
  done
  echo "$1 not healthy after 600 s" >&2; docker logs --tail 60 "$1" >&2; return 1
}
# Resolve a snapshot argument: a file name in $SNAPS, a label (newest snapshot with that label), or "latest".
snapshot_file() {
  local a=${1:?snapshot name, label or latest}
  if [ -f "$SNAPS/$a" ]; then echo "$a"; return; fi
  local f
  if [ "$a" = latest ]; then f=$(ls -1t "$SNAPS"/*.tar.gz 2>/dev/null | head -1)
  else f=$(ls -1t "$SNAPS/$a"-[0-9]*.tar.gz 2>/dev/null | head -1); fi
  [ -n "$f" ] || { echo "no snapshot '$a' in $SNAPS" >&2; return 1; }
  basename "$f"
}
