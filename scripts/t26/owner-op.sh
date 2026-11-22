#!/usr/bin/env bash
# scripts/t26/owner-op.sh   keeps the owner seia_y the only operator of every running T26 test world (offline mode).
# A running server takes `op <name>` from the online player's own profile, so the owner is opped when they are on the server; any other operator entry is removed.
# (The server image resolves OPS names at Mojang: it opped "Seia_Y", another account; the cache maps seia_y to it while the owner is offline.) One instance (flock); every 5 s.
set -u
OWNER=seia_y; OWNER_UUID=0d1dd89f-28fa-3770-a9b2-1c9f33cb5442      # UUID.nameUUIDFromBytes("OfflinePlayer:seia_y")
R=$(cd "$(dirname "$0")/../.." && pwd)
exec 9>/tmp/claude-1000/t26-owner-op.lock 2>/dev/null || exec 9>"$R/.owner-op.lock"
flock -n 9 || { echo "owner-op already runs"; exit 0; }
while :; do
  for c in $(docker ps --format '{{.Names}}' | grep -E '^forgeaip-t26-[0-9]+$'); do
    n=${c#forgeaip-t26-}
    ops=$(docker exec "$c" cat /data/ops.json 2>/dev/null) || continue
    # anyone else on the list goes
    for name in $(echo "$ops" | python3 -c "import json,sys; [print(o['name']) for o in json.load(sys.stdin) if o['uuid'] != '$OWNER_UUID']" 2>/dev/null); do
      "$R/scripts/t26/rcon.sh" "$n" deop "$name" >/dev/null 2>&1 && echo "$(date +%T) t26-$n: removed operator $name"
    done
    # the owner online and not on the list: op by the online profile
    if ! echo "$ops" | grep -q "$OWNER_UUID" && "$R/scripts/t26/rcon.sh" "$n" list 2>/dev/null | grep -qw "$OWNER"; then
      "$R/scripts/t26/rcon.sh" "$n" op "$OWNER" >/dev/null 2>&1
      docker exec "$c" cat /data/ops.json 2>/dev/null | grep -q "$OWNER_UUID" && echo "$(date +%T) t26-$n: $OWNER is the operator" || echo "$(date +%T) t26-$n: op $OWNER did not take the offline profile"
    fi
  done
  sleep 5
done
