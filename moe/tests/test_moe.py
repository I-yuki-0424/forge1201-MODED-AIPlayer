import copy
import tempfile
import unittest

import jax
import numpy as np

from moe import catalog, features, policy, ppo, router, rules, train


def fake_obs(vocab, inv=(), cands=()):
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
    return o


class Catalog(unittest.TestCase):
    def setUp(self):
        self.cat = catalog.load()

    def test_twelve_experts_each_makes_one_item_and_every_need_has_a_maker(self):
        self.assertEqual(len(self.cat["experts"]), 12)
        makers = [e["makes"] for e in self.cat["experts"]]
        self.assertEqual(len(set(makers)), 12)
        for e in self.cat["experts"]:
            self.assertIn(e["makes"], e["goal"]["have"])
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
        self.assertEqual(sc["end"], {"have": {"raw_iron": 3}, "max_steps": 120, "die": True})
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
            self.assertIn(self.r.next(e["makes"], 1, {}), [x["id"] for x in self.cat["experts"]])


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


class Router(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cat = catalog.load()
        cls.rules = rules.Rules(cls.cat)
        cls.train = router.sample(cls.cat, cls.rules, np.random.default_rng(1), 6000)
        cls.test = router.sample(cls.cat, cls.rules, np.random.default_rng(2), 2400)

    def test_both_learners_copy_the_rules_on_held_out_states(self):
        for kind in ("xgb", "lgb"):
            r = router.GBRouter(self.cat, kind).fit(self.train, rounds=40)
            ev = router.evaluate(r, self.test)
            self.assertGreater(ev["accuracy"], 0.97, f"{kind}: {ev}")
            with tempfile.TemporaryDirectory() as d:
                r.save(f"{d}/r.model")
                r2 = router.GBRouter.load(f"{d}/r.model", self.cat)
                self.assertEqual(list(r.predict_rows(self.test[:200])), list(r2.predict_rows(self.test[:200])))

    def test_labels_come_from_the_rules_and_cover_every_class(self):
        labels = {t[3] for t in self.train}
        self.assertEqual(labels, set(router.Space(self.cat).classes))


if __name__ == "__main__":
    unittest.main()
