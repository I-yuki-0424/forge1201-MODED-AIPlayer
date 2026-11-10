import unittest
import numpy as np
import jax, jax.numpy as jnp
from rl3 import sim as S, gen as G, obs as O

FLOOR = 5   # solid for y < FLOOR, feet at y = FLOOR


def world(fn=None, floor=FLOOR):
    w = np.zeros((S.NX, S.NY, S.NZ), np.int8)
    w[:, :floor, :] = S.SOLID
    if fn: fn(w)
    wp = np.pad(w, ((0, 0), (S.PAD, S.PAD), (0, 0)), constant_values=S.AIR)
    wp = np.pad(wp, ((S.PAD, S.PAD), (0, 0), (S.PAD, S.PAD)), constant_values=S.ROCK)
    return jnp.asarray(wp)


def state(w, pos, tgt=(30, FLOOR, 30), box=(1, 0, 1, 0, 1, 0), pack=10, bots=None, near=2, near_y=1):
    b = np.full((S.MAX_BOTS, 3), -1000, np.int32)
    for i, p in enumerate(bots or []): b[i] = p
    return S.State(w=w, box=jnp.array(box, jnp.int32), pos=jnp.array(pos, jnp.int32), tgt=jnp.array(tgt, jnp.int32), near=jnp.int32(near), near_y=jnp.int32(near_y),
                   pack=jnp.int32(pack), hp=jnp.float32(20), t=jnp.int32(0), since=jnp.int32(0), best=jnp.float32(99), visits=jnp.zeros((S.NX, S.NZ), jnp.int32),
                   bots=jnp.array(b), key=jax.random.PRNGKey(0), last=jnp.int32(S.A_WAIT), pert_t=jnp.int32(-1), perturbed=jnp.asarray(False), scen=jnp.int32(0))


def do(s, a):
    r = jax.tree_util.tree_map(lambda x: x[a], S.all_results(s))
    return r, S.apply_edits(s.w, r.edits)


