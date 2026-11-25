#!/usr/bin/env bash
# scripts/t26/down.sh N [--purge]   stop test world N of the current profile (--purge also deletes its world volume). Never touches other containers.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/profile.sh"
tw_names "${1:?number}"; export SEED= RCON_PASSWORD=x
"$TW_REPO/scripts/t26/dev.sh" "$TW_N" stop >/dev/null 2>&1 || true
docker compose -f "$TW_REPO/docker/tw/compose.yaml" --project-directory "$TW_REPO/docker/tw" down $([ "${2:-}" = --purge ] && echo -v) >/dev/null 2>&1 && echo "test world $TW_N ($TW_PROFILE) down"
