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


class CatalogError(ValueError):
    pass


def load(path=CATALOG):
    cat = json.loads(pathlib.Path(path).read_text())
    check(cat)
    return cat


def experts(cat):
    return {e["id"]: e for e in cat["experts"]}


def check(cat):
    """Unknown keys, a goal that nothing pays, a need that is neither an item nor a group: errors, so a typo cannot train another expert."""
    if cat.get("v") != 1:
        raise CatalogError("catalog: v must be 1")
    items = set(cat["items"])
    seen = set()
    for e in cat["experts"]:
        extra = set(e) - {"id", "doc", "makes", "needs", "goal", "max_steps", "hostiles", "start"}
        if extra:
            raise CatalogError(f"{e.get('id')}: unknown keys {sorted(extra)}")
        if e["id"] in seen or not e["id"].replace("_", "").isalnum():
            raise CatalogError(f"bad or duplicate id {e['id']}")
        seen.add(e["id"])
        goal = e["goal"]
        if not goal or set(goal) - {"have", "entry"}:
            raise CatalogError(f"{e['id']}: goal needs `have` and/or `entry`")
        for name in list(goal.get("have", {})) + list(e["needs"]) + list(e["start"]["kit"]):
            if name not in items and name not in GROUPS:
                raise CatalogError(f"{e['id']}: `{name}` is not in the catalogue's item list")
        for n, (lo, hi) in e["start"]["kit"].items():
            if not (0 <= lo <= hi) or hi < 1:
                raise CatalogError(f"{e['id']}: kit range of {n}")
        if e["makes"] not in goal.get("have", {}):
            raise CatalogError(f"{e['id']}: `makes` must be a key of goal.have")
        if e["max_steps"] < 1 or not 0 <= e["hostiles"] <= 5:
            raise CatalogError(f"{e['id']}: max_steps/hostiles")
    makers = [e["makes"] for e in cat["experts"]]
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


def scenario(e, cat):
    """The scenario (schema v1 of tools/sim/src/scenario.rs) of expert `e`: its kit ranges, the junk it must ignore, the placed ores, its end condition."""
    kit = {n: list(r) for n, r in cat["junk"].items() if r[1] >= 1}
    kit.update({n: list(r) for n, r in e["start"]["kit"].items()})
    end = dict(e["goal"], max_steps=e["max_steps"], die=True)
    return {"v": 1, "id": e["id"], "doc": f"{e['id']}: {e['doc']}", "kit": kit, "hostiles": e["hostiles"],
            "place": json.loads(json.dumps(e["start"]["place"])), "end": end}


def chain_scenarios(cat):
    """The whole chain: a plain start (natural) and one with coal and iron placed around the start (placed). Both end when the goal item is held."""
    c = cat["chain"]
    end = {"have": {c["goal"]: 1}, "max_steps": c["max_steps"], "die": False}
    placed = [{"id": "coal", "block": "coal_ore", "size": [2, 5], "mode": "surface", "dist": [4, 12]},
              {"id": "iron", "block": "iron_ore", "size": [3, 5], "mode": "surface", "dist": [6, 16]}]
    return [{"v": 1, "id": "chain-natural", "doc": c["doc"], "end": end},
            {"v": 1, "id": "chain-placed", "doc": c["doc"] + " Coal and iron ore are placed on the surface around the start.", "hostiles": 0.3, "place": placed, "end": end}]


def write_all(out_dir):
    """<out>/<expert>.json for every expert and <out>/chain-*.json. Returns the list of paths."""
    cat = load()
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    paths = []
    for sc in [scenario(e, cat) for e in cat["experts"]] + chain_scenarios(cat):
        p = out / f"{sc['id']}.json"
        p.write_text(json.dumps(sc, indent=1) + "\n")
        paths.append(str(p))
    return paths