class Rules(unittest.TestCase):
    def test_walk_flat_up_drop(self):
        w = world(lambda w: (w.__setitem__((11, FLOOR, 10), S.SOLID), w.__setitem__((9, FLOOR - 1, 10), S.AIR), w.__setitem__((9, FLOOR - 2, 10), S.AIR)))
        s = state(w, (10, FLOOR, 10))
        r, _ = do(s, S.A_WALK + 2)            # south: flat
        self.assertTrue(bool(r.valid)); self.assertEqual(list(map(int, r.pos)), [10, FLOOR, 11])
        r, _ = do(s, S.A_WALK + 1)            # east: step up 1
        self.assertTrue(bool(r.valid)); self.assertEqual(list(map(int, r.pos)), [11, FLOOR + 1, 10])
        r, _ = do(s, S.A_WALK + 3)            # west: a drop of 2
        self.assertTrue(bool(r.valid)); self.assertEqual(list(map(int, r.pos)), [9, FLOOR - 2, 10])

    def test_walk_off_a_cliff_is_invalid(self):
        def f(w): w[11, :FLOOR, 10] = S.AIR
        s = state(world(f), (10, FLOOR, 10))
        r, _ = do(s, S.A_WALK + 1)
        self.assertFalse(bool(r.valid))

    def test_bridge_then_walk(self):
        def f(w): w[11, :FLOOR, 10] = S.AIR
        s = state(world(f), (10, FLOOR, 10))
        r, w2 = do(s, S.A_BRIDGE + 1)
        self.assertTrue(bool(r.valid)); self.assertEqual(int(S.cell(w2, 11, FLOOR - 1, 10)), S.OWN); self.assertEqual(int(r.dpack), -1)
        self.assertEqual(list(map(int, r.pos)), [11, FLOOR, 10], 'the bridge move steps onto the new block')
        s2 = s._replace(w=w2, pack=s.pack - 1, pos=r.pos)
        r2, _ = do(s2, S.A_WALK + 1)
        self.assertTrue(bool(r2.valid))
        s3 = state(world(f), (10, FLOOR, 10), pack=0)
        self.assertFalse(bool(do(s3, S.A_BRIDGE + 1)[0].valid))

    def test_pillar_and_descend(self):
        s = state(world(), (10, FLOOR, 10))
        r, w2 = do(s, S.A_PILLAR)
        self.assertTrue(bool(r.valid)); self.assertEqual(int(r.pos[1]), FLOOR + 1); self.assertEqual(int(S.cell(w2, 10, FLOOR, 10)), S.OWN)
        # descend needs air two and three under the block the bot stands on
        def f(w): w[10, FLOOR - 4:FLOOR - 1, 10] = S.AIR; w[10, FLOOR - 1, 10] = S.OWN
        s2 = state(world(f), (10, FLOOR, 10))
        r, w3 = do(s2, S.A_DESCEND)
        self.assertTrue(bool(r.valid)); self.assertEqual(int(r.pos[1]), FLOOR - 1)
        self.assertEqual(int(S.cell(w3, 10, FLOOR - 1, 10)), S.AIR); self.assertEqual(int(S.cell(w3, 10, FLOOR - 2, 10)), S.OWN)
        self.assertFalse(bool(do(state(world(), (10, FLOOR, 10)), S.A_DESCEND)[0].valid))

    def test_dig_only_inside_the_pit_or_own_blocks(self):
        def f(w): w[11, FLOOR, 10] = S.SOLID; w[11, FLOOR + 1, 10] = S.SOLID
        out = state(world(f), (10, FLOOR, 10))
        self.assertFalse(bool(do(out, S.A_DIG + 1)[0].valid))
        inside = state(world(f), (10, FLOOR, 10), box=(5, 15, 0, 20, 5, 15))
        r, w2 = do(inside, S.A_DIG + 1)
        self.assertTrue(bool(r.valid)); self.assertEqual(int(S.cell(w2, 11, FLOOR, 10)), S.AIR)

    def test_fall_damage(self):
        def f(w): w[10, 0:FLOOR, 10] = S.SOLID; w[10, FLOOR - 1, 10] = S.OWN
        w = world(lambda w: (w.__setitem__((slice(None), slice(0, 12), slice(None)), S.SOLID), w.__setitem__((10, slice(7, 12), 10), S.AIR)))
        ny, dead, dmg = S.fall_from(w, 10, 20, 10)
        self.assertEqual(int(ny), 7); self.assertAlmostEqual(float(dmg), 10.0); self.assertFalse(bool(dead))
        wv = world(lambda w: w.__setitem__((10, slice(0, FLOOR), 10), S.AIR))
        ny, dead, dmg = S.fall_from(wv, 10, FLOOR, 10)
        self.assertTrue(bool(dead))

    def test_other_bots_block_cells(self):
        s = state(world(), (10, FLOOR, 10), bots=[(11, FLOOR, 10)])
        self.assertFalse(bool(do(s, S.A_WALK + 1)[0].valid))
        self.assertTrue(bool(do(s, S.A_WALK + 3)[0].valid))

    def test_mask_always_has_wait(self):
        s = state(world(), (10, FLOOR, 10))
        self.assertTrue(bool(S.valid_mask(s)[S.A_WAIT]))

    def test_step_arrival_and_reward(self):
        s = state(world(), (10, FLOOR, 10), tgt=(10, FLOOR, 13), near=1)
        s2, out = S.step(s, jnp.int32(S.A_WALK + 2), 0.0, 0.0)
        self.assertFalse(bool(out.done))
        s3, out = S.step(s2, jnp.int32(S.A_WALK + 2), 0.0, 0.0)
        self.assertTrue(bool(out.arrived)); self.assertGreater(float(out.reward), 0.9)

    def test_death_by_lava_fall(self):
        def f(w): w[10, 0:FLOOR, 10] = S.AIR; w[10, 0, 10] = S.LAVA
        ny, dead, dmg = S.fall_from(world(f), 10, FLOOR, 10)
        self.assertTrue(bool(dead))


class Generators(unittest.TestCase):
    def test_every_scenario_starts_on_ground_and_has_a_target(self):
        bank = G.make_bank(jax.random.PRNGKey(3), jnp.array([i % G.NSCEN for i in range(28)], jnp.int32))
        for j in range(28):
            w = bank['w'][j]
            self.assertTrue(bool(S.standable(w, *[int(v) for v in bank['pos'][j]])), G.SCEN_NAMES[j % 7])
            self.assertTrue(bool(S.standable(w, *[int(v) for v in bank['tgt'][j]])), G.SCEN_NAMES[j % 7])

    def test_observation_shape_and_range(self):
        s = state(world(), (10, FLOOR, 10))
        o = O.observe(s)
        self.assertEqual(o.shape, (O.OBS_DIM,)); self.assertTrue(bool(jnp.all(jnp.isfinite(o))))


if __name__ == '__main__':
    unittest.main()
