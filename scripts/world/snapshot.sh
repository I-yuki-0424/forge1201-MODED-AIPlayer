#!/usr/bin/env bash
# Consistent snapshot of the running build world: saving paused, everything flushed, the world folder archived, saving
# resumed. Writes <label>-<UTC time>.tar.gz plus .json (manifest: mods with sha256, Forge version, size) to the snapshots
# folder. Labels starting with "auto" are pruned to the newest $KEEP_AUTO; every other label is kept.
#   scripts/world/snapshot.sh ladder-course       # a named state to reuse
#   scripts/world/snapshot.sh --list
source "$(dirname "$0")/lib.sh"
KEEP_AUTO=${KEEP_AUTO:-24}
if [ "${1:-}" = --list ]; then
  python3 - "$SNAPS" <<'EOF'
import glob, json, os, sys
for m in sorted(glob.glob(os.path.join(sys.argv[1], "*.json")), key=os.path.getmtime, reverse=True):
    d = json.load(open(m))
    print("{:55s} {:8.1f} MB  mods={:<3d} {}".format(d["file"], d["bytes"] / 1e6, len(d["mods"]), d["label"]))
EOF
  exit 0
fi
label=${1:?usage: snapshot.sh <label> | --list}
[[ $label =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || { echo "label: lower-case letters, digits and '-' only" >&2; exit 2; }
if ! running "$WORLD"; then
  [ "$label" = auto ] && exit 0          # the hourly timer: nothing to save while the world is stopped
  echo "$WORLD is not running" >&2; exit 1
fi
name="$label-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
rcon "save-off" >/dev/null
trap 'rcon "save-on" >/dev/null' EXIT
rcon "save-all flush" >/dev/null
# As container root (= coder on the host with rootless Docker), so the archive is coder's file.
docker exec -u 0 "$WORLD" tar -czf "/snapshots/$name.part" -C /data world
mv "$SNAPS/$name.part" "$SNAPS/$name"; chmod 0644 "$SNAPS/$name"
rcon "save-on" >/dev/null; trap - EXIT
mods=$(cd "$MODS" && find . -maxdepth 1 -name '*.jar' -printf '%f\n' | sort | while read -r j; do printf '%s  %s\n' "$(sha256sum "$j" | cut -c1-64)" "$j"; done)
MODS_LIST=$mods python3 - "$SNAPS/$name" "$label" <<'EOF'
import hashlib, json, os, sys
f, label = sys.argv[1], sys.argv[2]
mods = [dict(zip(("sha256", "file"), l.split("  ", 1))) for l in os.environ["MODS_LIST"].splitlines() if l]
h = hashlib.sha256()
with open(f, "rb") as fh:
    for chunk in iter(lambda: fh.read(1 << 20), b""):
        h.update(chunk)
json.dump({"file": os.path.basename(f), "label": label, "sha256": h.hexdigest(), "bytes": os.path.getsize(f), "forge": "1.20.1-47.4.10",
           "level_type": "flat", "seed": "20261031", "mods": mods}, open(f[:-len(".tar.gz")] + ".json", "w"), indent=1)
EOF
echo "snapshot $name ($(du -h "$SNAPS/$name" | cut -f1))"
if [[ $label == auto* ]]; then
  ls -1t "$SNAPS"/auto*-[0-9]*.tar.gz 2>/dev/null | tail -n +$((KEEP_AUTO + 1)) | while read -r old; do rm -f "$old" "${old%.tar.gz}.json"; done
fi
