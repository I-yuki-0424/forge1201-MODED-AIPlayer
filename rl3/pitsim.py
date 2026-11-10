"""Open-pit expert simulator (docs/proposed/PIT-EXPERT-v1.md): ONE chunk of a pit, a band of two layers plus the leftovers standing above it.
The policy chooses where to STAND next (a column of the chunk) and how deep to dig from there (1 or 2 layers); everything within reach of the arm is then dug.
Walking follows the live planner (step up 1, drop up to 3), the reach is the live one (4.05 blocks from the eye, blind digging), time costs are the measured ones.
Reward = minus the time spent: digging is the same for every plan, so what is learned is moving less, not digging itself into a hole (a bot that cannot walk on is 'stuck': it pays the pillar escape),
and leaving nothing behind (a leftover costs a repair pass later)."""
from typing import NamedTuple
import jax
import jax.numpy as jnp

N = 16                      # a chunk
H = 6                       # cells high: y 0..1 the band to dig, y 2..5 open space with leftovers
BAND = 2
AIR, SOLID, ROCK, WATER = 0, 1, 2, 3
R2 = 4.05 ** 2
EYE = 1.62
K = 64                      # candidates offered to the policy (best by dig count and distance)
ND = 2                      # dig depths offered: 1 layer, 2 layers
NF = 14
NG = 8
MAX_STATIONS = 40
INF = 1e6
# measured / estimated live costs, seconds
T_DIG, T_WALK, T_MOVE, T_STATION, T_WATER, T_STUCK, T_LEFT = 0.6, 0.28, 1.0, 1.5, 4.0, 30.0, 10.0


class PState(NamedTuple):
    m: jnp.ndarray          # int8 [N, N, H]
    bot: jnp.ndarray        # int32 [2] column
    t: jnp.ndarray          # int32 stations so far
    key: jnp.ndarray
    last_n: jnp.ndarray     # float32 cells dug by the last station


def heights(m):
    """Feet level of every column: the cell above its top block (0 on the floor)."""
    nonair = m != AIR
    y = jnp.arange(H)[None, None, :]
    top = jnp.max(jnp.where(nonair, y, -1), axis=2)
    return top + 1, top


def standable_cols(m):
    f, top = heights(m)
    topcode = jnp.take_along_axis(m, jnp.clip(top, 0, H - 1)[:, :, None], axis=2)[:, :, 0]
    ok = (top < 0) | ((topcode != WATER))
    return f, ok


def reach(f, ok, bot):
    """Walking distance (blocks) from the bot's column over the heightfield: step up 1, drop up to 3, on standable columns."""
    d = jnp.full((N, N), INF).at[bot[0], bot[1]].set(0.0)
    def body(_, d):
        best = d
        for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nb = jnp.roll(d, (dx, dz), (0, 1))
            fn = jnp.roll(f, (dx, dz), (0, 1)); okn = jnp.roll(ok, (dx, dz), (0, 1))
            # wrap-around guards
            xs = jnp.arange(N)[:, None]; zs = jnp.arange(N)[None, :]
            inside = ((xs - dx >= 0) & (xs - dx < N) & (zs - dz >= 0) & (zs - dz < N))
            step = (f - fn <= 1) & (fn - f <= 3) & ok & okn & inside
            best = jnp.minimum(best, jnp.where(step, nb + 1.0, INF))
        return best
    return jax.lax.fori_loop(0, 40, body, d)


XX, ZZ, YY = jnp.meshgrid(jnp.arange(N), jnp.arange(N), jnp.arange(H), indexing='ij')


def dig_mask(m, x, z, f, depth):
    """Cells the arm digs from column (x, z) (feet level f): inside the sphere of reach, in the band or above (leftovers), not deeper than `depth` layers below the surface, never the block under the feet."""
    dy = YY - f - 1.0 - 0.12 + 0.0          # centre of the cell (y + 0.5) minus the eye (f + 1.62)
    d2 = (XX - x) ** 2 + (ZZ - z) ** 2 + dy ** 2
    floor = (XX == x) & (ZZ == z) & (YY == f - 1)
    return (d2 <= R2) & ((m == SOLID) | (m == WATER)) & (YY >= f - depth) & ~floor


