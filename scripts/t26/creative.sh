#!/usr/bin/env bash
# scripts/t26/creative.sh up|down|status|restart-console|rcon CMD...   the owner's creative standing server of the current profile (Fabric 1.21.1: fabric121-creative on
# 100.77.246.23:25620) and its work console (fabric121-console-creative, 100.77.246.23:3034), docker/tw/creative.yaml. Data: volume fabric121-worlds_creative_data,
# /mnt/data/forgeaip-play/creative121 (.env with the RCON password, mode 600; console-data/creative). `down` stops both and keeps the world.
# The console mounts the main checkout read-only: `restart-console` deploys the committed code (check console-data/creative/state.json for a running job first).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/profile.sh"
H=/mnt/data/forgeaip-play/creative121; mkdir -p "$H/console-data/creative"
[ -f "$H/.env" ] || { umask 077; echo "RCON_PASSWORD=$(head -c 32 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 24)" > "$H/.env"; }
. "$H/.env"; export RCON_PASSWORD
C=(docker compose -f "$TW_REPO/docker/tw/creative.yaml" --project-directory "$H")
case ${1:-status} in
up)
  "$TW_REPO/scripts/t26/mods.sh" >/dev/null
  if ! docker volume inspect fabric121-worlds_creative_data >/dev/null 2>&1; then
    docker volume create fabric121-worlds_creative_data >/dev/null
    # the only operator: the owner by the offline-mode UUID of the name (UUID.nameUUIDFromBytes("OfflinePlayer:Seia_Y"))
    printf '[{"uuid":"734c8e10-06c7-37ad-9971-6f79965693a1","name":"Seia_Y","level":4,"bypassesPlayerLimit":false}]\n' | docker run --rm -i -v fabric121-worlds_creative_data:/data --entrypoint sh "$TW_IMAGE" -c 'cat > /data/ops.json && chown 1000:1000 /data/ops.json'
  fi
  "${C[@]}" up -d
  for _ in $(seq 1 150); do [ "$(docker inspect -f '{{.State.Health.Status}}' fabric121-creative 2>/dev/null)" = healthy ] && break; sleep 4; done
  echo "fabric121-creative: $(docker inspect -f '{{.State.Health.Status}}' fabric121-creative), console: $(docker inspect -f '{{.State.Status}}' fabric121-console-creative)";;
down) "${C[@]}" stop;;
restart-console) "${C[@]}" restart console-creative;;
status) "${C[@]}" ps;;
rcon) shift; docker exec fabric121-creative rcon-cli -- "$@" | sed 's/\x1b\[[0-9;]*m//g';;
*) echo "up|down|status|restart-console|rcon" >&2; exit 2;;
esac
