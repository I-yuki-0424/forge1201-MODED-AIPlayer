"""Scripted policies on the same observation the learned experts see: the positive control of every expert (a scenario that a scripted solver cannot
solve says nothing about a learner), the uniform-random negative control, and nothing else. They read only inventory and the offered candidates.
Rules are (command, item regex[, condition on the pack]); the first rule with an offered candidate wins, the nearest candidate of it is taken."""
import random
import re

CMDS = ["pad", "move_to", "mine", "attack", "pickup", "craft", "smelt", "place", "activate", "equip", "eat", "wait", "tunnel"]
STONE = r"^(stone|cobblestone|andesite|diorite|granite|deepslate)$"

RULES = {
    "log": [("mine", r"_log$"), ("move_to", r"_log$"), ("move_to", r"_leaves$")],
    "planks": [("craft", r"_planks$")],
    "stick": [("craft", r"^stick$")],
    "crafting_table": [("craft", r"^crafting_table$")],
    "wooden_pickaxe": [("craft", r"^wooden_pickaxe$"), ("place", r"^crafting_table$")],
    "cobblestone": [("mine", STONE), ("tunnel", r".*"), ("move_to", STONE)],
    "stone_pickaxe": [("craft", r"^stone_pickaxe$"), ("place", r"^crafting_table$")],
    "furnace": [("craft", r"^furnace$"), ("place", r"^crafting_table$")],
    "coal": [("mine", r"coal_ore$"), ("move_to", r"coal_ore$")],
    "raw_iron": [("mine", r"iron_ore$"), ("move_to", r"iron_ore$")],
    "iron_ingot": [("smelt", r"^raw_iron$"), ("place", r"^furnace$")],
    "iron_pickaxe": [("craft", r"^iron_pickaxe$"), ("place", r"^crafting_table$")],
}
_COND = re.compile(r"^(#?[a-z_]+)(>=|<)(\d+)$")


def holds(cond, inv):
    name, op, n = _COND.match(cond).groups()
    have = inv.get(name, 0)
    return have >= int(n) if op == ">=" else have < int(n)


class Random:
    """Uniform over the offered candidates (negative control)."""
    def __init__(self, seed=0):
        self.rng = random.Random(seed)

    def decide(self, obs_list):
        return [self.rng.choice([i for i, k in enumerate(ob.raw["cand_mask"]) if k and ob.raw["cand_cmd"][i] > 0] or [0]) for ob in obs_list]


class Solver:
    def __init__(self, expert, feat, seed=0):
        self.rules = [(r[0], re.compile(r[1]), r[2] if len(r) > 2 else None) for r in RULES[expert]]
        self.feat = feat
        self.rng = random.Random(seed)

    def one(self, o):
        inv = self.feat.named_inventory(o)
        offered = [(i, CMDS[o["cand_cmd"][i]], self.feat.names[o["cand_item"][i]], o["cand_feat"][i][3]) for i in range(64) if o["cand_mask"][i] and o["cand_cmd"][i] > 0]
        for cmd, rx, cond in self.rules:
            if cond and not holds(cond, inv):
                continue
            c = [x for x in offered if x[1] == cmd and rx.search(x[2] or "")]
            if c:
                return min(c, key=lambda x: x[3])[0]
        move = [x for x in offered if x[1] in ("move_to", "tunnel")] or offered
        return self.rng.choice(move)[0] if move else 0

    def decide(self, obs_list):
        return [self.one(ob.raw) for ob in obs_list]
