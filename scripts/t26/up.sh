#!/usr/bin/env bash
# scripts/t26/up.sh N [--new] [--seed S]   start T26 test world N (Fabric 26.1.2; docs/implemented/TEST-WORLDS-T26.md). --new throws the old world away: a NEW random seed (or --seed S).
# Game port 100.77.246.23:(25590+N) (tailnet only; harness containers join network forgeaip-t26-N_net). Data: docker volume forgeaip-t26-N_data. Secrets: /mnt/data/forgeaip-play/t26/.env (RCON password, mode 600).
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd); HOME_=/mnt/data/forgeaip-play/t26
N=${1:?number 1..9}; shift; [[ $N =~ ^[1-9]$ ]] || { echo "N must be 1..9" >&2; exit 2; }
NEW=0; SEED=""; while [ $# -gt 0 ]; do case $1 in --new) NEW=1;; --seed) SEED=$2; shift;; *) echo "unknown $1" >&2; exit 2;; esac; shift; done
export N PORT=$((25590 + N)) REPO SEED XDG_RUNTIME_DIR=/run/user/1000 DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/1000/docker.sock}
"$REPO/scripts/t26/mods.sh" >/dev/null
[ -f "$HOME_/.env" ] || { umask 077; echo "RCON_PASSWORD=$(head -c 32 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 24)" > "$HOME_/.env"; }
. "$HOME_/.env"; export RCON_PASSWORD
C=(docker compose -f "$REPO/docker/t26/compose.yaml" --project-directory "$REPO/docker/t26")
if [ $NEW = 1 ]; then
  if docker ps --format '{{.Names}}' | grep -q "^live-t26-$N-"; then echo "world $N: a test is running on it (live-t26-$N-*): not thrown away" >&2; exit 1; fi
  "$REPO/scripts/t26/dev.sh" "$N" stop >/dev/null 2>&1 || true          # the watcher mounts the world volume: while it runs the volume cannot be removed (the "new" world kept its seed)
  "${C[@]}" down -v >/dev/null 2>&1 || true
  docker volume rm "forgeaip-t26-${N}_data" >/dev/null 2>&1 || true
  if docker volume inspect "forgeaip-t26-${N}_data" >/dev/null 2>&1; then echo "world $N: the old volume is still there (in use?): not a new world" >&2; exit 1; fi
fi
"${C[@]}" up -d mc >/dev/null
for _ in $(seq 1 150); do [ "$(docker inspect -f '{{.State.Health.Status}}' forgeaip-t26-$N 2>/dev/null)" = healthy ] && break; sleep 4; done
[ "$(docker inspect -f '{{.State.Health.Status}}' forgeaip-t26-$N)" = healthy ] || { docker logs --tail 40 forgeaip-t26-$N >&2; echo "t26 world $N not healthy" >&2; exit 1; }
"$REPO/scripts/t26/rcon.sh" "$N" gamerule keep_inventory false >/dev/null
for g in send_command_feedback log_admin_commands; do "$REPO/scripts/t26/rcon.sh" "$N" gamerule "$g" false >/dev/null; done      # 26.1 names: the camelCase ones are rejected, the console echoed every display command
docker exec forgeaip-t26-$N sh -c 'mkdir -p /data/world/scripts && cp /dev-app/dev.sc /data/world/scripts/dev.sc'
"$REPO/scripts/t26/rcon.sh" "$N" script load dev global
"$REPO/scripts/t26/dev.sh" "$N" start >/dev/null
echo "T26 world $N up: $("$REPO/scripts/t26/rcon.sh" "$N" seed) | join 100.77.246.23:$PORT (tailnet) | container forgeaip-t26-$N"
