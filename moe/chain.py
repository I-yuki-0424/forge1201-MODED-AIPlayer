"""The whole system as one policy: the router picks an expert (and the scan groups it may see) from the pack, the goal and what lies around, the expert plays until
its own goal is held or its step budget is spent, then the router is asked again. Experts are trained networks (`net`) or the scripted solvers (`solver`, to
separate router errors from expert errors).

MOE-v2 changes (docs/proposed/MOE-v2.md): the router gets the scan distances and the number of `stalls` (calls of one expert that changed neither the pack nor the
distance to its target); a stalled expert is not called again unchanged: its next call samples from the policy instead of the greedy action (the greedy policy
of the first chain repeated the identical failure up to six times, 6 x 150 = the whole budget), and after STALLS calls the stuck-escape expert is called.
"""
import numpy as np

from . import features as F
from . import policy, solvers
from .rules import DONE

SKY_NEAR = 2.5          # blocks from the surface cell at which `unstick` has done its job
ARRIVED = 4.0           # blocks from the target at which `move` has done its job (the ore expert takes over within its own reach)


def dist_info(o):
    """{group: blocks to its nearest cell or None} from an observation's scan (log, coal, iron, way, sky)."""
    sc = o.get("scan")
    if sc is None:
        return {}
    sc = np.asarray(sc, dtype=np.float32).reshape(F.NG, F.M, 5)
    return {g: (float(sc[i, 0, 3]) * 64.0 if sc[i, 0, 4] > 0 else None) for i, g in enumerate(F.GROUPS)}


class Chain:
    def __init__(self, feat, cat, route, experts, goal="iron_pickaxe", amount=1, source="net", sample_on_stall=True, seed=0):
        """route(goal, amount, named inventory, info) -> (expert id | DONE, groups);  experts: {id: params} for source 'net'."""
        self.feat, self.cat, self.route, self.goal, self.amount, self.source = feat, cat, route, goal, amount, source
        self.by_id = {e["id"]: e for e in cat["experts"]}
        self.params = experts
        self.solvers = {}
        self.sample_on_stall = sample_on_stall
        self.state = {}
        self.completed = {}
        self.trace = {}          # env key -> [(step, expert id, pack summary, stalls)] : every switch, for diagnosis
        self.calls = 0
        self.unstick_calls = 0
        self.key = __import__("jax").random.PRNGKey(seed) if source == "net" else None
        self.rng = np.random.default_rng(seed)

    def _solver(self, eid, rel):
        k = (eid, rel)
        if k not in self.solvers:
            self.solvers[k] = solvers.Solver(eid, self.feat, rel=rel)
        return self.solvers[k]

    def _reached(self, st, o, inv):
        e = self.by_id[st["e"]]
        if e.get("kind", "item") == "skill":
            d = dist_info(o)
            if e["id"] == "unstick":
                x = d.get("sky")
                return x is not None and x <= SKY_NEAR
            ds = [d.get(F.GROUPS[g]) for g in st["rel"]]
            ds = [x for x in ds if x is not None]
            return bool(ds) and min(ds) <= ARRIVED
        return all(inv.get(k, 0) >= v for k, v in e["goal"].get("have", {}).items())

    def _progress_sig(self, o, inv, rel):
        d = dist_info(o)
        ds = [d.get(F.GROUPS[g]) for g in rel]
        ds = [x for x in ds if x is not None]
        return (tuple(sorted((k, v) for k, v in inv.items() if v and k in self.cat["items"] and k not in ("dirt", "gravel", "apple", "oak_sapling"))), min(ds) if ds else None)

    def _pick(self, ob):
        st = self.state.get(ob.key)
        if st is None or ob.step == 0:
            st = self.state[ob.key] = {"e": None, "since": 0, "rel": (), "stalls": 0, "sample": False, "sig": None}
            self.completed[ob.key] = []
            self.trace[ob.key] = []
        inv = self.feat.named_inventory(ob.raw)
        if st["e"] is not None:
            e = self.by_id[st["e"]]
            done = self._reached(st, ob.raw, inv)
            if done or ob.step - st["since"] >= e["max_steps"]:
                if done and e["id"] not in self.completed[ob.key]:
                    self.completed[ob.key].append(e["id"])
                a, b = st["sig"], self._progress_sig(ob.raw, inv, st["rel"])
                gained = a is None or a[0] != b[0] or (a[1] is not None and b[1] is not None and b[1] < a[1] - 3.0)
                if done and ob.step - st["since"] > 0:
                    st["stalls"] = 0
                elif not gained or (done and e["id"] == "unstick"):
                    st["stalls"] += 1
                if e["id"] == "unstick":
                    st["stalls"] = 1 if self.sample_on_stall else 0         # one more failure and the router sends it back down
                st["sample"] = self.sample_on_stall and st["stalls"] >= 1
                st["e"] = None
        if st["e"] is None:
            self.calls += 1
            info = {"dist": dist_info(ob.raw), "stalls": st["stalls"]}
            nxt, rel = self.route(self.goal, self.amount, inv, info)
            st["e"], st["since"], st["rel"] = (None, ob.step, ()) if nxt == DONE else (nxt, ob.step, tuple(rel))
            st["sig"] = self._progress_sig(ob.raw, inv, st["rel"]) if nxt != DONE else None
            if nxt == "unstick":
                self.unstick_calls += 1
            self.trace[ob.key].append((ob.step, nxt, {k: v for k, v in inv.items() if v and k in self.cat["items"] and k not in ("dirt", "gravel", "apple", "oak_sapling")}, st["stalls"]))
        return st["e"], st["rel"], st["sample"]

    def decide(self, obs_list):
        picks = [self._pick(ob) for ob in obs_list]
        out = [0] * len(obs_list)
        rnd = solvers.Random(len(obs_list))
        for eid, rel, sample in set(picks):
            idx = [i for i, p in enumerate(picks) if p == (eid, rel, sample)]
            sub = [obs_list[i] for i in idx]
            if eid is None:
                acts = rnd.decide(sub)
            elif self.source == "solver":
                acts = self._solver(eid, rel).decide(sub)
            else:
                sk = self.by_id[eid].get("kind", "item") == "skill"
                ctx = np.stack([self.feat.ctx(o.raw, rel, sk) for o in sub])
                cc = [self.feat.cands(o.raw, rel, sk) for o in sub]
                cand, mask = policy.trim(np.stack([c[0] for c in cc]), np.stack([c[1] for c in cc]))
                if sample:
                    import jax
                    self.key, k1 = jax.random.split(self.key)
                    a, _, _ = policy.act_sample(self.params[eid], ctx, cand, mask, k1)
                else:
                    a, _ = policy.act_greedy(self.params[eid], ctx, cand, mask)
                acts = [int(x) for x in a]
            for i, a in zip(idx, acts):
                out[i] = a
        return out
