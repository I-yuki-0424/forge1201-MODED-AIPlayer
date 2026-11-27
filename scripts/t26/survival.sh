#!/usr/bin/env bash
# scripts/t26/survival.sh up|down|status|restart-console|rcon CMD...   the owner's survival standing server of the current profile (Fabric 1.21.1: fabric121-survival-hard on
# 100.77.246.23:25630, Hard and locked, seed 1359280, no cheats) and its work console (fabric121-console-survival-hard, 100.77.246.23:3035), docker/tw/survival.yaml.
# Data: volume fabric121-worlds_survival_hard_data, /mnt/data/forgeaip-play/survival121 (.env with the RCON password, mode 600; console-data/survival). `down` keeps the world.
# The first `up` writes ops.json (Seia_Y, level 1 only), lets the server create the world, then stops it once to set DifficultyLocked in level.dat (scripts/t26/lock-difficulty.js).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/profile.sh"
H=/mnt/data/forgeaip-play/survival121; S=fabric121-survival-hard; V=fabric121-worlds_survival_hard_data; mkdir -p "$H/console-data/survival"
NM=${AIP_REPO:-/home/coder/projects/forge1201-MODED-AIPlayer}/node_modules   # prismarine-nbt for the level.dat edit (worktrees may have none)
[ -f "$H/.env" ] || { umask 077; echo "RCON_PASSWORD=$(head -c 32 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 24)" > "$H/.env"; }
. "$H/.env"; export RCON_PASSWORD
C=(docker compose -f "$TW_REPO/docker/tw/survival.yaml" --project-directory "$H")
healthy() { for _ in $(seq 1 150); do [ "$(docker inspect -f '{{.State.Health.Status}}' $S 2>/dev/null)" = healthy ] && return; sleep 4; done; echo "$S not healthy" >&2; exit 1; }
locked() { docker run --rm -v $V:/data:ro -v "$TW_REPO:/app:ro" -v "$NM:/nm:ro" -e NODE_PATH=/nm -w /app "$NODE_IMG" node scripts/t26/lock-difficulty.js /data/world/level.dat "$@"; }
case ${1:-status} in
up)
  "$TW_REPO/scripts/t26/mods.sh" >/dev/null
  if ! docker volume inspect $V >/dev/null 2>&1; then
    docker volume create $V >/dev/null
    # the only operator: the owner by the offline-mode UUID of the name, level 1 (bypasses spawn protection; no /gamemode, /give, /difficulty, /tp)
    printf '[{"uuid":"734c8e10-06c7-37ad-9971-6f79965693a1","name":"Seia_Y","level":1,"bypassesPlayerLimit":false}]\n' | docker run --rm -i -v $V:/data --entrypoint sh "$TW_IMAGE" -c 'cat > /data/ops.json && chown 1000:1000 /data/ops.json'
  fi
  "${C[@]}" up -d survival; healthy
  if [ "$(locked --check)" != locked ]; then
    "${C[@]}" stop survival
    docker run --rm -v $V:/data -v "$TW_REPO:/app:ro" -v "$NM:/nm:ro" -e NODE_PATH=/nm -w /app -u 1000:1000 "$NODE_IMG" node scripts/t26/lock-difficulty.js /data/world/level.dat
    "${C[@]}" up -d survival; healthy
  fi
  "${C[@]}" up -d
  echo "$S: $(docker inspect -f '{{.State.Health.Status}}' $S), $(locked --check), console: $(docker inspect -f '{{.State.Status}}' fabric121-console-survival-hard)";;
down) "${C[@]}" stop;;
restart-console) "${C[@]}" restart console-survival;;
status) "${C[@]}" ps; locked --check;;
rcon) shift; docker exec $S rcon-cli -- "$@" | sed 's/\x1b\[[0-9;]*m//g';;
*) echo "up|down|status|restart-console|rcon" >&2; exit 2;;
esac
