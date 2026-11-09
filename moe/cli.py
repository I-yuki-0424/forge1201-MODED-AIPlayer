"""python -m moe.cli gen|train|eval ... (run by scripts/moe/*.sh inside the moe-venv container; the simulator shards run beside it)."""
import argparse
import json
import pathlib
import sys

from . import catalog


def _vec(a):
    from .vec import Vec
    return Vec(a.root, a.base, [int(x) for x in a.shards.split(",")])


def main(argv=None):
    ap = argparse.ArgumentParser(prog="moe")
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("gen"); g.add_argument("--out", required=True)
    t = sub.add_parser("train")
    t.add_argument("--expert", required=True); t.add_argument("--root", required=True); t.add_argument("--base", required=True); t.add_argument("--shards", required=True)
    t.add_argument("--out", required=True); t.add_argument("--budget", type=int, default=300_000); t.add_argument("--seed", type=int, default=0)
    t.add_argument("--lr", type=float, default=5e-4); t.add_argument("--ent", type=float, default=0.01); t.add_argument("--min-steps", type=int, default=30_000); t.add_argument("--stop-rate", type=float, default=0.97)
    e = sub.add_parser("eval")
    e.add_argument("--expert", required=True); e.add_argument("--root", required=True); e.add_argument("--base", required=True); e.add_argument("--shards", required=True)
    e.add_argument("--policy", required=True, help="random | solver | net:<checkpoint.npz>"); e.add_argument("--episodes", type=int, default=200)
    e.add_argument("--seed", type=int, default=0); e.add_argument("--out"); e.add_argument("--timeout", type=int, default=900)
    r = sub.add_parser("router")
    r.add_argument("--out", required=True); r.add_argument("--n-train", type=int, default=30000); r.add_argument("--n-test", type=int, default=8000); r.add_argument("--seed", type=int, default=0)
    c = sub.add_parser("chain")
    c.add_argument("--root", required=True); c.add_argument("--base", required=True); c.add_argument("--shards", required=True)
    c.add_argument("--router", required=True, help="rules | xgb:<model> | lgb:<model>"); c.add_argument("--experts", required=True, help="net:<runs dir> | solver")
    c.add_argument("--episodes", type=int, default=60); c.add_argument("--trace", type=int, default=0, help="print the expert switches of the first N episodes"); c.add_argument("--scenario", default="chain"); c.add_argument("--out"); c.add_argument("--timeout", type=int, default=1500)
    c.add_argument("--greedy-stall", action="store_true", help="control: the first chain's behaviour, a stalled expert is called again with the greedy action")
    a = ap.parse_args(argv)
    if a.cmd == "router":
        return _router(a)
    if a.cmd == "chain":
        return _chain(a)
    if a.cmd == "gen":
        for p in catalog.write_all(a.out):
            print(p)
        return 0
    cat = catalog.load()
    expert = catalog.experts(cat)[a.expert]
    vec = _vec(a)
    if a.cmd == "train":
        from . import train
        res = train.train(vec, expert, a.out, budget=a.budget, seed=a.seed, lr=a.lr, ent=a.ent, min_steps=a.min_steps, stop_rate=a.stop_rate, done_file=f"{a.root}/{a.base}.done")
        print(json.dumps(res))
        return 0
    from . import evaluate, solvers
    from .features import Featurizer
    import time
    t0 = time.time()
    while vec.vocab() is None:
        vec.poll(); time.sleep(0.05)
        if time.time() - t0 > 120:
            print("no hello", file=sys.stderr); return 1
    feat = Featurizer(vec.vocab(), cat["items"])
    if a.policy == "random":
        pol = solvers.Random(a.seed)
    elif a.policy == "solver":
        pol = solvers.Solver(a.expert, feat, a.seed, rel=catalog.relevance(expert))
    elif a.policy.startswith("net:"):
        pol = NetPolicy(a.policy[4:], feat, catalog.relevance(expert), expert.get("kind", "item") == "skill")
    else:
        print("unknown policy", file=sys.stderr); return 2
    s = evaluate.run(vec, pol.decide, a.episodes, a.timeout)
    s.update(expert=a.expert, policy=a.policy.split(":")[0])
    print(json.dumps(s))
    if a.out:
        with open(a.out, "a") as f:
            f.write(json.dumps(s) + "\n")
    pathlib.Path(f"{a.root}/{a.base}.done").write_text("eval")
    return 0


