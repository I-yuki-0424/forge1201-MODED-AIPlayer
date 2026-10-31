#!/usr/bin/env bash
# Start the build world (idempotent) and apply its game rules. 127.0.0.1:25567; the owner's tailnet reaches it on :25565.
source "$(dirname "$0")/lib.sh"
[ -f "$COMPOSE_DIR/.env" ] || { umask 077; echo "RCON_PASSWORD=$(openssl rand -hex 16)" > "$COMPOSE_DIR/.env"; }
# Mods: exactly the server jars of modpack/forgeaip-create.lock.json (sha512-checked); the client pack is built next to them.
python3 -I "$REPO/modpack/pack.py" server "$MODS"
python3 -I "$REPO/modpack/pack.py" mrpack "$CLIENT_PACK" >/dev/null
compose up -d world
wait_healthy "$WORLD"
# A built scene must stay as built: no natural spawning, fixed time and weather, nothing burns or griefs.
for r in "doMobSpawning false" "doDaylightCycle false" "doWeatherCycle false" "doFireTick false" "mobGriefing false" \
         "keepInventory true" "doInsomnia false" "doPatrolSpawning false" "doTraderSpawning false"; do
  rcon "gamerule $r" >/dev/null
done
rcon "time set day" >/dev/null
echo "build world up: $(rcon list)"
