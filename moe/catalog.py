"""The expert catalogue and its scenario files (docs/proposed/MOE-v1.md).

`catalog.json` is data: per expert its prerequisites (`needs`), goal, step budget and standardised start distribution. This module loads and
checks it and turns the start distribution into one scenario file per expert for `forgeaip-sim run --scenario` (tools/sim, docs/proposed/SCENARIO-v1.md):
kit counts are ranges that the simulator draws at the start of every episode. Training and evaluation use the same distribution but different
worlds (tiles) and seeds, so an expert is never scored on a start it was trained on.
"""
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
CATALOG = HERE / "catalog.json"
GROUPS = ("#log", "#planks")
SCAN_GROUPS = ("log", "coal", "iron", "way", "sky")        # the simulator's target scan (tools/sim/src/scan.rs), docs/proposed/MOE-v2.md


class CatalogError(ValueError):
    pass


def load(path=CATALOG):
    cat = json.loads(pathlib.Path(path).read_text())
    check(cat)
    return cat


def experts(cat):
    return {e["id"]: e for e in cat["experts"]}


def relevance(e):
    """Indices (into SCAN_GROUPS) of the target groups the router calls relevant for expert `e` (an item expert's ore or trees; a movement expert's waypoint)."""
    return tuple(SCAN_GROUPS.index(g) for g in e.get("targets", []))


def check(cat):
    """Unknown keys, a goal that nothing pays, a need that is neither an item nor a group: errors, so a typo cannot train another expert."""
    if cat.get("v") not in (1, 2):
        raise CatalogError("catalog: v must be 1 or 2")
    items = set(cat["items"])
    seen = set()
    for e in cat["experts"]:
        extra = set(e) - {"id", "doc", "makes", "needs", "goal", "max_steps", "hostiles", "start", "approach", "targets", "kind"}
        if extra:
            raise CatalogError(f"{e.get('id')}: unknown keys {sorted(extra)}")
        if e["id"] in seen or not e["id"].replace("_", "").isalnum():
            raise CatalogError(f"bad or duplicate id {e['id']}")
        seen.add(e["id"])
        goal = e["goal"]
        skill = e.get("kind", "item") == "skill"
        if e.get("kind", "item") not in ("item", "skill"):
            raise CatalogError(f"{e['id']}: kind is item or skill")
        for g in e.get("targets", []):
            if g not in SCAN_GROUPS:
                raise CatalogError(f"{e['id']}: unknown target group {g}")
        if not goal or set(goal) - {"have", "entry", "reach"} or (skill and "reach" not in goal) or ("reach" in goal and not skill):
            raise CatalogError(f"{e['id']}: goal needs `have` and/or `entry` (an item expert) or `reach` (a skill expert, MOE-v2)")
        for name in list(goal.get("have", {})) + list(e["needs"]) + list(e["start"]["kit"]):
            if name not in items and name not in GROUPS:
                raise CatalogError(f"{e['id']}: `{name}` is not in the catalogue's item list")
        for n, (lo, hi) in e["start"]["kit"].items():
            if not (0 <= lo <= hi) or hi < 1:
                raise CatalogError(f"{e['id']}: kit range of {n}")
        if skill:
            if e["makes"] is not None or e["needs"] and not isinstance(e["needs"], dict):
                raise CatalogError(f"{e['id']}: a skill expert makes nothing (makes: null)")
        elif e["makes"] not in goal.get("have", {}):
            raise CatalogError(f"{e['id']}: `makes` must be a key of goal.have")
        for b in e.get("approach", []):
            if not isinstance(b, str) or not b:
                raise CatalogError(f"{e['id']}: approach lists block names")
        if e["max_steps"] < 1 or not 0 <= e["hostiles"] <= 5:
            raise CatalogError(f"{e['id']}: max_steps/hostiles")
    makers = [e["makes"] for e in cat["experts"] if e.get("kind", "item") == "item"]
    if len(set(makers)) != len(makers):
        raise CatalogError("two experts make the same item")
    for e in cat["experts"]:
        for need in e["needs"]:
            if need not in makers and need not in cat["equivalent"]:
                raise CatalogError(f"{e['id']}: nothing makes `{need}`")
    for k, v in cat["equivalent"].items():
        if k not in makers or any(x not in cat["items"] for x in v):
            raise CatalogError(f"equivalent of `{k}`")
    for k, (lo, hi) in cat["junk"].items():
        if k not in items or not (0 <= lo <= hi):
            raise CatalogError(f"junk `{k}`")
    if cat["chain"]["goal"] not in makers:
        raise CatalogError("chain goal is not an expert")
    return cat


