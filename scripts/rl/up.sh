#!/usr/bin/env bash
# Start the RL Forge server (docker/rl-server) and wait until it is healthy. Idempotent.
set -euo pipefail
cd "$(dirname "$0")/../../docker/rl-server"
[ -f .env ] || { umask 077; echo "RCON_PASSWORD=$(openssl rand -hex 16)" > .env; }
docker compose up -d mc
for _ in $(seq 1 90); do
  s=$(docker inspect -f '{{.State.Health.Status}}' forgeaip-rl-mc 2>/dev/null || echo none)
  [ "$s" = healthy ] && { echo "mc healthy"; exit 0; }
  sleep 5
done
echo "mc not healthy after 450 s" >&2; docker logs --tail 40 forgeaip-rl-mc >&2; exit 1
