#!/usr/bin/env python3
"""Where does a training run stop making progress, and why? From a run's observation and action files (env_to_policy / policy_to_env of every
shard), per progress-list entry and per third of the run (by position in the file):
  reached   share of episodes that ended with the entry done
  offered   share of episodes in which, before the entry was done, a candidate that would achieve it was offered at least once
  per ep    how many steps per episode such a candidate was on offer (entry not yet done)
  taken     share of those steps in which the policy chose such a candidate;  uniform = the share a uniform choice among the candidates would give
  success   of the chosen ones, the share after which the entry was done on the next observation
Reading: reached low and offered low = the behaviour is never within reach (a prerequisite is missing or the world does not offer it); offered
but taken << uniform = the policy avoids it; taken ~ uniform with success low = the command fails; offered, taken, success high but reached
low = something else (e.g. later episodes lose the progress).   usage: entries.py <exchange root> <run base> [max episodes per file]"""
import glob, json, os, sys, collections
root, run = sys.argv[1], sys.argv[2]
CMDS = ["pad", "move_to", "mine", "attack", "pickup", "craft", "smelt", "place", "activate", "equip", "eat", "wait", "tunnel"]
dirs = sorted(glob.glob(f"{root}/{run}-s*-sim*"))
hello = None
for l in open(dirs[0] + "/env_to_policy.jsonl"):
    r = json.loads(l)
    if r.get("type") == "hello": hello = r; break
items = hello["vocab"]["items"]; ix = {n: i for i, n in enumerate(items)}
ids = hello["milestones"]; NE = len(ids)
ID = lambda names: {ix[n] for n in names if n in ix}
LOGS = [n for n in items if n.endswith("_log") and "stripped" not in n]
PLANKS = [n for n in items if n.endswith("_planks")]
BEDS = [n for n in items if n.endswith("_bed")]
WOOD_PICK = ["wooden_pickaxe"]
# entry -> (command, item names that make a candidate achieve it); mining entries name the BLOCK (the candidate's item is the block mined)
P = {"collect_wood": ("mine", LOGS), "craft_planks": ("craft", PLANKS), "craft_crafting_table": ("craft", ["crafting_table"]), "place_crafting_table": ("place", ["crafting_table"]),
     "craft_stick": ("craft", ["stick"]), "craft_wooden_pickaxe": ("craft", ["wooden_pickaxe"]), "craft_wooden_sword": ("craft", ["wooden_sword"]),
     "collect_stone": ("mine", ["stone"]), "craft_stone_pickaxe": ("craft", ["stone_pickaxe"]), "craft_stone_sword": ("craft", ["stone_sword"]), "craft_furnace": ("craft", ["furnace"]),
     "place_furnace": ("place", ["furnace"]), "eat_food": ("eat", None), "collect_coal": ("mine", ["coal_ore", "deepslate_coal_ore"]), "craft_torch": ("craft", ["torch"]),
     "defeat_hostile": ("attack", None), "collect_iron": ("mine", ["iron_ore", "deepslate_iron_ore"]), "smelt_iron": ("smelt", ["raw_iron", "iron_ore"]),
     "craft_iron_pickaxe": ("craft", ["iron_pickaxe"]), "craft_iron_sword": ("craft", ["iron_sword"]), "craft_bed": ("craft", BEDS), "sleep_in_bed": ("activate", BEDS),
     "collect_diamond": ("mine", ["diamond_ore", "deepslate_diamond_ore"]), "craft_diamond_pickaxe": ("craft", ["diamond_pickaxe"])}
pred = [(CMDS.index(P[e][0]), None if P[e][1] is None else ID(P[e][1])) for e in ids]
B = 3
reached = [[0] * NE for _ in range(B)]; eps = [0] * B
offered_eps = [[0] * NE for _ in range(B)]; offered = [[0] * NE for _ in range(B)]; taken = [[0] * NE for _ in range(B)]; uni = [[0.0] * NE for _ in range(B)]
succ = [[0] * NE for _ in range(B)]; tried = [[0] * NE for _ in range(B)]; nsteps = [0] * B
for d in dirs:
    acts = {}
    for l in open(d + "/policy_to_env.jsonl"):
        if '"type":"act"' not in l: continue
        r = json.loads(l); acts[(r["env_id"], r["episode"], r["step"])] = r["action"]["candidate"]
    size = os.path.getsize(d + "/env_to_policy.jsonl"); pos = 0
    ep_state = {}                                   # env -> [episode, last flags, offered set]
    pend = {}                                       # env -> (episode, step, entries chosen)
    def close(env, st, b):
        eps[b] += 1
        for e in range(NE):
            if st[1][e]: reached[b][e] += 1
            if e in st[2]: offered_eps[b][e] += 1
    with open(d + "/env_to_policy.jsonl", "rb") as f:
        for raw in f:
            pos += len(raw)
            if b'"type":"obs"' not in raw: continue
            r = json.loads(raw); env, ep, step = r["env_id"], r["episode"], r["step"]; o = r["obs"]
            b = min(B - 1, int(B * pos / size)); fl = o["progress"][:NE]
            st = ep_state.get(env)
            if st is None or st[0] != ep:
                if st is not None: close(env, st, st[3])
                st = ep_state[env] = [ep, fl, set(), b]
            st[1] = fl; st[3] = b
            if env in pend and pend[env][0] == ep and pend[env][1] == step - 1:
                for e in pend[env][2]:
                    tried[b][e] += 1; succ[b][e] += 1 if fl[e] else 0
            pend.pop(env, None)
            if r.get("terminated"): continue
            cc, ci, cm = o["cand_cmd"], o["cand_item"], o["cand_mask"]
            n = sum(1 for m in cm if m); nsteps[b] += 1
            a = acts.get((env, ep, step)); chosen = []
            for e in range(NE):
                if fl[e]: continue
                cmd, its = pred[e]
                m = [k for k in range(64) if cm[k] and cc[k] == cmd and (its is None or ci[k] in its)]
                if not m: continue
                offered[b][e] += 1; uni[b][e] += len(m) / n; st[2].add(e)
                if a in m: taken[b][e] += 1; chosen.append(e)
            if chosen: pend[env] = (ep, step, chosen)
    for env, st in ep_state.items(): close(env, st, st[3])
out = {"run": run, "entries": ids, "episodes": eps, "reached": reached, "offered_eps": offered_eps, "offered": offered, "taken": taken, "uniform": uni, "success": succ, "tried": tried}
json.dump(out, open(f"{root}/entries_{run}.json", "w"))
print(f"run {run}: episodes per third {eps}, steps per third {nsteps}")
print(f"{'entry':24} | {'reached':>22} | {'offered (eps)':>22} | {'offered steps/ep':>8} | {'taken last third':>16} {'uniform':>8} | {'success':>8}")
pc = lambda a, b: (a / b if b else float('nan'))
for e, name in enumerate(ids):
    rr = " ".join(f"{pc(reached[b][e], eps[b]):5.2f}" for b in range(B)); oo = " ".join(f"{pc(offered_eps[b][e], eps[b]):5.2f}" for b in range(B))
    b = B - 1
    print(f"{name:24} | {rr:>22} | {oo:>22} | {pc(offered[b][e], eps[b]):8.1f} | {pc(taken[b][e], offered[b][e]):16.3f} {pc(uni[b][e], offered[b][e]):8.3f} | {pc(succ[b][e], tried[b][e]):8.2f}")
