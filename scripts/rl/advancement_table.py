#!/usr/bin/env python3
"""Advancement table for the RL reward (docs/proposed/RL-TRAINING-v2.md): every advancement of the mod set with its parent
and `steps`, the number of advancements on the way to it (its depth in the advancement tree, itself included).

Tab roots are chained to the advancement that opens them in survival, so depth counts across tabs:
  minecraft:nether/root <- minecraft:story/enter_the_nether, minecraft:end/root <- minecraft:story/enter_the_end.
Recipe unlocks (`*/recipes/*`) and advancements without a display are bookkeeping, not achievements, and are left out.

  scripts/rl/advancement_table.py <server-extra.jar> <mod.jar> ... > modpack/forgeaip-create.advancements.json
The jars come from a server of the mod set (docker cp forgeaip-world:/data/libraries/net/minecraft/server/1.20.1-*/
server-1.20.1-*-extra.jar and /data/mods/*.jar); scripts/rl/advancement-table.sh does both steps.
"""
import json
import re
import sys
import zipfile

ROOT_LINKS = {"minecraft:nether/root": "minecraft:story/enter_the_nether", "minecraft:end/root": "minecraft:story/enter_the_end"}
PATH = re.compile(r"^data/([a-z0-9_.-]+)/advancements/([a-z0-9_/.-]+)\.json$")


def read(jars):
    adv = {}
    for jar in jars:
        with zipfile.ZipFile(jar) as z:
            for name in z.namelist():
                m = PATH.match(name)
                if not m or "/recipes/" in name or m.group(2).startswith("recipes/"):
                    continue
                d = json.loads(z.read(name))
                if "display" not in d:
                    continue
                aid = f"{m.group(1)}:{m.group(2)}"
                adv[aid] = {"parent": ROOT_LINKS.get(aid, d.get("parent")), "frame": d["display"].get("frame", "task"),
                            "hidden": bool(d["display"].get("hidden", False)), "criteria": sorted(d.get("criteria", {})),
                            "requirements": d.get("requirements") or [[c] for c in sorted(d.get("criteria", {}))]}
    return adv


def depth(adv, aid, seen=()):
    p = adv[aid]["parent"]
    if p is None or p not in adv:
        return 1
    if aid in seen:
        raise ValueError(f"cycle at {aid}")
    return 1 + depth(adv, p, seen + (aid,))


def main(jars):
    adv = read(jars)
    out = {aid: {**a, "steps": depth(adv, aid)} for aid, a in sorted(adv.items())}
    json.dump({"v": 1, "source": [j.rsplit("/", 1)[-1] for j in jars], "root_links": ROOT_LINKS, "advancements": out},
              sys.stdout, indent=1, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
