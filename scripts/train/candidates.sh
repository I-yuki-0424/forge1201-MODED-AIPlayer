#!/usr/bin/env bash
# Start-site candidates of a world seed (tools/site-finder, cubiomes): exchange/sites-<seed>.json, made once, then reused by every
# environment of that seed (VPS and PC). Prints the file's path.
#   scripts/train/candidates.sh <seed> [count]
source "$(dirname "$0")/lib.sh"
seed=${1:?seed}; count=${2:-20000}
[[ $seed =~ ^-?[0-9]{1,19}$ && $count =~ ^[0-9]{1,7}$ ]] || { echo "usage: $0 <seed> [count]" >&2; exit 2; }
out=$REPO/exchange/sites-$seed.json
if [ ! -s "$out" ]; then
  (cd "$REPO/tools/site-finder" && cargo build --release --quiet)
  "$REPO/tools/site-finder/target/release/site-finder" --seed "$seed" --count "$count" --threads 4 > "$out.tmp"
  mv "$out.tmp" "$out"
fi
echo "$out"
