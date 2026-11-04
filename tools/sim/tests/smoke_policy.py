"""Smoke test for forgeaip-sim: plays the file API as a policy (the DPOD scripted teacher on the progress-list goals, random
otherwise), prints throughput, success rates per command, failure reasons and the progress reached. stdlib + numpy-free teacher import.
  python3 smoke_policy.py <exchange root> <base> <shard> <seconds> <dpod scripts dir> [random|teacher|iron|iron-ap] [steps.jsonl]
Mode `iron` is the positive control of the iron scenarios (SCENARIO-v1): a scripted solver that sees only what the policy sees (inventory and the offered
candidates) and plays mine iron -> furnace (placed or built) -> smelt -> table -> iron pickaxe.
With a steps.jsonl path every step is logged (command, outcome reason, ticks, reward, progress, clock): the same measurement
for the simulator and for the real Forge environment (tools/sim/compare.py reads it)."""
import collections, json, os, random, sys, time
root, base, shard, secs, dpod = sys.argv[1], sys.argv[2], int(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
mode = sys.argv[6] if len(sys.argv) > 6 else "teacher"; use_random = mode == "random"
logpath = sys.argv[7] if len(sys.argv) > 7 else None
log = open(logpath, "a") if logpath else None
REASONS = ["ok", "invalid_args", "invalid_target", "missing_item", "missing_tool", "missing_materials", "no_station", "unreachable", "stuck", "not_visible", "not_confirmed", "target_lost", "timeout", "died", "disconnected", "cancelled", "internal"]
last_args = {}
sys.path.insert(0, dpod)
import botsystem_teacher as bt
cur = f"{root}/{base}.s{shard}.current"
t0 = time.time()
while not os.path.exists(cur):
    if time.time() - t0 > 60: sys.exit("no run started")
    time.sleep(0.1)
run = open(cur).read().strip()
rin, rout = f"{root}/{run}/env_to_policy.jsonl", f"{root}/{run}/policy_to_env.jsonl"
open(rout, "a").close()
pos, seq = 0, 0
checked = 0.0
items, milestones, teacher = None, None, None
ok, tot, reasons, last_cmd = collections.Counter(), collections.Counter(), collections.Counter(), {}
best, eps, steps, rets = {}, 0, 0, collections.defaultdict(float)
random.seed(1)
def iron_choice(t, o, ap=False):
    """Next candidate of the scripted iron solver, or -1 (no opinion: the caller picks one at random, which moves around)."""
    inv, cs = t.inventory(o), t.cands(o)
    first = lambda cmd, item: next((c[0] for c in sorted(cs, key=lambda c: float(c[3][3])) if c[1] == cmd and c[2] == item), -1)
    raw, ing = inv.get("raw_iron", 0), inv.get("iron_ingot", 0)
    if inv.get("iron_pickaxe", 0): return -1
    if ing >= 3 and inv.get("stick", 0) >= 2:
        for a in (first("craft", "iron_pickaxe"), first("place", "crafting_table")):
            if a >= 0: return a
    if raw > 0:
        for a in (first("smelt", "raw_iron"), first("place", "furnace"), first("craft", "furnace"), first("place", "crafting_table")):
            if a >= 0: return a
    if raw + ing < 3:
        a = first("mine", "iron_ore")
        if a < 0 and ap: a = first("move_to", "iron_ore")      # mode iron-ap: walk to the ore that is seen but beyond mining range (approach candidates, 2026-11-05)
        return a
    return -1
def send(m):
    global seq
    m.update({"v": 1, "run_id": run, "seq": seq, "t": time.time()}); seq += 1
    with open(rout, "a") as f: f.write(json.dumps(m) + "\n")
t_start = time.time()
buf = b""
while time.time() - t_start < secs:
    if time.time() - checked > 1.0:      # the environment restarted: follow its new run
        checked = time.time()
        now_run = open(cur).read().strip()
        if now_run != run:
            run = now_run; rin, rout = f"{root}/{run}/env_to_policy.jsonl", f"{root}/{run}/policy_to_env.jsonl"
            open(rout, "a").close(); pos, buf = 0, b""; last_cmd.clear()
    try:
        f = open(rin, "rb")
    except FileNotFoundError:
        time.sleep(0.05); continue
    with f:
        f.seek(pos); data = f.read()
    if not data: time.sleep(0.002); continue
    buf += data; pos += len(data)
    if b"\n" not in buf: continue
    lines, buf = buf.rsplit(b"\n", 1)[0].split(b"\n"), buf.rsplit(b"\n", 1)[1]
    for ln in lines:
        m = json.loads(ln)
        if m["type"] == "hello":
            items, milestones = m["vocab"]["items"], m["milestones"]; teacher = bt.Teacher(items)
            send({"type": "hello_ack", "env_id": m["env_id"], "accepted": True})
        elif m["type"] == "obs":
            o, e = m["obs"], m["env_id"]
            if e in last_cmd and m["step"] > 0:
                c = last_cmd.pop(e); tot[c] += 1; r = o["last_reason"]
                if log:
                    log.write(json.dumps({"env": e, "ep": m["episode"], "step": m["step"], "cmd": c, "reason": REASONS[r], "ticks": o["dt_ticks"], "reward": m["reward"], "terms": m.get("reward_terms"),
                                          "n_prog": int(sum(o["progress"][:-2])), "clock": o["clock"][0], "t": time.time()}) + "\n"); log.flush()
                if r == 0: ok[c] += 1
                else: reasons[(c, r)] += 1
            rets[e] += m["reward"]
            if m["terminated"]:
                eps += 1; best[e] = max(best.get(e, 0), sum(o["progress"][:-2]))
                print(f"episode end env {e}: progress {int(sum(o['progress'][:-2]))}/{len(milestones)} days {o['progress'][-2]*10:.0f} return {rets[e]:.2f}", flush=True); rets[e] = 0
                continue
            a = -1
            if mode in ("iron", "iron-ap"): a = iron_choice(teacher, o, mode == "iron-ap")
            elif not use_random:
                for i, p in enumerate(o["progress"][:-2]):
                    if p == 0 and milestones[i] in bt.GOALS: a = teacher.choose(o, milestones[i]); break
            if a < 0:
                idx = [i for i, mk in enumerate(o["cand_mask"]) if mk]; a = random.choice(idx)
            last_cmd[e] = bt.CMDS[o["cand_cmd"][a]]
            steps += 1
            send({"type": "act", "env_id": e, "episode": m["episode"], "step": m["step"], "action": {"candidate": a}})
el = time.time() - t_start
print(f"steps {steps} in {el:.1f}s = {steps/el:.0f}/s, episodes ended {eps}")
print("per command ok/total:", {c: f"{ok[c]}/{tot[c]}" for c in tot})
print("failures:", dict(collections.Counter({f"{c}:{r}": n for (c, r), n in reasons.items()}).most_common(10)))
print("best progress per bot:", best)
