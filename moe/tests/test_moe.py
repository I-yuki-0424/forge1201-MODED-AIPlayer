import copy
import tempfile
import unittest

import jax
import numpy as np

from moe import catalog, chain, features, policy, ppo, router, rules, solvers, train


def fake_obs(vocab, inv=(), cands=(), scan=None, cand_scan=None):
    """An observation with the simulator's shapes. inv: [(name, count)], cands: [(cmd, item name, feat3 distance)]."""
    ix = {n: i for i, n in enumerate(vocab)}
    o = {"grid": [i % 11 for i in range(405)], "self": [0.5] * 20, "clock": [0.1, 0.2, 0.3], "ent_feat": [[0.0] * 5] * 8, "last_reason": 0, "dt_ticks": 20.0,
         "view_cat": [0] * 128, "view_item": [0] * 128, "view_dist": [1.0] * 128, "progress": [0.0] * 26}
    o["inv_item"] = [ix[n] for n, _ in inv] + [0] * (36 - len(inv))
    o["inv_count"] = [c / 64.0 for _, c in inv] + [0.0] * (36 - len(inv))
    o["cand_cmd"] = [c[0] for c in cands] + [0] * (64 - len(cands))
    o["cand_item"] = [ix[c[1]] for c in cands] + [0] * (64 - len(cands))
    o["cand_ent"] = [0] * 64
    o["cand_feat"] = [[0, 0, 0, c[2], 0, 0, 0, 0] for c in cands] + [[0.0] * 8] * (64 - len(cands))
    o["cand_mask"] = [True] * len(cands) + [False] * (64 - len(cands))
    if scan is not None:                                     # {group: [(dx, dy, dz) in blocks, ...]} nearest first, as the simulator's scan field
        sc = np.zeros((features.NG, features.M, 5), dtype=np.float32)
        for g, cells in scan.items():
            for m, (dx, dy, dz) in enumerate(cells[:features.M]):
                d = float(np.sqrt(dx * dx + dy * dy + dz * dz))
                sc[features.GROUPS.index(g), m] = [np.clip(dx / 64, -1, 1), np.clip(dy / 64, -1, 1), np.clip(dz / 64, -1, 1), min(d / 64, 1.0), 1.0]
        o["scan"] = sc.reshape(-1).tolist()
        cs = np.zeros((64, features.NG), dtype=np.float32)
        for k, row in (cand_scan or {}).items():
            cs[k] = row
        o["cand_scan"] = cs.tolist()
    return o


class Catalog(unittest.TestCase):
    def setUp(self):
        self.cat = catalog.load()

    def test_fifteen_item_experts_each_make_one_item_two_skill_experts_make_none_and_every_need_has_a_maker(self):
        items = [e for e in self.cat["experts"] if e.get("kind", "item") == "item"]
        skills = [e for e in self.cat["experts"] if e.get("kind") == "skill"]
        self.assertEqual((len(items), sorted(e["id"] for e in skills)), (15, ["move", "unstick"]))
        makers = [e["makes"] for e in items]
        self.assertEqual(len(set(makers)), 15)
        for e in skills:
            self.assertIsNone(e["makes"])
            self.assertIn("reach", e["goal"])
        for e in items:
            self.assertIn(e["makes"], e["goal"]["have"])
        for e in self.cat["experts"]:
            for need in e["needs"]:
                self.assertTrue(need in makers or need in self.cat["equivalent"])

    def test_every_kit_satisfies_the_experts_own_needs_at_its_lower_bound(self):
        # the standardised start must hold the prerequisites, otherwise the expert would be trained on starts the router never hands it
        for e in self.cat["experts"]:
            kit = {k: lo for k, (lo, hi) in e["start"]["kit"].items()}
            inv = router._with_groups(kit)
            for need, n in e["needs"].items():
                held = sum(inv.get(x, 0) for x in self.cat["equivalent"].get(need, [need]))
                self.assertGreaterEqual(held, n, f"{e['id']} starts without {need} x{n}")

    def test_checks_refuse_typos_and_unknown_names(self):
        for mutate, why in [(lambda c: c["experts"][0].update(typo=1), "unknown keys"), (lambda c: c["experts"][1]["needs"].update(nonsense=1), "item list"),
                            (lambda c: c["experts"][2]["start"]["kit"].update(stick=[5, 1]), "kit range"), (lambda c: c["experts"][3].update(makes="stick"), "makes"),
                            (lambda c: c["chain"].update(goal="nothing"), "chain goal"), (lambda c: c["experts"][4]["goal"].clear(), "goal")]:
            c = copy.deepcopy(self.cat)
            mutate(c)
            with self.assertRaises(catalog.CatalogError, msg=why):
                catalog.check(c)

    def test_scenario_has_ranged_kit_junk_and_an_end_that_stops_on_death(self):
        sc = catalog.scenario(catalog.experts(self.cat)["raw_iron"], self.cat)
        self.assertEqual(sc["end"], {"have": {"raw_iron": 3}, "max_steps": 200, "die": True})
        self.assertTrue(sc["scan"])
        self.assertIn("dirt", sc["kit"])                       # junk the expert has to ignore
        self.assertEqual(sc["kit"]["stone_pickaxe"], [1, 1])
        self.assertEqual(sc["place"][0]["block"], "iron_ore")


