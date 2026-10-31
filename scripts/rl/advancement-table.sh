#!/usr/bin/env bash
# Rebuild modpack/forgeaip-create.advancements.json from the running build or training server's jars (after a lock change).
#   scripts/rl/advancement-table.sh [container]        default forgeaip-world
set -euo pipefail
cd "$(dirname "$0")/../.."
c="${1:-forgeaip-world}"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
extra="$(docker exec "$c" sh -c 'ls /data/libraries/net/minecraft/server/1.20.1-*/server-1.20.1-*-extra.jar')"
docker cp "$c:$extra" "$tmp/server-extra.jar" >/dev/null
for j in $(docker exec "$c" sh -c 'ls /data/mods/*.jar'); do docker cp "$c:$j" "$tmp/" >/dev/null; done
python3 -I scripts/rl/advancement_table.py "$tmp"/server-extra.jar "$tmp"/*.jar > modpack/forgeaip-create.advancements.json.new
mv modpack/forgeaip-create.advancements.json.new modpack/forgeaip-create.advancements.json
python3 -c "import json;d=json.load(open('modpack/forgeaip-create.advancements.json'))['advancements'];print(len(d),'advancements, max steps',max(a['steps'] for a in d.values()))"
