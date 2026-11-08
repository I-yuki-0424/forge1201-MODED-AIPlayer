"""The hand-written requirement graph (rule hardcoding is allowed on this side, owner 2026-11-08): which expert to run next to get `amount` of `item`.

An expert can run when everything in its `needs` is held; otherwise the expert that makes the missing item comes first, recursively. The router
(router.py) is a gradient-boosted copy of this function that reads only the pack and the goal. Labels come from the rules, never from "which expert
would succeed here" (that would need counterfactual branching of the environment, DPOD review of 2026-11-06).
"""
from . import catalog

DONE = "done"


class Rules:
    def __init__(self, cat):
        self.cat = cat
        self.by_id = catalog.experts(cat)
        self.maker = {e["makes"]: e["id"] for e in cat["experts"]}
        self.equiv = cat["equivalent"]

    def held(self, inv, item):
        return sum(inv.get(n, 0) for n in self.equiv.get(item, [item]))

    def next(self, item, amount, inv, _depth=0):
        """Expert id to run now, or DONE when `amount` of `item` is already held."""
        if self.held(inv, item) >= amount:
            return DONE
        if _depth > len(self.by_id):
            raise RuntimeError(f"requirement cycle at {item}")
        e = self.by_id[self.maker[item]]
        for need, n in e["needs"].items():
            if self.held(inv, need) < n:
                return self.next(need, n, inv, _depth + 1)
        return e["id"]

    def plan(self, item, amount, inv):
        """The whole order of experts for a pack that does not change (each expert is assumed to deliver its goal and use up nothing): a list of ids."""
        inv, out = dict(inv), []
        while True:
            e = self.next(item, amount, inv)
            if e == DONE or e in out:
                return out
            out.append(e)
            for k, v in self.by_id[e]["goal"].get("have", {}).items():
                inv[k] = inv.get(k, 0) + v
