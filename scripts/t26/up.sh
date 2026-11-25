#!/usr/bin/env bash
# scripts/t26/up.sh N [--new] [--seed S]   [SPEED=k: game speed for this start, default the profile's `speed`]   start test world N of the current profile (docs/implemented/TEST-WORLDS-T26.md; the version comes from docker/tw/PROFILE or TW_PROFILE).
# --new throws the old world away: a NEW random seed (or --seed S). Game port 100.77.246.23:(portBase+N) (tailnet only; harness containers join the world's network).
# Data: docker volume <project>_data. Secrets: /mnt/data/forgeaip-play/t26/.env (RCON password, mode 600).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/profile.sh"
N=${1:?number 1..9}; shift; tw_names "$N"
NEW=0; SEED=""; while [ $# -gt 0 ]; do case $1 in --new) NEW=1;; --seed) SEED=$2; shift;; *) echo "unknown $1" >&2; exit 2;; esac; shift; done
export SEED
"$TW_REPO/scripts/t26/mods.sh" >/dev/null
[ -f "$TW_HOME/.env" ] || { umask 077; echo "RCON_PASSWORD=$(head -c 32 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 24)" > "$TW_HOME/.env"; }
. "$TW_HOME/.env"; export RCON_PASSWORD
C=(docker compose -f "$TW_REPO/docker/tw/compose.yaml" --project-directory "$TW_REPO/docker/tw")
if [ $NEW = 1 ]; then
  if docker ps --format '{{.Names}}' | grep -q "^live-$TW_TAG-$N-"; then echo "world $N: a test is running on it (live-$TW_TAG-$N-*): not thrown away" >&2; exit 1; fi
  "$TW_REPO/scripts/t26/dev.sh" "$N" stop >/dev/null 2>&1 || true          # the watcher mounts the world volume: while it runs the volume cannot be removed (the "new" world kept its seed)
  "${C[@]}" down -v >/dev/null 2>&1 || true
  docker volume rm "$TW_VOL" >/dev/null 2>&1 || true
  if docker volume inspect "$TW_VOL" >/dev/null 2>&1; then echo "world $N: the old volume is still there (in use?): not a new world" >&2; exit 1; fi
fi
# the operator from the first start: the owner Seia_Y by the offline-mode UUID of the name (no Mojang lookup; the image's OPS resolved names at Mojang and opped another account)
OWNER=Seia_Y; OWNER_UUID=734c8e10-06c7-37ad-9971-6f79965693a1          # UUID.nameUUIDFromBytes("OfflinePlayer:Seia_Y")
if ! docker ps --format '{{.Names}}' | grep -q "^$TW_SERVER\$"; then
  docker volume create "$TW_VOL" >/dev/null
  printf '[{"uuid":"%s","name":"%s","level":4,"bypassesPlayerLimit":false}]\n' "$OWNER_UUID" "$OWNER" | docker run --rm -i -v "$TW_VOL":/data --entrypoint sh "$TW_IMAGE" -c 'cat > /data/ops.json && chown 1000:1000 /data/ops.json'
fi
"${C[@]}" up -d mc >/dev/null
for _ in $(seq 1 150); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$TW_SERVER" 2>/dev/null)" = healthy ] && break; sleep 4; done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$TW_SERVER")" = healthy ] || { docker logs --tail 40 "$TW_SERVER" >&2; echo "test world $N not healthy" >&2; exit 1; }
R() { "$TW_REPO/scripts/t26/rcon.sh" "$N" "$@"; }
# game rule names differ between versions (keep_inventory on 26.x, keepInventory on 1.21.x): rule.sh asks the server which spelling it knows
for g in keep_inventory send_command_feedback log_admin_commands; do "$TW_REPO/scripts/t26/rule.sh" "$N" "$g" false >/dev/null; done      # the console echoed every display command
docker exec "$TW_SERVER" sh -c 'mkdir -p /data/world/scripts && cp /dev-app/dev.sc /data/world/scripts/dev.sc'
R script load dev global >/dev/null
"$TW_REPO/scripts/t26/speed.sh" "$N" "${SPEED:-$TW_SPEED}" >/dev/null     # the game speed (docs/implemented/SPEED-v1.md): the profile's `speed`, SPEED=k for one start; the bots follow the server
"$TW_REPO/scripts/t26/dev.sh" "$N" start >/dev/null
echo "test world $N up ($TW_PROFILE, speed x$("$TW_REPO/scripts/t26/speed.sh" "$N")): $(R seed) | join 100.77.246.23:$TW_PORT (tailnet) | container $TW_SERVER"
