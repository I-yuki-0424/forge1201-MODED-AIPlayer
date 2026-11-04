#!/usr/bin/env python3
"""Outcome of scenario runs (tools/sim/scenarios, docs/proposed/SCENARIO-v1.md), from the shards' events.jsonl files only.
  scn_report.py <exchange root> <base> [<base> ...] [--entries a,b,c] [--blocks 5]
Per base: episodes; per paid entry the share of episodes that reached it (Wilson 95 %), the median step of the first time, and the share
by block of the run (--blocks equal parts of each shard's episodes, in order: a learning curve); how the furnace was used (walked to the
placed one / built one / none) among the episodes that smelted; the most frequent failures of the commands of the chain.
Entries default to the ones the scenario pays (collect_iron, smelt_iron, craft_iron_pickaxe, craft_iron_sword)."""
import collections, glob, json, math, sys

def wilson(k, n, z=1.96):
    if n == 0: return (0.0, 0.0)
    p = k / n; d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d; h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))

def episodes(root, base):
    """Yield per shard the list of episode dicts {scn, ent: {id: step}, steps, deaths, route, fails}."""
    for d in sorted(glob.glob(f"{root}/{base}-s*-sim*")):
        try: f = open(d + "/events.jsonl")
        except OSError: continue
        cur, out, fails = {}, [], collections.Counter()
        with f:
            for line in f:
                try: r = json.loads(line)
                except ValueError: continue
                ev, env = r.get("event"), r.get("env_id")
                if ev == "scenario":
                    fur = [tuple(c) for c in r["place"].get("furnace", {}).get("cells", [])]
                    cur[env] = {"scn": r["scenario"], "furnace": fur, "own": [], "route": None, "start": r["start"]}
                elif ev == "step":
                    e = cur.setdefault(env, {"scn": None, "furnace": [], "own": [], "route": None, "start": None})
                    cmd, ok, pos = r.get("cmd"), r.get("reason") == "ok", r.get("pos")
                    if not ok: fails[(cmd, r.get("reason"))] += 1
                    a = r.get("args") or {}
                    if cmd == "place" and ok and a.get("item") == "furnace": e["own"].append((a["x"], a["y"], a["z"]))
                    if cmd == "smelt" and ok and e["route"] is None and pos:
                        near = lambda cs: any(max(abs(c[0] - pos[0]), abs(c[2] - pos[2])) <= 6 for c in cs)
                        e["route"] = "scenario" if near(e["furnace"]) else "own" if near(e["own"]) else "other"
                    if cmd == "craft" and ok and "item" in a: e.setdefault("crafts", collections.Counter())[a["item"]] += 1
                    if cmd == "smelt" and ok: e["smelts"] = e.get("smelts", 0) + 1
                elif ev == "episode_end":
                    e = cur.pop(env, {"scn": None, "route": None})
                    out.append({"scn": e.get("scn"), "ent": r.get("reached", {}), "steps": r.get("steps", 0), "deaths": r.get("deaths", 0), "route": e.get("route"), "crafts": e.get("crafts", {}), "smelts": e.get("smelts", 0), "inv": r.get("inv", {})})
        yield out, fails

def main():
    a = sys.argv[1:]
    ents, blocks = ["collect_iron", "smelt_iron", "craft_iron_pickaxe", "craft_iron_sword"], 5
    for flag in ("--entries", "--blocks"):
        if flag in a:
            i = a.index(flag); v = a[i + 1]; del a[i:i + 2]
            if flag == "--entries": ents = v.split(",")
            else: blocks = int(v)
    root, bases = a[0], a[1:]
    for base in bases:
        shards, fails = [], collections.Counter()
        for eps, f in episodes(root, base):
            shards.append(eps); fails.update(f)
        allx = [e for s in shards for e in s]
        n = len(allx)
        print(f"== {base}: {n} episodes in {len(shards)} shards" + (f", scenario {allx[0]['scn']}" if n and allx[0]['scn'] else ""))
        if not n: continue
        print(f"   steps/episode {sum(e['steps'] for e in allx) / n:.0f}, deaths/episode {sum(e['deaths'] for e in allx) / n:.2f}")
        for en in ents:
            k = sum(1 for e in allx if en in e["ent"]); lo, hi = wilson(k, n)
            st = sorted(e["ent"][en] for e in allx if en in e["ent"])
            curve = []
            for b in range(blocks):
                sub = [e for s in shards for e in s[len(s) * b // blocks: len(s) * (b + 1) // blocks]]
                curve.append(f"{sum(1 for e in sub if en in e['ent']) / max(1, len(sub)):.2f}")
            print(f"   {en:20s} {k:5d}/{n}  {k / n:5.1%}  [{lo:.1%}, {hi:.1%}]  median step {st[len(st) // 2] if st else '-':>5}   by block: {' '.join(curve)}")
        rt = collections.Counter(e["route"] for e in allx if "smelt_iron" in e["ent"])
        if rt: print("   furnace of the first smelt (scenario = the one placed for the bot, own = placed by the bot, kit or crafted): " + ", ".join(f"{k or 'unknown'} {v}" for k, v in rt.most_common()))
        # where the iron goes: among the episodes that smelted, the successful smelts, the ingots left at the end, and what was crafted
        sm = [e for e in allx if "smelt_iron" in e["ent"]]
        if sm:
            ing = collections.Counter(min(int(e["inv"].get("iron_ingot", 0)), 3) for e in sm)
            cr = collections.Counter()
            for e in sm: cr.update(e["crafts"])
            print(f"   of the {len(sm)} episodes that smelted: successful smelts per episode {sum(e['smelts'] for e in sm) / len(sm):.1f}; "
                  f"ingots held at the end 0/1/2/3+: {ing[0]}/{ing[1]}/{ing[2]}/{ing[3]}; with 3+ ingots at some point (reached the pickaxe, or smelts >= 3): {sum(1 for e in sm if e['smelts'] >= 3)}")
            print("   crafted in those episodes: " + ", ".join(f"{k} {v}" for k, v in cr.most_common(8)))
            sinks = collections.Counter({k: v for k, v in cr.items() if k.startswith("iron_") or k in ("bucket", "shears", "rail", "iron_nugget", "hopper", "cauldron", "minecart", "anvil", "shield", "compass", "chain")})
            if sinks: print("   crafts that consume iron: " + ", ".join(f"{k} {v}" for k, v in sinks.most_common()))
        chain = ("mine", "smelt", "craft", "place", "move_to", "tunnel")
        top = [(k, v) for k, v in fails.most_common() if k[0] in chain][:6]
        print("   most frequent failures: " + ", ".join(f"{c}:{r} {v}" for (c, r), v in top))

if __name__ == "__main__":
    main()