def candidate_table(m, bot):
    """For every column and depth: dig count, water count, walking distance. Returns dict of [N, N, ND] arrays (+ f, ok, dist)."""
    f, ok = standable_cols(m)
    dist = reach(f, ok, bot)
    def one(x, z, depth):
        mk = dig_mask(m, x, z, f[x, z], depth)
        return jnp.sum(mk & (m == SOLID)), jnp.sum(mk & (m == WATER))
    xs, zs, ds = jnp.meshgrid(jnp.arange(N), jnp.arange(N), jnp.arange(1, ND + 1), indexing='ij')
    nd, nw = jax.vmap(jax.vmap(jax.vmap(one)))(xs, zs, ds)
    return dict(f=f, ok=ok, dist=dist, nd=nd, nw=nw)


def band_left(m):
    """Cells still to dig: the band and the leftovers above it (solid or water), not rock."""
    return jnp.sum((m == SOLID) | (m == WATER))


def observe(s):
    """Returns (features [K, NF], mask [K], idx [K] flat candidate index (column * ND + depth - 1), glob [NG])."""
    m = s.m
    tb = candidate_table(m, s.bot)
    f, dist = tb['f'], tb['dist']
    nd = tb['nd'].astype(jnp.float32) + tb['nw'].astype(jnp.float32)
    valid = (tb['nd'] + tb['nw'] > 0) & (dist < INF / 2)[:, :, None] & tb['ok'][:, :, None]
    score = jnp.where(valid, nd - 0.35 * dist[:, :, None], -1e9)
    flat = score.reshape(-1)
    top_s, idx = jax.lax.top_k(flat, K)
    mask = top_s > -1e8
    x = idx // (N * ND); z = (idx // ND) % N; dd = idx % ND
    left = band_left(m).astype(jnp.float32)
    maxnd = jnp.maximum(1.0, jnp.max(nd))
    fb = f[s.bot[0], s.bot[1]]
    feats = []
    nd_k = nd.reshape(-1)[idx]
    nw_k = tb['nw'].reshape(-1)[idx].astype(jnp.float32)
    dist_k = dist[x, z]
    fk = f[x, z]
    cols = jnp.stack([
        nd_k / 48.0, nw_k / 8.0, jnp.minimum(dist_k, 40.0) / 40.0, (fk - fb) / 3.0, nd_k / maxnd, dd.astype(jnp.float32),
        jnp.minimum(jnp.minimum(x, N - 1 - x), jnp.minimum(z, N - 1 - z)) / 8.0, left / 512.0 * jnp.ones(K), ((x == s.bot[0]) & (z == s.bot[1])).astype(jnp.float32),
        fk / 6.0, (x - 7.5) / 8.0, (z - 7.5) / 8.0, jnp.where(dd == 1, nd_k - tb['nd'].reshape(-1)[jnp.clip(idx - 1, 0, None)], 0.0) / 24.0, jnp.ones(K)], axis=1)
    glob = jnp.stack([left / 512.0, s.t / MAX_STATIONS, jnp.sum(valid) / 512.0, fb / 6.0, (s.bot[0] - 7.5) / 8.0, (s.bot[1] - 7.5) / 8.0, s.last_n / 48.0, jnp.max(nd) / 48.0])
    return cols.astype(jnp.float32), mask, idx, glob.astype(jnp.float32)


class POut(NamedTuple):
    reward: jnp.ndarray
    done: jnp.ndarray
    dug: jnp.ndarray
    moved: jnp.ndarray
    stuck: jnp.ndarray
    left: jnp.ndarray


