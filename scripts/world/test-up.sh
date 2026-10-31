#!/usr/bin/env bash
# Start a disposable copy of a snapshot (file name, label or "latest") on 127.0.0.1:25568, world in tmpfs.
# Bots and benchmarks run here; nothing they do reaches the build world. Stop with scripts/world/test-down.sh.
source "$(dirname "$0")/lib.sh"
snap=$(snapshot_file "${1:?usage: test-up.sh <snapshot file | label | latest>}")
[ -f "$COMPOSE_DIR/.env" ] || { umask 077; echo "RCON_PASSWORD=$(openssl rand -hex 16)" > "$COMPOSE_DIR/.env"; }
SNAPSHOT=$snap compose --profile test up -d --force-recreate world-test
wait_healthy forgeaip-world-test
for r in "doMobSpawning false" "doDaylightCycle false" "doWeatherCycle false"; do RCON_CONTAINER=forgeaip-world-test rcon "gamerule $r" >/dev/null; done
echo "test copy of $snap up on 127.0.0.1:25568"