class Rules(unittest.TestCase):
    def setUp(self):
        self.cat = catalog.load()
        self.r = rules.Rules(self.cat)

    def test_order_from_an_empty_pack(self):
        plan = self.r.plan("iron_pickaxe", 1, {})
        for a, b in [("log", "planks"), ("planks", "crafting_table"), ("crafting_table", "wooden_pickaxe"), ("cobblestone", "stone_pickaxe"),
                     ("stone_pickaxe", "raw_iron"), ("furnace", "iron_ingot"), ("raw_iron", "iron_ingot"), ("iron_ingot", "iron_pickaxe")]:
            self.assertLess(plan.index(a), plan.index(b), f"{a} before {b}: {plan}")
        self.assertEqual(plan[-1], "iron_pickaxe")
        self.assertEqual(self.r.next("iron_pickaxe", 1, {}), "log")

    def test_nothing_to_do_when_the_goal_is_held_and_the_last_step_when_everything_is(self):
        self.assertEqual(self.r.next("iron_pickaxe", 1, {"iron_pickaxe": 1}), rules.DONE)
        self.assertEqual(self.r.next("iron_pickaxe", 1, {"iron_ingot": 3, "stick": 2, "crafting_table": 1}), "iron_pickaxe")
        self.assertEqual(self.r.next("iron_pickaxe", 1, {"iron_ingot": 3, "stick": 1, "crafting_table": 1, "#planks": 2}), "stick")

    def test_a_better_tool_stands_in_for_a_worse_one(self):
        inv = {"stone_pickaxe": 1, "crafting_table": 1}
        self.assertEqual(self.r.next("coal", 2, inv), "coal")
        self.assertEqual(self.r.next("cobblestone", 8, inv), "cobblestone")
        self.assertEqual(self.r.next("cobblestone", 8, {}), "log")

    def test_no_requirement_cycle_in_the_catalogue(self):
        for e in self.cat["experts"]:
            if e.get("kind", "item") == "item":
                self.assertIn(self.r.next(e["makes"], 1, {}), [x["id"] for x in self.cat["experts"]])

    def test_movement_comes_first_when_the_target_is_far_and_unstick_after_two_stalls(self):
        inv = {"stone_pickaxe": 1, "crafting_table": 1}
        far = {"dist": {"iron": 40.0, "coal": None, "log": 10.0}}
        self.assertEqual(self.r.route("raw_iron", 3, inv, far), ("move", (2,)))                   # the groups shown are the ore expert's: iron
        near = {"dist": {"iron": 4.0}}
        self.assertEqual(self.r.route("raw_iron", 3, inv, near), ("raw_iron", (2,)))
        self.assertEqual(self.r.route("raw_iron", 3, inv, {"dist": {"iron": None}}), ("raw_iron", (2,)), "nothing scanned: the expert looks for itself")
        self.assertEqual(self.r.route("raw_iron", 3, inv, dict(near, stalls=2)), ("unstick", (4,)))
        self.assertEqual(self.r.route("raw_iron", 3, inv, dict(near, stalls=1))[0], "raw_iron")
        self.assertEqual(self.r.route("raw_iron", 3, {"raw_iron": 3}, far)[0], rules.DONE)
        self.assertEqual(self.r.route("raw_iron", 3, {}, {"dist": {"iron": 40.0, "log": 3.0}})[0], "log", "a missing prerequisite beats walking: logs first")
        self.assertEqual(self.r.route("raw_iron", 3, {}, far), ("move", (0,)), "the nearest tree is 10 blocks away: walk to it first; the groups shown are the log expert's")
        self.assertEqual(self.r.relevance("move", "raw_iron", 3, inv), (2,))


