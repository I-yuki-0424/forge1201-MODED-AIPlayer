"""The router: XGBoost or LightGBM over (pack, goal) -> which expert to run next (or DONE).

Trained on states sampled from the catalogue (sparse random packs, the experts' own start kits, packs one short of / exactly at / one over every
threshold of every `needs`) and labelled by moe.rules. Evaluated on held-out samples of the same kinds, and end to end in the simulator (chain.py).
"""
import json
import time

import numpy as np

from . import catalog
from .rules import DONE, Rules


class Space:
    """Feature layout: counts of the catalogue items + #log + #planks, one-hot goal (over the experts' items), goal amount."""
    def __init__(self, cat):
        self.cat = cat
        self.items = list(cat["items"]) + ["#log", "#planks"]
        self.goals = [e["makes"] for e in cat["experts"]]
        self.classes = [e["id"] for e in cat["experts"]] + [DONE]
        self.dim = len(self.items) + len(self.goals) + 1

    def vector(self, inv, goal, amount):
        x = np.zeros(self.dim, dtype=np.float32)
        for i, n in enumerate(self.items):
            x[i] = min(inv.get(n, 0), 64)
        x[len(self.items) + self.goals.index(goal)] = 1.0
        x[-1] = amount
        return x


def _with_groups(inv):
    inv = dict(inv)
    inv["#log"] = sum(v for k, v in inv.items() if k.endswith("_log"))
    inv["#planks"] = sum(v for k, v in inv.items() if k.endswith("_planks"))
    return inv


def sample(cat, rules, rng, n):
    """n (inventory, goal, amount, label) tuples from four kinds of states."""
    ex = cat["experts"]
    goals = [(e["makes"], max(e["goal"]["have"][e["makes"]], 1)) for e in ex]
    out = []
    for i in range(n):
        kind = i % 4
        e = ex[int(rng.integers(len(ex)))]
        if kind == 0:                                           # sparse random packs
            inv = {}
            for it in rng.choice(cat["items"], size=int(rng.poisson(4)) + 1, replace=True):
                inv[str(it)] = int(np.exp(rng.uniform(0, np.log(40))))
        elif kind == 1:                                         # an expert's own start kit (what the previous expert leaves)
            inv = {k: int(rng.integers(lo, hi + 1)) for k, (lo, hi) in e["start"]["kit"].items() if hi >= 1}
            inv = {k: v for k, v in inv.items() if v > 0 and not k.startswith("#")}
        else:                                                   # at every threshold: one short, exactly, one over
            inv = {}
            for it, need in e["needs"].items():
                if it.startswith("#"):
                    it = "oak_log" if it == "#log" else "oak_planks"
                if it in cat["items"]:
                    inv[it] = max(need + int(rng.integers(-1, 2)), 0)
            if kind == 3:                                       # plus junk and a few other items
                for it in rng.choice(cat["items"], size=3):
                    inv.setdefault(str(it), int(rng.integers(0, 5)))
        inv = _with_groups({k: v for k, v in inv.items() if v > 0})
        roll = rng.random()
        if roll < 0.4:
            g, a = goals[-1][0], 1                              # the chain's goal
        elif roll < 0.7 and kind != 0:
            g, a = e["makes"], max(e["goal"]["have"][e["makes"]], 1)       # the goal the state was built for: every class gets its share
        else:
            g, a = goals[int(rng.integers(len(goals)))]
            a = max(a + int(rng.integers(0, 2)) * a, 1)
        out.append((inv, g, a, rules.next(g, a, inv)))
    return out


class GBRouter:
    def __init__(self, cat=None, kind="xgb"):
        self.cat = cat or catalog.load()
        self.kind = kind
        self.space = Space(self.cat)
        self.rules = Rules(self.cat)
        self.booster = None

    def matrix(self, rows):
        return np.stack([self.space.vector(i, g, a) for i, g, a, _ in rows]), np.array([self.space.classes.index(r[3]) for r in rows])

    def fit(self, rows, rounds=80, threads=2):         # LightGBM's multiclass objective diverges at learning rate 0.3 (train accuracy 0.34), 0.1 is stable
        x, y = self.matrix(rows)
        k = len(self.space.classes)
        if self.kind == "xgb":
            import xgboost as xgb
            self.booster = xgb.train({"objective": "multi:softprob", "num_class": k, "max_depth": 6, "eta": 0.2, "tree_method": "hist", "nthread": threads,
                                      "verbosity": 0}, xgb.DMatrix(x, label=y), rounds)
        elif self.kind == "lgb":
            import lightgbm as lgb
            self.booster = lgb.train({"objective": "multiclass", "num_class": k, "num_leaves": 31, "learning_rate": 0.1, "num_threads": threads, "verbose": -1,
                                      "min_data_in_leaf": 5}, lgb.Dataset(x, label=y), rounds)
        else:
            raise ValueError(self.kind)
        return self

    def proba(self, x):
        if self.kind == "xgb":
            import xgboost as xgb
            return self.booster.predict(xgb.DMatrix(x))
        return self.booster.predict(x, num_threads=1)

    def predict_rows(self, rows):
        x, _ = self.matrix(rows)
        return np.argmax(self.proba(x), axis=1)

    def route(self, goal, amount, inv):
        """Expert id (or DONE) for a pack; `inv` is a named inventory with #log / #planks sums."""
        p = self.proba(self.space.vector(inv, goal, amount)[None, :])
        return self.space.classes[int(np.argmax(p[0]))]

    def save(self, path):
        if self.kind == "xgb":
            self.booster.save_model(str(path))
        else:
            self.booster.save_model(str(path))
        with open(str(path) + ".json", "w") as f:
            json.dump({"kind": self.kind, "classes": self.space.classes, "dim": self.space.dim}, f)

    @classmethod
    def load(cls, path, cat=None):
        meta = json.load(open(str(path) + ".json"))
        r = cls(cat, meta["kind"])
        if r.kind == "xgb":
            import xgboost as xgb
            r.booster = xgb.Booster(); r.booster.load_model(str(path))
        else:
            import lightgbm as lgb
            r.booster = lgb.Booster(model_file=str(path))
        return r


def evaluate(router, rows):
    """Accuracy on held-out rows (all, and per kind of row), mean single-call latency in microseconds, and the model file size is the caller's."""
    pred = router.predict_rows(rows)
    truth = np.array([router.space.classes.index(r[3]) for r in rows])
    ok = pred == truth
    by_kind = {f"kind{k}": float(ok[k::4].mean()) for k in range(4)}
    t0 = time.perf_counter()
    for inv, g, a, _ in rows[:300]:
        router.route(g, a, inv)
    us = (time.perf_counter() - t0) / 300 * 1e6
    return {"accuracy": float(ok.mean()), "n": len(rows), **by_kind, "latency_us": round(us, 1)}
