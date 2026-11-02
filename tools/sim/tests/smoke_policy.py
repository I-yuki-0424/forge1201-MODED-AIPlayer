"""Smoke test for forgeaip-sim: plays the file API as a policy (the DPOD scripted teacher on the progress-list goals, random
otherwise), prints throughput, success rates per command, failure reasons and the progress reached. stdlib + numpy-free teacher import.
  python3 smoke_policy.py <exchange root> <base> <shard> <seconds> <dpod scripts dir> [random]"""
import collections, json, os, random, sys, time
root, base, shard, secs, dpod = sys.argv[1], sys.argv[2], int(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
use_random = len(sys.argv) > 6
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
items, milestones, teacher = None, None, None
ok, tot, reasons, last_cmd = collections.Counter(), collections.Counter(), collections.Counter(), {}
best, eps, steps, rets = {}, 0, 0, collections.defaultdict(float)
random.seed(1)
def send(m):
    global seq
    m.update({"v": 1, "run_id": run, "seq": seq, "t": time.time()}); seq += 1
    with open(rout, "a") as f: f.write(json.dumps(m) + "\n")
t_start = time.time()
buf = b""
while time.time() - t_start < secs:
    with open(rin, "rb") as f:
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
                if r == 0: ok[c] += 1
                else: reasons[(c, r)] += 1
            rets[e] += m["reward"]
            if m["terminated"]:
                eps += 1; best[e] = max(best.get(e, 0), sum(o["progress"][:-2]))
                print(f"episode end env {e}: progress {int(sum(o['progress'][:-2]))}/{len(milestones)} days {o['progress'][-2]*10:.0f} return {rets[e]:.2f}", flush=True); rets[e] = 0
                continue
            a = -1
            if not use_random:
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
