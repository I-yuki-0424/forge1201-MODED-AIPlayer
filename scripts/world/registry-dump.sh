#!/usr/bin/env bash
# Rebuild modpack/forgeaip-create.registry.json, the exact block/item table the bot needs for the mod set
# (src/transport/mod_registry.js). Run after every change of modpack/forgeaip-create.lock.json, then commit the table.
# Builds tools/registry-dump if needed (JDK 17 container), starts it once on a tmpfs copy of a snapshot (default latest)
# next to the lock's server jars, copies the table out. The build world is not touched; stop it first if memory is short.
source "$(dirname "$0")/lib.sh"
JDK=eclipse-temurin@sha256:91011320978c10ec51d2cde1eb6f616db6d2a739a0e521096c343dd3fed9abe6
TOOL=$REPO/tools/registry-dump
OUT=$REPO/modpack/forgeaip-create.registry.json
snap=$(snapshot_file "${1:-latest}")
if [ ! -f "$TOOL/build/libs/forgeaip-registrydump-1.0.0.jar" ]; then
  docker run --rm --memory 3g -u 0 -v forgeaip-gradle:/root/.gradle -v "$TOOL":/src -w /src "$JDK" ./gradlew --no-daemon -q build
fi
python3 -I "$REPO/modpack/pack.py" server "$MODS" >/dev/null
[ -f "$COMPOSE_DIR/.env" ] || { umask 077; echo "RCON_PASSWORD=$(openssl rand -hex 16)" > "$COMPOSE_DIR/.env"; }
SNAPSHOT=$snap compose --profile dump up -d --force-recreate registry-dump >/dev/null
for _ in $(seq 1 120); do running forgeaip-registry-dump || break; sleep 5; done
if ! docker cp forgeaip-registry-dump:/data/registry.json "$OUT.tmp" 2>/dev/null; then
  docker logs --tail 40 forgeaip-registry-dump >&2; compose --profile dump rm -f registry-dump >/dev/null; exit 1
fi
compose --profile dump rm -f registry-dump >/dev/null
python3 -I - "$OUT.tmp" "$OUT" <<'PY'
import json, sys
t = json.load(open(sys.argv[1]))
mod = [b for b in t['blocks'] if not b['name'].startswith('minecraft:')]
# One line per block: diffs of the table stay readable when the lock changes.
with open(sys.argv[2], 'w') as f:
    f.write('{\n' + ',\n'.join(f'"{k}": {json.dumps(v)}' for k, v in t.items() if k not in ('blocks', 'shapes', 'items')))
    for k in ('blocks', 'shapes', 'items'):
        f.write(f',\n"{k}": [\n' + ',\n'.join(json.dumps(x, separators=(',', ':')) for x in t[k]) + '\n]')
    f.write('\n}\n')
print(f"{sys.argv[2]}: {len(t['blocks'])} blocks ({len(mod)} mod), {t['blockStates']} states, {len(t['items'])} mod items, "
      f"{len(t['shapes'])} shapes, {len(t['problems'])} problems")
for p in t['problems'][:20]: print('  problem:', p)
PY
rm -f "$OUT.tmp"