class Algorithm(unittest.TestCase):
    def test_gae_matches_the_hand_computation_and_cuts_exactly(self):
        adv, ret = ppo.gae([0, 0, 1], [0.5, 0.5, 0.5], [0, 0, 1], [0.5, 0.5, 0.0], 1.0, 1.0)
        np.testing.assert_allclose(adv, [0.5, 0.5, 0.5], atol=1e-6)
        np.testing.assert_allclose(ret, [1.0, 1.0, 1.0], atol=1e-6)
        adv, _ = ppo.gae([0, 0, 1], [0.5, 0.5, 0.5], [0, 0, 0], [0.5, 0.5, 0.7], 1.0, 1.0)         # cut at the end of the batch: bootstrap with the next value
        np.testing.assert_allclose(adv, [1.2, 1.2, 1.2], atol=1e-6)      # 1 + 0.7 - 0.5: the reward plus the value of what follows
        adv, _ = ppo.gae([1, 0], [0.0, 0.0], [1, 0], [0.0, 0.3], 0.9, 0.95)                         # an episode end stops the sum
        self.assertAlmostEqual(float(adv[0]), 1.0, places=6)

    def test_reward_terms(self):
        g = train.Goal({"goal": {"have": {"#log": 4}}, "max_steps": 70})
        self.assertAlmostEqual(transition := train.transition_reward(g, 0.0, 0.125, ""), train.GAMMA * 0.125 - train.STEP_COST, places=6)
        self.assertAlmostEqual(train.transition_reward(g, 0.375, 0.0, "success"), -0.375 - train.STEP_COST + 1.0, places=6)
        self.assertAlmostEqual(train.transition_reward(g, 0.1, 0.0, "died"), -0.1 - train.STEP_COST + train.DEATH, places=6)
        self.assertEqual(train.transition_reward(g, 0.0, 0.0, "timeout"), -train.STEP_COST)

    def test_approach_shaping_rises_as_the_target_comes_into_view_and_near(self):
        cat = catalog.load()
        vocab = ["none"] + sorted(set(cat["items"]) | {"stone"})
        f = features.Featurizer(vocab, cat["items"])
        e = catalog.experts(cat)["raw_iron"]
        g = train.Goal(e, f)
        o = fake_obs(vocab)
        far, near, other = dict(o), dict(o), dict(o)
        far["view_item"] = [vocab.index("iron_ore")] + [0] * 127; far["view_dist"] = [0.9] + [1.0] * 127
        near["view_item"] = [vocab.index("iron_ore")] + [0] * 127; near["view_dist"] = [0.2] + [1.0] * 127
        other["view_item"] = [vocab.index("stone")] + [0] * 127; other["view_dist"] = [0.1] + [1.0] * 127
        p0, pf, pn, po = (g.potential(f, x) for x in (o, far, near, other))
        self.assertEqual(p0, 0.0)
        self.assertEqual(po, 0.0)
        self.assertLess(pf, pn)
        self.assertAlmostEqual(pn, 0.2 * 0.8, places=5)
        held = fake_obs(vocab, inv=[("raw_iron", 3)])
        self.assertAlmostEqual(g.potential(f, held), 0.5, places=5)
        self.assertEqual(train.Goal(catalog.experts(cat)["log"], f).approach_ids, None)

    def test_ppo_learns_to_pick_the_one_good_candidate(self):
        """A toy environment with the real tensor shapes: the candidate whose feature 0 is 1 pays. Chance is 1 in 8."""
        rng = np.random.default_rng(0)
        D, C, K = 6, 7, 64
        params = policy.init(jax.random.PRNGKey(0), D, C, 32)
        opt, step = ppo.make_update(lr=3e-3, ent=0.003)
        state = opt.init(params)
        key = jax.random.PRNGKey(1)
        rate = []
        for it in range(40):
            trajs = [ppo.Traj() for _ in range(4)]
            hits = 0
            for _ in range(256):
                ctx = rng.normal(size=(4, D)).astype(np.float32)
                cand = rng.normal(size=(4, K, C)).astype(np.float32) * 0.3
                mask = np.zeros((4, K), dtype=bool); mask[:, :8] = True
                good = rng.integers(0, 8, size=4)
                cand[:, :, 0] = 0.0; cand[np.arange(4), good, 0] = 1.0
                key, k = jax.random.split(key)
                a, lp, v = policy.act_sample(params, ctx, cand, mask, k)
                for i in range(4):
                    r = 1.0 if int(a[i]) == good[i] else 0.0
                    hits += r
                    trajs[i].add(ctx[i], cand[i], mask[i], int(a[i]), float(lp[i]), float(v[i]), r, 1.0, 0.0)
            rate.append(hits / 1024)
            params, state, _ = ppo.update(params, state, step, ppo.batch_of(trajs), rng, epochs=3, minibatch=256)
        self.assertLess(np.mean(rate[:3]), 0.3)
        self.assertGreater(np.mean(rate[-3:]), 0.8, f"success per iteration: {np.round(rate, 2)}")

    def test_checkpoint_roundtrip(self):
        p = policy.init(jax.random.PRNGKey(3), 10, 5, 16)
        with tempfile.TemporaryDirectory() as d:
            policy.save(f"{d}/x.npz", p, {"expert": "log", "hidden": 16})
            q, meta = policy.load(f"{d}/x.npz")
        self.assertEqual(meta["expert"], "log")
        for k in p:
            for kk in p[k]:
                np.testing.assert_array_equal(np.asarray(p[k][kk]), np.asarray(q[k][kk]))


