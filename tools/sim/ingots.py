#!/usr/bin/env python3
"""The last link: steps on which the bot holds 3 or more iron ingots (what an iron pickaxe needs, with 2 sticks and a crafting table in reach):
how many episodes and steps, whether it holds 2 sticks, whether any `craft` candidate that needs the table is on offer (cand_cmd craft with a
station), what it does next.   ingots.py <root> <run base>"""
import glob, json, sys, collections
root, run = sys.argv[1], sys.argv[2]
for l in open(glob.glob(f"{root}/{run}-s*-sim*")[0] + "/env_to_policy.jsonl"):
    r = json.loads(l)
    if r.get("type") == "hello": hello = r; break
items = hello["vocab"]["items"]; ix = {n: i for i, n in enumerate(items)}
ING, STK, TAB, PICK = ix["iron_ingot"], ix["stick"], ix["crafting_table"], ix["iron_pickaxe"]
CMDS = ["pad", "move_to", "mine", "attack", "pickup", "craft", "smelt", "place", "activate", "equip", "eat", "wait", "tunnel"]
steps = sticks = table_craft = 0; eps = set(); eps_sticks = set(); acts = collections.Counter(); first_ing = {}; after = collections.Counter()
for d in sorted(glob.glob(f"{root}/{run}-s*-sim*")):
    pol = {}
    for l in open(d + "/policy_to_env.jsonl"):
        if '"type":"act"' in l:
            r = json.loads(l); pol[(r["env_id"], r["episode"], r["step"])] = r["action"]["candidate"]
    with open(d + "/env_to_policy.jsonl", "rb") as f:
        for raw in f:
            if b'"type":"obs"' not in raw: continue
            r = json.loads(raw); o = r["obs"]
            ing = sum(c for i, c in zip(o["inv_item"], o["inv_count"]) if i == ING) * 64
            if round(ing) < 3: continue
            k = (d, r["env_id"], r["episode"]); steps += 1; eps.add(k)
            stk = round(sum(c for i, c in zip(o["inv_item"], o["inv_count"]) if i == STK) * 64)
            if stk >= 2: sticks += 1; eps_sticks.add(k)
            cm, cc, ci = o["cand_mask"], o["cand_cmd"], o["cand_item"]
            crafts = [ix2 for ix2 in range(64) if cm[ix2] and cc[ix2] == CMDS.index("craft")]
            if any(ci[j] == PICK for j in crafts): table_craft += 1
            a = pol.get((r["env_id"], r["episode"], r["step"]))
            if a is not None and cm[a]: acts[CMDS[cc[a]]] += 1
print(f"{run}: {len(eps)} episodes held >= 3 ingots ({steps} steps); {len(eps_sticks)} of them also held >= 2 sticks ({sticks} steps); an iron-pickaxe craft candidate was on offer on {table_craft} steps")
print("   what the policy did on those steps:", dict(acts.most_common(8)))
