# Shared prelude of scripts/play/*.sh (sourced). Same rootless-Docker handling as scripts/world/lib.sh.
set -euo pipefail
if [ "$(id -u)" = 0 ]; then
  exec sudo -u coder -H env XDG_RUNTIME_DIR=/run/user/1000 DOCKER_HOST=unix:///run/user/1000/docker.sock bash "$0" "$@"
fi
export XDG_RUNTIME_DIR=/run/user/1000 DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/1000/docker.sock}
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
COMPOSE_DIR=$REPO/docker/play-server
PLAY=${PLAY_DIR:-/mnt/data/forgeaip-play}        # jars, client-only jars, snapshots: outside the repository
compose() { docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/compose.yaml" "$@"; }
rcon() { docker exec forgeaip-play rcon-cli "$@" | sed 's/\x1b\[[0-9;]*m//g'; }
