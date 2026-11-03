#!/usr/bin/env bash
# Build/test in the rust container (std only, offline): tools/tblog/target/bookworm/release/forgeaip-tblog
set -euo pipefail
d=$(cd "$(dirname "$0")" && pwd)
[ $# -gt 0 ] || set -- build --release --offline --quiet
docker run --rm --network none -e CARGO_TARGET_DIR=/t/tblog/target/bookworm -v "$d/..":/t -w /t/tblog rust:1-bookworm cargo "$@"
