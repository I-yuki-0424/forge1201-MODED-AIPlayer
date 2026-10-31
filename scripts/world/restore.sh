#!/usr/bin/env bash
# Roll the build world back to a snapshot (file name, label or "latest"). The current state is snapshotted first
# (label auto-before-restore), so a restore can itself be undone.
source "$(dirname "$0")/lib.sh"
snap=$(snapshot_file "${1:?usage: restore.sh <snapshot file | label | latest>}")
if running "$WORLD"; then "$(dirname "$0")/snapshot.sh" auto-before-restore; fi
compose stop world
# The world volume is only reachable through a container; reuse the server image (it has tar) as a one-off.
image=$(docker inspect -f '{{.Config.Image}}' "$WORLD")
docker run --rm --entrypoint /bin/sh -v forgeaip-world_data:/data -v "$SNAPS":/snapshots:ro "$image" \
  -c "set -e; rm -rf /data/world; tar -xzf '/snapshots/$snap' -C /data; chown -R 1000:1000 /data/world"
"$(dirname "$0")/up.sh"
echo "restored $snap"
