#!/usr/bin/env bash
# scripts/t26/deploy-consoles.sh   restart the three fabric26 work consoles on this checkout, only after every module of the builder and the service loads (rootless docker, no network).
set -euo pipefail
R=$(cd "$(dirname "$0")/../.." && pwd)
docker run --rm --network none -v "$R":/w -w /w node:20-slim node tests/test_modules_load_pure.js
docker compose -f /mnt/data/fabric26-worlds/compose.yaml restart console-creative console-survival-hard console-survival-op >/dev/null
sleep 20
for p in 3031 3032 3033; do c=$(curl -s -o /dev/null -w "%{http_code}" "http://100.77.246.23:$p/"); echo "console :$p -> $c"; [ "$c" = 200 ] || { echo "console :$p is not up" >&2; exit 1; }; done