def step(s, a, idx):
    """Take candidate `a` (index into the K offered, `idx` their flat ids). Returns (state, POut)."""
    k0, k1 = jax.random.split(s.key)
    m = s.m
    flat = idx[a]
    x = flat // (N * ND); z = (flat // ND) % N; depth = flat % ND + 1
    f, ok = standable_cols(m)
    dist = reach(f, ok, s.bot)
    d = dist[x, z]
    mk = dig_mask(m, x, z, f[x, z], depth)
    n_solid = jnp.sum(mk & (m == SOLID)).astype(jnp.float32); n_water = jnp.sum(mk & (m == WATER)).astype(jnp.float32)
    m2 = jnp.where(mk, jnp.int8(AIR), m)
    moved = (x != s.bot[0]) | (z != s.bot[1])
    t_cost = T_DIG * n_solid + T_WATER * n_water + T_STATION + jnp.where(moved, T_WALK * d + T_MOVE, 0.0)
    # after digging: can the bot walk on? stuck = cells remain but no column with work is reachable from where it stands
    nb = jnp.stack([x, z])
    tb = candidate_table(m2, nb)
    work = (tb['nd'] + tb['nw'] > 0) & (tb['dist'] < INF / 2)[:, :, None] & tb['ok'][:, :, None]
    left = band_left(m2)
    stuck = (left > 0) & ~jnp.any(work)
    # the escape: pillar up (T_STUCK), the bot is put on the highest standable column with work (or anywhere)
    f2, ok2 = standable_cols(m2)
    nbot = jnp.where(stuck, jnp.stack([jnp.argmax(jnp.max(f2, axis=1)), jnp.argmax(jnp.max(f2, axis=0))]).astype(jnp.int32), nb.astype(jnp.int32))
    t_cost = t_cost + jnp.where(stuck, T_STUCK, 0.0)
    t = s.t + 1
    finished = left == 0
    # a bot that cannot reach any cell even after the escape (rock around them) ends the episode with leftovers
    done = finished | (t >= MAX_STATIONS)
    reward = -t_cost / 10.0 - jnp.where(done, T_LEFT * left.astype(jnp.float32) / 10.0, 0.0)
    ns = PState(m2, nbot, t, k0, n_solid + n_water)
    return ns, POut(reward, done, n_solid + n_water, moved.astype(jnp.float32), stuck.astype(jnp.float32), left.astype(jnp.float32))


def gen(key):
    """One chunk to dig: fresh (a full band) or half dug by earlier units (rectangles already open, columns of leftovers standing above the band), with pockets of air, water and rock."""
    ks = jax.random.split(key, 12)
    xs, zs = jnp.arange(N)[:, None, None], jnp.arange(N)[None, :, None]
    ys = jnp.arange(H)[None, None, :]
    m = jnp.where(ys < BAND, SOLID, AIR).astype(jnp.int8) * jnp.ones((N, N, H), jnp.int8)
    fresh = jax.random.uniform(ks[0]) < 0.45
    # open rectangles (earlier units dug them): 0..3 of them, 3..10 wide, one or both layers
    for i in range(3):
        k = jax.random.split(ks[1 + i], 5)
        on = (jax.random.uniform(k[0]) < 0.6) & ~fresh
        x0, z0 = jax.random.randint(k[1], (), 0, N - 3), jax.random.randint(k[2], (), 0, N - 3)
        w, d = jax.random.randint(k[3], (), 3, 11), jax.random.randint(k[4], (), 3, 11)
        both = jax.random.uniform(k[0]) < 0.5
        inside = (xs >= x0) & (xs < x0 + w) & (zs >= z0) & (zs < z0 + d)
        open_y = jnp.where(both, ys < BAND, ys == BAND - 1)
        m = jnp.where(on & inside & open_y, jnp.int8(AIR), m)
    # leftovers standing above the band: columns of 1..4 cells
    col = (jax.random.uniform(ks[5], (N, N, 1)) < jnp.where(fresh, 0.0, 0.05))
    hh = jax.random.randint(ks[6], (N, N, 1), 1, 5)
    m = jnp.where(col & (ys >= BAND) & (ys < BAND + hh), jnp.int8(SOLID), m)
    # pockets inside the band
    r = jax.random.uniform(ks[7], (N, N, H))
    inband = ys < BAND
    m = jnp.where(inband & (r < 0.02) & (m == SOLID), jnp.int8(AIR), m)
    m = jnp.where(inband & (r >= 0.02) & (r < 0.03) & (m == SOLID), jnp.int8(WATER), m)
    m = jnp.where(inband & (r >= 0.03) & (r < 0.04) & (m == SOLID), jnp.int8(ROCK), m)
    # the bot enters on the rim: the highest edge column (it comes from the surface; a random one among equals, water does not count)
    f, ok = standable_cols(m)
    xs2, zs2 = jnp.meshgrid(jnp.arange(N), jnp.arange(N), indexing='ij')
    edge = (xs2 == 0) | (xs2 == N - 1) | (zs2 == 0) | (zs2 == N - 1)
    score = jnp.where(edge & ok, f.astype(jnp.float32) + jax.random.uniform(ks[8], (N, N)) * 0.5, -1.0)
    flat = jnp.argmax(score)
    bx, bz = flat // N, flat % N
    return PState(m, jnp.stack([bx, bz]).astype(jnp.int32), jnp.int32(0), ks[10], jnp.float32(0))