class Features(unittest.TestCase):
    def test_shapes_names_groups_and_masks(self):
        cat = catalog.load()
        vocab = ["none"] + sorted(set(cat["items"]) | {"oak_leaves", "stone", "spruce_log"})
        f = features.Featurizer(vocab, cat["items"])
        o = fake_obs(vocab, inv=[("oak_log", 3), ("spruce_log", 2), ("birch_planks", 5), ("stick", 1)], cands=[(2, "oak_log", 0.3), (2, "stone", 0.1), (5, "stick", 0.0), (11, "none", 0.0)])
        ctx = f.ctx(o)
        cand, mask = f.cands(o)
        self.assertEqual(ctx.shape, (f.ctx_dim,))
        self.assertEqual(cand.shape, (64, f.cand_dim))
        self.assertEqual(int(mask.sum()), 4)
        self.assertTrue((cand[~mask] == 0).all())
        inv = f.named_inventory(o)
        self.assertEqual((inv["#log"], inv["#planks"], inv["stick"]), (5, 5, 1))
        self.assertEqual(f.counts(o, ["#log", "stick", "coal"]), [5, 1, 0])
        self.assertTrue(np.isfinite(ctx).all() and np.isfinite(cand).all())

    def test_goal_progress_is_not_in_the_context(self):
        cat = catalog.load()
        vocab = ["none"] + sorted(set(cat["items"]))
        f = features.Featurizer(vocab, cat["items"])
        a, b = fake_obs(vocab), fake_obs(vocab)
        b["progress"] = [1.0] * 26
        np.testing.assert_array_equal(f.ctx(a), f.ctx(b))


