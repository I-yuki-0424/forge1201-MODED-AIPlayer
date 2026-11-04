#!/usr/bin/env python3
"""The iron tier in detail (companion of entries.py): for each episode of a run, how deep the bot went, whether iron ore was ever offered, and, once
raw iron is in the inventory, whether fuel is held and whether a smelt candidate (= a furnace in reach) is on offer.   iron.py <root> <run base>"""
import glob, json, sys, collections
root, run = sys.argv[1], sys.argv[2]
CMDS = ["pad", "move_to", "mine", "attack", "pickup", "craft", "smelt", "place", "activate", "equip", "eat", "wait", "tunnel"]
dirs = sorted(glob.glob(f"{root}/{run}-s*-sim*"))
for l in open(dirs[0] + "/env_to_policy.jsonl"):
    r = json.loads(l)
    if r.get("type") == "hello": hello = r; break
items = hello["vocab"]["items"]; ix = {n: i for i, n in enumerate(items)}; ids = hello["milestones"]
E = {n: ids.index(n) for n in ("craft_furnace", "place_furnace", "collect_coal", "collect_iron", "smelt_iron", "craft_iron_pickaxe", "craft_stone_pickaxe")}
IRON = {ix[n] for n in ("iron_ore", "deepslate_iron_ore")}; RAW = ix["raw_iron"]; INGOT = ix["iron_ingot"]
FUEL = {ix[n] for n in items if n in ("coal", "charcoal") or n.endswith("_planks") or n.endswith("_log")}
SM, MI, TU = CMDS.index("smelt"), CMDS.index("mine"), CMDS.index("tunnel")
eps = []
cur = {}
def fin(k):
    if k in cur: eps.append(cur.pop(k))
for d in dirs:
    cur.clear()
    with open(d + "/env_to_policy.jsonl", "rb") as f:
        for raw in f:
            if b'"type":"obs"' not in raw: continue
            r = json.loads(raw); env, ep = r["env_id"], r["episode"]; o = r["obs"]
            k = (env)
            st = cur.get(k)
            if st is None or st["ep"] != ep:
                fin(k)
                st = cur[k] = {"ep": ep, "miny": 1e9, "iron_off": 0, "tun_steps": 0, "raw_steps": 0, "raw_fuel": 0, "raw_smelt": 0, "had_raw": False, "furnace_placed": False, "n": 0, "ingots": 0, "iron_off_tun": 0}
            fl = o["progress"]; st["n"] += 1
            st["miny"] = min(st["miny"], o["self"][17] * 128)
            cc, ci, cm = o["cand_cmd"], o["cand_item"], o["cand_mask"]
            if any(cm[i] and cc[i] == MI and ci[i] in IRON for i in range(64)): st["iron_off"] += 1
            if any(cm[i] and cc[i] == TU for i in range(64)): st["tun_steps"] += 1
            inv = [(a, b) for a, b in zip(o["inv_item"], o["inv_count"]) if a]
            raw_n = sum(b for a, b in inv if a == RAW); ing = sum(b for a, b in inv if a == INGOT)
            st["ingots"] = max(st["ingots"], round(ing * 64))
            if raw_n > 0 and not fl[E["smelt_iron"]]:
                st["had_raw"] = True; st["raw_steps"] += 1
                if any(a in FUEL for a, b in inv): st["raw_fuel"] += 1
                if any(cm[i] and cc[i] == SM for i in range(64)): st["raw_smelt"] += 1
            st["furnace_placed"] = st["furnace_placed"] or bool(fl[E["place_furnace"]])
            st["flags"] = fl
for k in list(cur): fin(k)
n = len(eps); pc = lambda x: x / n
print(f"{run}: {n} episodes")
def row(name, sel):
    s = [e for e in eps if sel(e)]; print(f"  {name:62} {len(s):5d} = {len(s) / n:5.2f}")
row("went below y = 50 (iron appears from about y = 56 down)", lambda e: e["miny"] < 50)
row("went below y = 30", lambda e: e["miny"] < 30)
row("iron ore offered to `mine` at least once", lambda e: e["iron_off"] > 0)
row("collected iron (collect_iron)", lambda e: e["flags"][E["collect_iron"]])
row("... of which held fuel whenever they held raw iron", lambda e: e["flags"][E["collect_iron"]] and e["raw_steps"] and e["raw_fuel"] == e["raw_steps"])
row("... of which a smelt candidate was ever offered while holding raw iron", lambda e: e["flags"][E["collect_iron"]] and e["raw_smelt"] > 0)
row("smelted iron (smelt_iron)", lambda e: e["flags"][E["smelt_iron"]])
row("held 3 or more ingots at some point", lambda e: e["ingots"] >= 3)
row("crafted an iron pickaxe", lambda e: e["flags"][E["craft_iron_pickaxe"]])
ci = [e for e in eps if e["flags"][E["collect_iron"]] and e["raw_steps"]]
if ci:
    print(f"  episodes with raw iron: steps holding raw iron before smelting: mean {sum(e['raw_steps'] for e in ci) / len(ci):.0f}; share of those steps with fuel {sum(e['raw_fuel'] for e in ci) / max(1, sum(e['raw_steps'] for e in ci)):.2f}, with a smelt candidate {sum(e['raw_smelt'] for e in ci) / max(1, sum(e['raw_steps'] for e in ci)):.3f}")
fp = [e for e in eps if e["furnace_placed"]]
print(f"  furnace placed in {len(fp) / n:.2f} of episodes; of those, with a smelt candidate ever (any time raw iron held) {sum(1 for e in fp if e['raw_smelt']) / max(1, sum(1 for e in fp if e['had_raw'])):.2f} of those that held raw iron")
