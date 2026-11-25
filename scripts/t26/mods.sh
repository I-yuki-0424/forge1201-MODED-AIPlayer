#!/usr/bin/env bash
# scripts/t26/mods.sh   make /mnt/data/forgeaip-play/tw/<tag>/mods exactly the jars of the current profile (docker/tw/<profile>.json): download what is missing, check sha512, remove the rest.
# The jars are untrusted downloads: they live in their own directory and are only ever loaded by the server containers.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/profile.sh"
mkdir -p "$TW_MODS"
python3 -I - "$TW_LOCK" "$TW_MODS" <<'PY'
import json, sys, os, hashlib, urllib.request
lock, d = json.load(open(sys.argv[1])), sys.argv[2]
want = {m["file"]: m for m in lock["mods"]}
for f in os.listdir(d):
    if f not in want: os.remove(os.path.join(d, f)); print("removed", f)
for f, m in want.items():
    if "/" in f or f.startswith("."): sys.exit(f"bad file name {f}")
    p = os.path.join(d, f)
    if os.path.exists(p) and hashlib.sha512(open(p, "rb").read()).hexdigest() == m["sha512"]: continue
    data = urllib.request.urlopen(urllib.request.Request(m["url"], headers={"User-Agent": "forgeaip-test-setup"})).read()
    if hashlib.sha512(data).hexdigest() != m["sha512"]: sys.exit(f"sha512 mismatch: {f}")
    open(p, "wb").write(data); print("downloaded", f)
print(len(want), "mods ok for", lock["name"])
PY