class Scan(unittest.TestCase):
    def setUp(self):
        self.cat = catalog.load()
        self.vocab = ["none"] + sorted(set(self.cat["items"]) | {"stone"})
        self.f = features.Featurizer(self.vocab, self.cat["items"])

    def test_only_the_groups_the_router_called_relevant_are_shown_nearest_first(self):
        o = fake_obs(self.vocab, scan={"iron": [(30, 0, 0), (10, 5, 0)], "coal": [(3, 0, 0)], "log": [(2, 0, 0)]})
        tg, g = self.f.targets(o, (2,))
        self.assertEqual(g, 2)
        self.assertAlmostEqual(float(tg[0, 3]), np.sqrt(125) / 64, places=4)          # the nearer iron first
        self.assertAlmostEqual(float(tg[1, 3]), 30 / 64, places=4)
        self.assertEqual(float(tg[2, 4]), 0.0)
        self.assertEqual(tg[0, 5:].tolist(), [0, 0, 1, 0, 0])
        _, g2 = self.f.targets(o, (1, 2))
        self.assertEqual(g2, 1, "coal at 3 blocks is nearer than any iron")
        none, g3 = self.f.targets(o, ())
        self.assertIsNone(g3)
        self.assertEqual(float(np.abs(none).sum()), 0.0)
        self.assertEqual(self.f.ctx(o, (2,)).shape, (self.f.ctx_dim,))
        a, b = self.f.ctx(o, (2,)), self.f.ctx(o, (1,))
        self.assertFalse(np.array_equal(a, b))
        o2 = fake_obs(self.vocab, scan={"iron": [(30, 0, 0)], "coal": [(1, 0, 0)]})
        np.testing.assert_array_equal(self.f.ctx(o, (2,))[-features.NG - features.T * features.TGT:-features.T * features.TGT], self.f.ctx(o2, (2,))[-features.NG - features.T * features.TGT:-features.T * features.TGT])

    def test_a_skill_expert_sees_anonymous_targets_so_waypoints_and_ore_look_alike(self):
        way = fake_obs(self.vocab, scan={"way": [(12, 0, 3)]})
        iron = fake_obs(self.vocab, scan={"iron": [(12, 0, 3)]})
        np.testing.assert_array_equal(self.f.ctx(way, (3,), True), self.f.ctx(iron, (2,), True))
        self.assertFalse(np.array_equal(self.f.ctx(way, (3,), False), self.f.ctx(iron, (2,), False)), "an item expert does see the group")
        self.assertTrue(train.Goal(catalog.experts(self.cat)["move"], self.f).skill)

    def test_the_candidate_column_is_the_progress_toward_the_nearest_relevant_target(self):
        cs = {0: [0, 0, 0.6, 0, 0], 1: [0, 0, -0.5, 0, 0]}
        o = fake_obs(self.vocab, cands=[(1, "iron_ore", 0.5), (1, "none", 0.5)], scan={"iron": [(20, 0, 0)], "coal": [(5, 0, 0)]}, cand_scan=cs)
        c, mask = self.f.cands(o, (2,))
        self.assertAlmostEqual(float(c[0, -1]), 0.6)
        self.assertAlmostEqual(float(c[1, -1]), -0.5)
        c, _ = self.f.cands(o, (1, 2))                       # coal is nearer: its column
        self.assertAlmostEqual(float(c[0, -1]), 0.0)
        c, _ = self.f.cands(o, ())
        self.assertEqual(float(np.abs(c[:, -1]).sum()), 0.0)

    def test_the_shaping_potential_of_a_skill_expert_is_distance_to_the_target(self):
        g = train.Goal(catalog.experts(self.cat)["move"], self.f)
        ps = [g.potential(self.f, fake_obs(self.vocab, scan={"way": [(d, 0, 0)]})) for d in (60, 30, 5, 0.1)]
        self.assertEqual(ps, sorted(ps))
        self.assertAlmostEqual(ps[-1], 1.0, places=2)
        self.assertEqual(g.potential(self.f, fake_obs(self.vocab, scan={"iron": [(5, 0, 0)]})), 0.0, "an irrelevant group does not count")

    def test_the_skill_solver_follows_progress_and_otherwise_moves_at_random(self):
        s = solvers.Solver("move", self.f, rel=(3,))
        o = fake_obs(self.vocab, cands=[(1, "none", 0.1), (1, "none", 0.2), (12, "none", 0.1)], scan={"way": [(30, 0, 0)]}, cand_scan={0: [0, 0, 0, 0.1, 0], 1: [0, 0, 0, 0.8, 0], 2: [0, 0, 0, 0.3, 0]})
        self.assertEqual(s.one(o), 1)
        o = fake_obs(self.vocab, cands=[(1, "none", 0.1), (12, "none", 0.1)], scan={"way": [(30, 0, 0)]})
        self.assertIn(s.one(o), (0, 1))


