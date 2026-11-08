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
    t.add_argument("--lr", type=float, default=5e-4); t.add_argument("--ent", type=float, default=0.01); t.add_argument("--min-steps", type=int, default=30_000)
    e = sub.add_parser("eval")
    e.add_argument("--expert", required=True); e.add_argument("--root", required=True); e.add_argument("--base", required=True); e.add_argument("--shards", required=True)
    e.add_argument("--policy", required=True, help="random | solver | net:<checkpoint.npz>"); e.add_argument("--episodes", type=int, default=200)
    e.add_argument("--seed", type=int, default=0); e.add_argument("--out"); e.add_argument("--timeout", type=int, default=900)
    a = ap.parse_args(argv)
    if a.cmd == "gen":
        for p in catalog.write_all(a.out):
            print(p)
        return 0
    cat = catalog.load()
    expert = catalog.experts(cat)[a.expert]
    vec = _vec(a)
    if a.cmd == "train":
        from . import train
        res = train.train(vec, expert, a.out, budget=a.budget, seed=a.seed, lr=a.lr, ent=a.ent, min_steps=a.min_steps, done_file=f"{a.root}/{a.base}.done")
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
        pol = solvers.Solver(a.expert, feat, a.seed)
    elif a.policy.startswith("net:"):
        pol = NetPolicy(a.policy[4:], feat)
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


class NetPolicy:
    """Greedy policy of a trained expert (checkpoint of moe.policy.save)."""
    def __init__(self, path, feat):
        from . import policy
        self.params, self.meta = policy.load(path)
        self.feat = feat

    def decide(self, obs_list):
        import numpy as np
        from . import policy
        ctx = np.stack([self.feat.ctx(o.raw) for o in obs_list])
        cc = [self.feat.cands(o.raw) for o in obs_list]
        cand, mask = policy.trim(np.stack([c[0] for c in cc]), np.stack([c[1] for c in cc]))
        a, _ = policy.act_greedy(self.params, ctx, cand, mask)
        return [int(x) for x in a]


if __name__ == "__main__":
    sys.exit(main())
