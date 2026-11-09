"""Observation -> arrays for the expert policies.

An observation of the simulator (and of the real environment, src/rl/skill_space.js) lists up to K = 64 candidate commands the bot can run now. A policy
scores the candidates; this module turns one observation into `ctx` (a vector for everything that is not a candidate) and `cand` (K x D, one row per
candidate) plus the mask of candidates that exist. Items are reduced to the catalogue's core list (+ one `other` bucket) so that a model has ~90 k
parameters instead of an embedding table for 1,955 items.

Only fields the policy sees are used: `progress` (which milestones were reached) is left out on purpose, so an expert cannot read the task off it.
"""
import numpy as np

K = 64
N_CMD = 13
N_CAT = 11
N_REASON = 17
GRID_LAYERS = 5
# docs/proposed/MOE-v2.md: the simulator's target scan (tools/sim/src/scan.rs). Groups in the order of the observation's `scan` field.
GROUPS = ("log", "coal", "iron", "way", "sky")
NG = len(GROUPS)
M = 3                       # nearest cells per group in the observation
T = 4                       # targets an expert sees: the nearest of the groups the router called relevant
TGT = 5 + NG                # per target: dx, dy, dz, dist, present + the group's one-hot


class Featurizer:
    def __init__(self, vocab_items, core_items):
        self.core = list(core_items)
        self.n_core = len(self.core)
        self.other = self.n_core
        idx = np.full(len(vocab_items), self.other, dtype=np.int32)
        name_to_core = {n: i for i, n in enumerate(self.core)}
        self.is_log = np.zeros(len(vocab_items), dtype=bool)
        self.is_planks = np.zeros(len(vocab_items), dtype=bool)
        for i, n in enumerate(vocab_items):
            if n in name_to_core:
                idx[i] = name_to_core[n]
            self.is_log[i] = n.endswith("_log") or n.endswith("_stem")
            self.is_planks[i] = n.endswith("_planks")
        idx[0] = self.other                    # "none"
        self.core_of = idx
        self.names = list(vocab_items)
        self.ctx_dim = 20 + 3 + (self.n_core + 1) + 2 + GRID_LAYERS * N_CAT + N_CAT * 2 + (self.n_core + 1) * 2 + 40 + N_REASON + 1 + NG + T * TGT
        self.cand_dim = N_CMD + (self.n_core + 1) + 1 + 8 + 1 + 1 + 1

    def inventory(self, o):
        """{item id: count} of the pack (the observation stores count / 64)."""
        inv = {}
        for i, c in zip(o["inv_item"], o["inv_count"]):
            if i:
                inv[int(i)] = inv.get(int(i), 0) + int(round(float(c) * 64))
        return inv

    def named_inventory(self, o):
        """{name: count}, with `#log` and `#planks` summed over species."""
        out = {}
        for i, n in self.inventory(o).items():
            nm = self.names[i]
            out[nm] = out.get(nm, 0) + n
            if self.is_log[i]:
                out["#log"] = out.get("#log", 0) + n
            if self.is_planks[i]:
                out["#planks"] = out.get("#planks", 0) + n
        return out

    @staticmethod
    def targets(o, rel, anon=False):
        """The T nearest scanned cells of the groups in `rel` (indices into GROUPS) as rows [dx, dy, dz, dist, present, group one-hot], nearest first, and the group of the nearest.
        Only what the router called relevant is shown: the expert cannot see (or be distracted by) the other groups.
        `anon` (the skill experts): the group one-hot is left out, so a movement expert trained on waypoints walks to ore or a tree the same way."""
        out = np.zeros((T, TGT), dtype=np.float32)
        sc = o.get("scan")
        if not rel or sc is None:
            return out, None
        sc = np.asarray(sc, dtype=np.float32).reshape(NG, M, 5)
        rows = sorted(((sc[g, m, 3], g, m) for g in rel for m in range(M) if sc[g, m, 4] > 0), key=lambda r: r[0])[:T]
        for i, (_, g, m) in enumerate(rows):
            out[i, :5] = sc[g, m]
            if not anon:
                out[i, 5 + g] = 1.0
        return out, (rows[0][1] if rows else None)

    def ctx(self, o, rel=(), anon=False):
        tg, _ = self.targets(o, rel, anon)
        relv = np.zeros(NG, dtype=np.float32)
        for g in () if anon else rel:
            relv[g] = 1.0
        inv = np.zeros(self.n_core + 1, dtype=np.float32)
        logs = planks = 0
        for i, n in self.inventory(o).items():
            inv[self.core_of[i]] += n
            logs += n if self.is_log[i] else 0
            planks += n if self.is_planks[i] else 0
        inv = np.minimum(inv / 64.0, 1.0)
        tot = np.minimum(np.array([logs, planks], dtype=np.float32) / 64.0, 1.0)
        grid = np.asarray(o["grid"], dtype=np.int64).reshape(GRID_LAYERS, -1)
        hist = np.zeros((GRID_LAYERS, N_CAT), dtype=np.float32)
        for l in range(GRID_LAYERS):
            hist[l] = np.bincount(np.clip(grid[l], 0, N_CAT - 1), minlength=N_CAT)[:N_CAT] / max(grid.shape[1], 1)
        vc = np.asarray(o["view_cat"], dtype=np.int64)
        vd = np.asarray(o["view_dist"], dtype=np.float32)
        vi = np.asarray(o["view_item"], dtype=np.int64)
        cat_cnt = np.bincount(np.clip(vc, 0, N_CAT - 1), minlength=N_CAT)[:N_CAT].astype(np.float32) / len(vc)
        cat_min = np.ones(N_CAT, dtype=np.float32)
        item_cnt = np.zeros(self.n_core + 1, dtype=np.float32)
        item_min = np.ones(self.n_core + 1, dtype=np.float32)
        for c, d, it in zip(vc, vd, vi):
            if it == 0 and c == 0:
                continue
            cat_min[min(c, N_CAT - 1)] = min(cat_min[min(c, N_CAT - 1)], d)
            k = self.core_of[it]
            item_cnt[k] += 1.0 / len(vc)
            item_min[k] = min(item_min[k], d)
        ent = np.asarray(o["ent_feat"], dtype=np.float32).reshape(-1)
        reason = np.zeros(N_REASON, dtype=np.float32)
        reason[min(int(o["last_reason"]), N_REASON - 1)] = 1.0
        dt = np.array([min(float(o["dt_ticks"]) / 100.0, 5.0)], dtype=np.float32)
        return np.concatenate([np.asarray(o["self"], dtype=np.float32), np.asarray(o["clock"], dtype=np.float32), inv, tot, hist.reshape(-1),
                               cat_cnt, cat_min, item_cnt, item_min, ent, reason, dt, relv, tg.reshape(-1)]).astype(np.float32)

    def cands(self, o, rel=(), anon=False):
        """(cand [K, cand_dim], mask [K]) of an observation. The last column is the progress of each command toward the nearest relevant target (blocks / 16, signed, the last column); the one before it is `seen` (0 never ... 1 four times or more)."""
        cmd = np.asarray(o["cand_cmd"], dtype=np.int64)
        item = np.asarray(o["cand_item"], dtype=np.int64)
        mask = np.asarray(o["cand_mask"], dtype=bool) & (cmd > 0)
        out = np.zeros((K, self.cand_dim), dtype=np.float32)
        out[np.arange(K), np.clip(cmd, 0, N_CMD - 1)] = 1.0
        out[np.arange(K), N_CMD + self.core_of[item]] = 1.0
        base = N_CMD + self.n_core + 1
        out[:, base] = (np.asarray(o["cand_ent"]) > 0).astype(np.float32)
        out[:, base + 1:base + 9] = np.asarray(o["cand_feat"], dtype=np.float32)
        have = self.inventory(o)
        out[:, base + 9] = [min(have.get(int(i), 0) / 64.0, 1.0) if i else 0.0 for i in item]
        cs = o.get("cand_scan")
        if cs is not None and rel:
            _, g = self.targets(o, rel)
            if g is not None:
                out[:, base + 11] = np.asarray(cs, dtype=np.float32)[:, g]
        sn = o.get("cand_seen")                                  # the memory a stateless policy lacks: the bot stood near this destination in its last 24 commands
        if sn is not None:
            out[:, base + 10] = np.asarray(sn, dtype=np.float32)
        out[~mask] = 0.0
        return out, mask

    def counts(self, o, names):
        """Counts of `names` (items, `#log`, `#planks`) in the pack, as a list."""
        inv = self.named_inventory(o)
        return [inv.get(n, 0) for n in names]