class FakeObs:
    def __init__(self, key, step, raw):
        self.key, self.step, self.raw = key, step, raw


class ChainStall(unittest.TestCase):
    def test_a_stalled_expert_is_sampled_not_repeated_and_after_two_stalls_unstick_is_called(self):
        cat = catalog.load()
        vocab = ["none"] + sorted(set(cat["items"]))
        f = features.Featurizer(vocab, cat["items"])
        r = rules.Rules(cat)
        calls = []

        def route(goal, amount, inv, info):
            calls.append((dict(info["dist"]), info["stalls"]))
            return r.route(goal, amount, inv, info)
        ch = chain.Chain(f, cat, route, {}, "raw_iron", 3, "solver")
        pack = [("stone_pickaxe", 1), ("crafting_table", 1)]
        far = lambda d: fake_obs(vocab, inv=pack, scan={"iron": [(d, 0, 0)]})
        seen = []
        step = 0
        for _ in range(8):
            picks = ch._pick(FakeObs((0, 0), step, far(40.0)))
            seen.append(picks)
            e = catalog.experts(cat)[picks[0]]
            step += e["max_steps"]                            # the call runs out its budget; nothing changed
        names = [s[0] for s in seen]
        self.assertEqual(names[0], "move")
        self.assertTrue(seen[0][2] is False and seen[1][2] is True, "the second call after a failure samples")
        self.assertIn("unstick", names, names)
        self.assertEqual([c[1] for c in calls][:3], [0, 1, 2])
        # progress resets the stalls: the pack changes
        ch2 = chain.Chain(f, cat, route, {}, "raw_iron", 3, "solver")
        ch2._pick(FakeObs((0, 0), 0, far(40.0)))
        better = fake_obs(vocab, inv=pack + [("raw_iron", 1)], scan={"iron": [(40.0, 0, 0)]})
        e, rel, sample = ch2._pick(FakeObs((0, 0), 200, better))
        self.assertEqual(ch2.state[(0, 0)]["stalls"], 0)
        self.assertFalse(sample)


class Router(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cat = catalog.load()
        cls.rules = rules.Rules(cls.cat)
        cls.train = router.sample(cls.cat, cls.rules, np.random.default_rng(1), 30000)
        cls.test = router.sample(cls.cat, cls.rules, np.random.default_rng(2), 4000)

    def test_both_learners_copy_the_rules_on_held_out_states(self):
        for kind in ("xgb", "lgb"):
            r = router.GBRouter(self.cat, kind).fit(self.train, rounds=120)
            ev = router.evaluate(r, self.test)
            self.assertGreater(ev["accuracy"], 0.96, f"{kind}: {ev}")
            with tempfile.TemporaryDirectory() as d:
                r.save(f"{d}/r.model")
                r2 = router.GBRouter.load(f"{d}/r.model", self.cat)
                self.assertEqual(list(r.predict_rows(self.test[:200])), list(r2.predict_rows(self.test[:200])))

    def test_a_pack_full_of_digging_leftovers_is_routed_like_the_rules_do(self):
        # found 2026-11-09: the first v2 router sent a chain with 89-261 cobblestone to `move` for hundreds of steps (counts it never saw)
        r = router.GBRouter(self.cat, "xgb").fit(self.train, rounds=120)
        inv = router._with_groups({"stone_pickaxe": 1, "wooden_pickaxe": 1, "crafting_table": 1, "raw_iron": 3, "coal": 2, "cobblestone": 261, "andesite": 90})
        for info in ({"dist": {"coal": 3.0, "iron": 2.0, "log": 30.0}, "stalls": 0}, {"dist": {"coal": None, "iron": None, "log": 12.0}, "stalls": 0}):
            self.assertEqual(r.route("iron_pickaxe", 1, inv, info)[0], self.rules.route("iron_pickaxe", 1, inv, info)[0], info)

    def test_labels_come_from_the_rules_and_cover_every_class(self):
        labels = {t[4] for t in self.train}
        self.assertEqual(labels, set(router.Space(self.cat).classes))


if __name__ == "__main__":
    unittest.main()