def _router(a):
    import os
    import numpy as np
    from . import router as R, rules
    cat = catalog.load()
    rl = rules.Rules(cat)
    train = R.sample(cat, rl, np.random.default_rng(a.seed + 1), a.n_train)
    test = R.sample(cat, rl, np.random.default_rng(a.seed + 2), a.n_test)
    os.makedirs(a.out, exist_ok=True)
    res = {}
    for kind in ("xgb", "lgb"):
        t0 = __import__("time").time()
        try:
            r = R.GBRouter(cat, kind).fit(train)
        except (ImportError, OSError) as e:             # the PC's WSL has no libgomp for LightGBM and no root to install it
            print(json.dumps({kind: f"skipped: {type(e).__name__}: {str(e)[:80]}"}))
            continue
        fit_s = __import__("time").time() - t0
        path = f"{a.out}/router.{kind}"
        r.save(path)
        ev = R.evaluate(r, test)
        ev.update(fit_seconds=round(fit_s, 1), model_bytes=os.path.getsize(path), n_train=a.n_train)
        res[kind] = ev
        print(json.dumps({kind: ev}))
    pathlib.Path(f"{a.out}/router.json").write_text(json.dumps(res, indent=1))
    return 0


def _chain(a):
    import time
    from . import chain as C, policy, rules, router as R
    from .features import Featurizer
    from . import evaluate
    cat = catalog.load()
    vec = _vec(a)
    t0 = time.time()
    while vec.vocab() is None:
        vec.poll(); time.sleep(0.05)
        if time.time() - t0 > 120:
            print("no hello", file=sys.stderr); return 1
    feat = Featurizer(vec.vocab(), cat["items"])
    if a.router == "rules":
        route = rules.Rules(cat).route
    else:
        kind, path = a.router.split(":", 1)
        gb = R.GBRouter.load(path, cat)
        route = gb.route
    experts, src = {}, "solver"
    if a.experts.startswith("net:"):
        src = "net"
        for e in cat["experts"]:
            experts[e["id"]], _ = policy.load(f"{a.experts[4:]}/{e['id']}/final.npz")
    ch = C.Chain(feat, cat, route, experts, cat["chain"]["goal"], 1, src, sample_on_stall=not a.greedy_stall)
    reached = {e["id"]: 0 for e in cat["experts"]}
    traced = [0]
    def on_ep(ob):
        for eid in set(ch.completed.get(ob.key, [])):
            reached[eid] += 1
        if traced[0] < a.trace:
            traced[0] += 1
            print(json.dumps({"episode_end": ob.outcome, "commands": ob.step, "trace": ch.trace.get(ob.key, [])[:40]}))
    s = evaluate.run(vec, ch.decide, a.episodes, a.timeout, on_episode=on_ep)
    s.update(router=a.router.split(":")[0], experts=src, scenario=a.scenario, expert_goal_reached=reached, router_calls=ch.calls, unstick_calls=ch.unstick_calls, greedy_stall=a.greedy_stall)
    print(json.dumps(s))
    if a.out:
        with open(a.out, "a") as f:
            f.write(json.dumps(s) + "\n")
    pathlib.Path(f"{a.root}/{a.base}.done").write_text("chain")
    return 0


class NetPolicy:
    """Greedy policy of a trained expert (checkpoint of moe.policy.save)."""
    def __init__(self, path, feat, rel=(), anon=False):
        from . import policy
        self.params, self.meta = policy.load(path)
        self.feat = feat
        self.rel = rel
        self.anon = anon

    def decide(self, obs_list):
        import numpy as np
        from . import policy
        ctx = np.stack([self.feat.ctx(o.raw, self.rel, self.anon) for o in obs_list])
        cc = [self.feat.cands(o.raw, self.rel, self.anon) for o in obs_list]
        cand, mask = policy.trim(np.stack([c[0] for c in cc]), np.stack([c[1] for c in cc]))
        a, _ = policy.act_greedy(self.params, ctx, cand, mask)
        return [int(x) for x in a]


if __name__ == "__main__":
    sys.exit(main())
