#!/usr/bin/env bash
# scripts/t26/down.sh N [--purge]   stop T26 test world N (--purge also deletes its world volume). Never touches other containers.
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd); N=${1:?number}; [[ $N =~ ^[1-9]$ ]] || exit 2
export N PORT=$((25590 + N)) REPO SEED= RCON_PASSWORD=x XDG_RUNTIME_DIR=/run/user/1000 DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/1000/docker.sock}
"$REPO/scripts/t26/dev.sh" "$N" stop >/dev/null 2>&1 || true
docker compose -f "$REPO/docker/t26/compose.yaml" --project-directory "$REPO/docker/t26" down $([ "${2:-}" = --purge ] && echo -v) >/dev/null && echo "T26 world $N down"
