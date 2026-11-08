"""The whole system as one policy: the router picks an expert from the pack and the goal, the expert plays until its own goal is held or its step budget
is spent, then the router is asked again. Experts are trained networks (`net`) or the scripted solvers (`solver`, to separate router errors from expert errors).
"""
import numpy as np

from . import policy, solvers
from .rules import DONE


class Chain:
    def __init__(self, feat, cat, route, experts, goal="iron_pickaxe", amount=1, source="net"):
        """route(goal, amount, named inventory) -> expert id | DONE;  experts: {id: params} for source 'net'."""
        self.feat, self.cat, self.route, self.goal, self.amount, self.source = feat, cat, route, goal, amount, source
        self.by_id = {e["id"]: e for e in cat["experts"]}
        self.params = experts
        self.solvers = {i: solvers.Solver(i, feat) for i in self.by_id} if source == "solver" else {}
        self.state = {}
        self.completed = {}
        self.calls = 0

    def _reached(self, e, inv):
        return all(inv.get(k, 0) >= v for k, v in e["goal"].get("have", {}).items())

    def _pick(self, ob):
        st = self.state.get(ob.key)
        if st is None or ob.step == 0:
            st = self.state[ob.key] = {"e": None, "since": 0}
            self.completed[ob.key] = []
        inv = self.feat.named_inventory(ob.raw)
        e = self.by_id.get(st["e"]) if st["e"] else None
        if e is not None and (self._reached(e, inv) or ob.step - st["since"] >= e["max_steps"]):
            if self._reached(e, inv) and e["id"] not in self.completed[ob.key]:
                self.completed[ob.key].append(e["id"])
            e = None
        if e is None:
            self.calls += 1
            nxt = self.route(self.goal, self.amount, inv)
            st["e"], st["since"] = (None, ob.step) if nxt == DONE else (nxt, ob.step)
        return st["e"]

    def decide(self, obs_list):
        picks = [self._pick(ob) for ob in obs_list]
        out = [0] * len(obs_list)
        rnd = solvers.Random(len(obs_list))
        for eid in set(picks):
            idx = [i for i, p in enumerate(picks) if p == eid]
            sub = [obs_list[i] for i in idx]
            if eid is None:
                acts = rnd.decide(sub)
            elif self.source == "solver":
                acts = self.solvers[eid].decide(sub)
            else:
                ctx = np.stack([self.feat.ctx(o.raw) for o in sub])
                cc = [self.feat.cands(o.raw) for o in sub]
                cand, mask = policy.trim(np.stack([c[0] for c in cc]), np.stack([c[1] for c in cc]))
                a, _ = policy.act_greedy(self.params[eid], ctx, cand, mask)
                acts = [int(x) for x in a]
            for i, a in zip(idx, acts):
                out[i] = a
        return out