def scenario(e, cat, variant=None):
    """The scenario (schema v1 of tools/sim/src/scenario.rs) of expert `e`: its kit ranges, the junk it must ignore, the placed ores, its end condition."""
    start = dict(e["start"])
    if variant:
        start.update(start.get("variants", {})[variant])
    kit = {n: list(r) for n, r in cat["junk"].items() if r[1] >= 1}
    kit.update({n: list(r) for n, r in start["kit"].items()})
    end = dict(e["goal"], max_steps=e["max_steps"], die=True)
    if "reach" in end:
        end = {"reach": end["reach"], "max_steps": e["max_steps"], "die": True}
    sc = {"v": 1, "id": e["id"] + (f"-{variant}" if variant else ""), "doc": f"{e['id']}: {e['doc']}", "kit": kit, "hostiles": e["hostiles"],
          "place": json.loads(json.dumps(start["place"])), "end": end}
    if cat.get("v") == 2:
        sc["scan"] = True                                    # v2 experts always get the scan observation; which groups they see is the router's call
        for k in ("waypoint", "trap", "require"):
            if k in start:
                sc[k] = start[k]
    return sc


def scenario(e, cat, variant=None):
    """The scenario (schema v1 of tools/sim/src/scenario.rs) of expert `e`: its kit ranges, the junk it must ignore, the placed ores, its end condition."""
    start = dict(e["start"])
    if variant:
        start.update(start.get("variants", {})[variant])
    kit = {n: list(r) for n, r in cat["junk"].items() if r[1] >= 1}
    kit.update({n: list(r) for n, r in start["kit"].items()})
    end = dict(e["goal"], max_steps=e["max_steps"], die=True)
    if "reach" in end:
        end = {"reach": end["reach"], "max_steps": e["max_steps"], "die": True}
    sc = {"v": 1, "id": e["id"] + (f"-{variant}" if variant else ""), "doc": f"{e['id']}: {e['doc']}", "kit": kit, "hostiles": e["hostiles"],
          "place": json.loads(json.dumps(start["place"])), "end": end}
    if cat.get("v") == 2:
        sc["scan"] = True                                    # v2 experts always get the scan observation; which groups they see is the router's call
        for k in ("waypoint", "trap"):
            if k in start:
                sc[k] = start[k]
    return sc


def variants(e):
    """Scenario ids an expert is trained on: its own, plus the `variants` of its start (a trap is a shaft or a pocket: one scenario file each)."""
    return [e["id"]] + [f"{e['id']}-{v}" for v in e["start"].get("variants", {})]


def chain_scenarios(cat):
    """The whole chain: a plain start (natural) and one with coal and iron placed around the start (placed). Both end when the goal item is held."""
    c = cat["chain"]
    end = {"have": {c["goal"]: 1}, "max_steps": c["max_steps"], "die": False}
    far = cat.get("v") == 2
    placed = [{"id": "coal", "block": "coal_ore", "size": [2, 5], "mode": "surface", "dist": [4, 40] if far else [4, 12]},
              {"id": "iron", "block": "iron_ore", "size": [3, 5], "mode": "surface", "dist": [6, 48] if far else [6, 16]}]
    scan = {"scan": True} if far else {}
    nat = {"require": ["coal", "iron"]} if far else {}                 # natural ore: a start without coal and iron within 4 chunks is not a start
    return [{"v": 1, "id": "chain-natural", "doc": c["doc"], "end": end, **scan, **nat},
            {"v": 1, "id": "chain-placed", "doc": c["doc"] + " Coal and iron ore are placed on the surface around the start.", "hostiles": 0.3, "place": placed, "end": end, **scan}]


def write_all(out_dir):
    """<out>/<expert>.json for every expert and <out>/chain-*.json. Returns the list of paths."""
    cat = load()
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    paths = []
    own = [scenario(e, cat, v) for e in cat["experts"] for v in [None] + list(e["start"].get("variants", {}))]
    for sc in own + chain_scenarios(cat):
        p = out / f"{sc['id']}.json"
        p.write_text(json.dumps(sc, indent=1) + "\n")
        paths.append(str(p))
    return paths
