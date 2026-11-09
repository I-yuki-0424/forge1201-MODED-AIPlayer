"""The hand-written requirement graph (rule hardcoding is allowed on this side, owner 2026-11-08): which expert to run next to get `amount` of `item`.

An expert can run when everything in its `needs` is held; otherwise the expert that makes the missing item comes first, recursively. The router
(router.py) is a gradient-boosted copy of this function that reads only the pack and the goal. Labels come from the rules, never from "which expert
would succeed here" (that would need counterfactual branching of the environment, DPOD review of 2026-11-06).
"""
from . import catalog

DONE = "done"
NEAR = 6.0               # blocks: an expert whose target is farther than this away is not started; the movement expert walks first (MOE-v2)
STALLS = 2               # calls of one expert without a change of pack or a step toward its target: the stuck-escape expert is called


class Rules:
    def __init__(self, cat):
        self.cat = cat
        self.by_id = catalog.experts(cat)
        self.maker = {e["makes"]: e["id"] for e in cat["experts"] if e.get("kind", "item") == "item"}
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

    def route(self, item, amount, inv, info=None):
        """(expert id or DONE, scan groups shown to it). Rule hardcoding: the movement and stuck-escape experts are exceptions to the prerequisite order, called at any
        time (owner notes 2026-11-08). `info` = {"dist": {group: blocks to the nearest cell of the group within 4 chunks, or None}, "stalls": n}."""
        e = self.next(item, amount, inv)
        if e == DONE:
            return DONE, ()
        info = info or {}
        if info.get("stalls", 0) >= STALLS and "unstick" in self.by_id:
            return "unstick", catalog.relevance(self.by_id["unstick"])
        ex = self.by_id[e]
        rel = catalog.relevance(ex)
        ds = [info.get("dist", {}).get(g) for g in ex.get("targets", [])]
        ds = [d for d in ds if d is not None]
        if ds and min(ds) > NEAR and "move" in self.by_id:
            return "move", rel
        return e, rel

    def relevance(self, expert_id, item, amount, inv):
        """The groups to show `expert_id` when a learned router has chosen it: those of the item expert it serves (move), the sky (unstick), or its own."""
        if expert_id in (DONE, None):
            return ()
        if expert_id == "move":
            e = self.next(item, amount, inv)
            return catalog.relevance(self.by_id[e]) if e != DONE else ()
        return catalog.relevance(self.by_id[expert_id])
