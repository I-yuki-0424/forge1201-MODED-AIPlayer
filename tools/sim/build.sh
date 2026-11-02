#!/usr/bin/env bash
# Build the simulator in the rust container (std only, offline): tools/sim/target/bookworm/release/forgeaip-sim
set -euo pipefail
d=$(cd "$(dirname "$0")" && pwd)
docker run --rm --network none -e CARGO_TARGET_DIR=/w/target/bookworm -v "$d":/w -w /w rust:1-bookworm cargo build --release --offline --quiet "$@"
