"""Scenario generators for the movement simulator (RL-MOVE-v3, "Scenario generator"): the failure geometry of the live logs at cell level.
 0 column   a leftover column over a dug pit: the bot on top, the work 3-24 levels below
 1 gap      a ledge across a gap of void, 3-14 blocks
 2 end      the End entrance: a small platform, a void, a big island 18-30 blocks away and up to 12 levels above or below
 3 rim      an open pit with walls (no road): the bot at the rim, the work on the front layer
 4 wall     natural ground with a wall across and one gap in it
 5 lake     natural ground with a lake across (bridge it)
 6 cliff    natural ground that rises 4-10 levels (pillar up it)
A crowd (other bots, other bots' scaffolding) is added to a share of the worlds; a random mirror/transpose makes the orientation irrelevant.
"""
import jax
import jax.numpy as jnp
from . import sim as S
from .sim import NX, NY, NZ, PAD, AIR, SOLID, WATER, OTHER, ROCK, MAX_BOTS

NSCEN = 7
SCEN_NAMES = ['column', 'gap', 'end', 'rim', 'wall', 'lake', 'cliff']
X, Y, Z = jnp.meshgrid(jnp.arange(NX), jnp.arange(NY), jnp.arange(NZ), indexing='ij')
NOBOX = jnp.array([1, 0, 1, 0, 1, 0], jnp.int32)


def ri(k, lo, hi):          # uniform integer in [lo, hi]
    return jax.random.randint(k, (), lo, hi + 1)


def pack_out(w, box, pos, tgt, near, near_y, pack):
    return dict(w=w.astype(jnp.int8), box=jnp.asarray(box, jnp.int32), pos=jnp.asarray(pos, jnp.int32), tgt=jnp.asarray(tgt, jnp.int32),
                near=jnp.asarray(near, jnp.int32), near_y=jnp.asarray(near_y, jnp.int32), pack=jnp.asarray(pack, jnp.int32))


def g_column(key):
    k = jax.random.split(key, 14)
    wd, dp = ri(k[0], 20, 32), ri(k[1], 20, 32)
    px0, pz0 = ri(k[2], 2, NX - wd - 2), ri(k[3], 2, NZ - dp - 2)
    px1, pz1 = px0 + wd - 1, pz0 + dp - 1
    depth, yf = ri(k[4], 6, 24), ri(k[5], 2, 5)
    yr = yf + depth
    inbox = (X >= px0) & (X <= px1) & (Z >= pz0) & (Z <= pz1)
    w = jnp.where(((Y <= yr) & ~inbox) | (Y < yf), SOLID, AIR)
    cx, cz = ri(k[6], px0 + 4, px1 - 4), ri(k[7], pz0 + 4, pz1 - 4)
    ytop = jnp.minimum(yf + ri(k[8], 4, depth) - 1, yr)
    w = jnp.where((X == cx) & (Z == cz) & (Y >= yf) & (Y <= ytop), SOLID, w)
    clutter = inbox & (Y >= yf) & (Y < yf + 3) & (jax.random.uniform(k[9], X.shape) < 0.02)
    w = jnp.where(clutter, SOLID, w)
    ang = jax.random.uniform(k[10]) * 2 * jnp.pi; r = ri(k[11], 2, 12).astype(jnp.float32)
    tx = jnp.clip(cx + jnp.round(r * jnp.cos(ang)).astype(jnp.int32), px0 + 1, px1 - 1)
    tz = jnp.clip(cz + jnp.round(r * jnp.sin(ang)).astype(jnp.int32), pz0 + 1, pz1 - 1)
    w = jnp.where((X == tx) & (Z == tz) & (Y >= yf) & (Y <= yf + 1), AIR, w)
    return pack_out(w, [px0, px1, yf, yr + 2, pz0, pz1], [cx, ytop + 1, cz], [tx, yf, tz], ri(k[12], 1, 3), ri(k[13], 1, 3), ri(k[13], 3, 30))


def g_gap(key):
    k = jax.random.split(key, 12)
    gap = ri(k[0], 3, 14)
    ya = ri(k[1], 8, 20); yb = jnp.clip(ya + ri(k[2], -2, 2), 5, 24)
    xa = ri(k[3], 5, 8); xb0 = xa + gap + 1
    z0, wd = ri(k[4], 4, 12), ri(k[5], 8, 16)
    z1 = z0 + wd
    ln = ri(k[6], 7, 12)
    inz = (Z >= z0) & (Z <= z1)
    a = (X <= xa) & inz & (Y >= ya - 3) & (Y < ya)
    b = (X >= xb0) & (X <= xb0 + ln) & inz & (Y >= yb - 3) & (Y < yb)
    w = jnp.where(a | b, SOLID, AIR)
    zm = (z0 + z1) // 2
    tx = xb0 + ri(k[7], 1, 5); tz = jnp.clip(zm + ri(k[8], -3, 3), z0 + 1, z1 - 1)
    return pack_out(w, NOBOX, [xa - 1, ya, zm], [tx, yb, tz], ri(k[9], 1, 3), ri(k[10], 1, 3), ri(k[11], gap // 2 + 2, 40))


def g_end(key):
    k = jax.random.split(key, 14)
    xp, zp = ri(k[0], 4, 7), ri(k[1], 14, 26)
    yp = ri(k[2], 10, 20)
    rx, rz = ri(k[3], 5, 8), ri(k[4], 5, 9)
    xi = xp + ri(k[5], 18, 24); zi = jnp.clip(zp + ri(k[6], -6, 6), rz + 2, NZ - rz - 3)
    yi = jnp.clip(yp + ri(k[7], -12, 10), 4, 27)
    plat = (jnp.abs(X - xp) <= 2) & (jnp.abs(Z - zp) <= 2) & (Y == yp - 1)
    ell = (((X - xi) / rx.astype(jnp.float32)) ** 2 + ((Z - zi) / rz.astype(jnp.float32)) ** 2 <= 1.0) & (Y >= yi - 3) & (Y < yi)
    ragged = ell & (jax.random.uniform(k[8], X.shape) < 0.05) & (Y == yi - 1)
    w = jnp.where(plat, ROCK, jnp.where(ell & ~ragged, SOLID, AIR))
    tx = jnp.clip(xi + ri(k[9], -rx + 2, rx - 2), 0, NX - 1); tz = jnp.clip(zi + ri(k[10], -rz + 2, rz - 2), 0, NZ - 1)
    w = jnp.where((X == tx) & (Z == tz) & (Y == yi - 1), SOLID, w)
    return pack_out(w, NOBOX, [xp, yp, zp], [tx, yi, tz], ri(k[11], 1, 3), ri(k[12], 1, 4), ri(k[13], 16, 64))


def g_rim(key):
    k = jax.random.split(key, 14)
    wd, dp = ri(k[0], 18, 30), ri(k[1], 18, 30)
    px0, pz0 = ri(k[2], 4, NX - wd - 3), ri(k[3], 2, NZ - dp - 2)
    px1, pz1 = px0 + wd - 1, pz0 + dp - 1
    depth = ri(k[4], 5, 24); ly = ri(k[5], 2, 4) + 1
    yr = ly + depth
    inbox = (X >= px0) & (X <= px1) & (Z >= pz0) & (Z <= pz1)
    w = jnp.where(((Y <= yr) & ~inbox) | (inbox & (Y <= ly)), SOLID, AIR)
    left = inbox & (Y > ly) & (Y <= ly + 3) & (jax.random.uniform(k[6], X.shape) < 0.03)
    w = jnp.where(left, SOLID, w)
    tx, tz = ri(k[7], px0 + 3, px1 - 3), ri(k[8], pz0 + 3, pz1 - 3)
    w = jnp.where((X == tx) & (Z == tz) & (Y > ly) & (Y <= ly + 2), AIR, w)
    bx, bz = px0 - ri(k[9], 1, 3), ri(k[10], pz0 + 2, pz1 - 2)
    return pack_out(w, [px0, px1, 1, yr + 3, pz0, pz1], [bx, yr + 1, bz], [tx, ly + 1, tz], ri(k[11], 1, 3), ri(k[12], 1, 3), ri(k[13], 4, 40))


def _terrain(k):
    hb = ri(k[0], 8, 12)
    a = jax.random.uniform(k[1], (4,))
    wx, wz = 4.0 + 4.0 * a[0], 4.0 + 4.0 * a[1]
    h = hb + jnp.floor(1.4 * jnp.sin(X[:, 0, :] / wx + 6.28 * a[2]) + 1.4 * jnp.sin(Z[:, 0, :] / wz + 6.28 * a[3])).astype(jnp.int32)   # [NX, NZ]
    return h


def _terrain_out(k, w, h, box=NOBOX, tz_range=8):
    sx = ri(k[2], 3, 6); sz = ri(k[3], 8, 30)
    tx = ri(k[4], 33, 37); tz = jnp.clip(sz + ri(k[5], -tz_range, tz_range), 3, NZ - 4)
    return sx, sz, tx, tz


def g_wall(key):
    k = jax.random.split(key, 14)
    h = _terrain(k)
    w = jnp.where(Y < h[:, None, :], SOLID, AIR)
    sx, sz, tx, tz = _terrain_out(k, w, h)
    xw, th = ri(k[6], 17, 24), ri(k[7], 1, 3)
    wh = ri(k[8], 6, 12)
    gz = jnp.clip(sz + ri(k[9], -14, 14), 3, NZ - 5); gw = ri(k[10], 2, 3)
    wall = (X >= xw) & (X < xw + th) & (Y < h[:, None, :] + wh) & ~((Z >= gz) & (Z < gz + gw))
    w = jnp.where(wall, ROCK, w)
    return pack_out(w, NOBOX, [sx, h[sx, sz], sz], [tx, h[tx, tz], tz], ri(k[11], 1, 3), ri(k[12], 1, 3), ri(k[13], 4, 40))


def g_lake(key):
    k = jax.random.split(key, 14)
    h = _terrain(k)
    sx, sz, tx, tz = _terrain_out(k, None, h)
    xl, wl = ri(k[6], 14, 20), ri(k[7], 5, 12)
    band = (X >= xl) & (X < xl + wl)
    w = jnp.where(Y < h[:, None, :], SOLID, AIR)
    w = jnp.where(band & (Y >= h[:, None, :] - 3) & (Y < h[:, None, :]), WATER, w)
    return pack_out(w, NOBOX, [sx, h[sx, sz], sz], [tx, h[tx, tz], tz], ri(k[8], 1, 3), ri(k[9], 1, 3), ri(k[10], wl // 2 + 2, 40))


def g_cliff(key):
    k = jax.random.split(key, 14)
    h0 = _terrain(k)
    xc, hh = ri(k[6], 16, 24), ri(k[7], 4, 10)
    h = h0 + jnp.where(jnp.arange(NX)[:, None] >= xc, hh, 0)
    sx, sz, tx, tz = _terrain_out(k, None, h)
    w = jnp.where(Y < h[:, None, :], SOLID, AIR)
    return pack_out(w, NOBOX, [sx, h[sx, sz], sz], [tx, h[tx, tz], tz], ri(k[8], 1, 3), ri(k[9], 2, 4), ri(k[10], hh + 4, 50))


GENS = [g_column, g_gap, g_end, g_rim, g_wall, g_lake, g_cliff]


def crowd(key, d):
    """Other bots on standable cells and other bots' scaffolding towers (a share of the worlds)."""
    k = jax.random.split(key, 6)
    n_bots = ri(k[0], 2, MAX_BOTS)
    cx = jax.random.randint(k[1], (96,), 1, NX - 1); cz = jax.random.randint(k[2], (96,), 1, NZ - 1); cy = jax.random.randint(k[3], (96,), 2, NY - 4)
    ok = jax.vmap(lambda a, b, c: S.standable(jnp.pad(d['w'], PAD), a, b, c))(cx, cy, cz)
    far = (jnp.abs(cx - d['pos'][0]) + jnp.abs(cz - d['pos'][2]) > 2) & (jnp.abs(cx - d['tgt'][0]) + jnp.abs(cz - d['tgt'][2]) > 2)
    ok = ok & far
    order = jnp.argsort(~ok, stable=True)
    sel = order[:MAX_BOTS]
    use = ok[sel] & (jnp.arange(MAX_BOTS) < n_bots)
    bots = jnp.where(use[:, None], jnp.stack([cx[sel], cy[sel], cz[sel]], axis=1), -1000)
    # towers: OTHER blocks on 4-10 of the standable cells (height 1-5)
    w = d['w']
    n_tow = ri(k[4], 4, 10)
    sel2 = order[MAX_BOTS:MAX_BOTS + 10]
    for i in range(10):
        use_t = ok[sel2[i]] & (i < n_tow)
        hh = ri(jax.random.fold_in(k[5], i), 1, 5)
        col = (X == cx[sel2[i]]) & (Z == cz[sel2[i]]) & (Y >= cy[sel2[i]]) & (Y < cy[sel2[i]] + hh)
        w = jnp.where(use_t & col & (w == AIR), jnp.int8(OTHER), w)
    return w, bots.astype(jnp.int32)


def finish(key, d, scen, p_crowd=0.35):
    """Crowd, random mirror/transpose, padding. Returns the bank entry."""
    k = jax.random.split(key, 5)
    w, bots = d['w'], jnp.full((MAX_BOTS, 3), -1000, jnp.int32)
    has = jax.random.uniform(k[0]) < p_crowd
    w2, bots2 = crowd(k[1], d)
    w = jnp.where(has, w2, w); bots = jnp.where(has, bots2, bots)
    pos, tgt, box = d['pos'], d['tgt'], d['box']
    # mirror x, mirror z, transpose
    def mx(a): return jnp.stack([NX - 1 - a[0], a[1], a[2]])
    def mz(a): return jnp.stack([a[0], a[1], NZ - 1 - a[2]])
    def tr(a): return jnp.stack([a[2], a[1], a[0]])
    def mbox_x(b): return jnp.stack([NX - 1 - b[1], NX - 1 - b[0], b[2], b[3], b[4], b[5]])
    def mbox_z(b): return jnp.stack([b[0], b[1], b[2], b[3], NZ - 1 - b[5], NZ - 1 - b[4]])
    def tbox(b): return jnp.stack([b[4], b[5], b[2], b[3], b[0], b[1]])
    f = jax.random.bernoulli(k[2], 0.5, (3,))
    empty = box[1] < box[0]
    w = jnp.where(f[0], w[::-1], w); pos = jnp.where(f[0], mx(pos), pos); tgt = jnp.where(f[0], mx(tgt), tgt); box = jnp.where(f[0] & ~empty, mbox_x(box), box); bots = jnp.where(f[0] & (bots[:, :1] > -500), jnp.stack([NX - 1 - bots[:, 0], bots[:, 1], bots[:, 2]], 1), bots)
    w = jnp.where(f[1], w[:, :, ::-1], w); pos = jnp.where(f[1], mz(pos), pos); tgt = jnp.where(f[1], mz(tgt), tgt); box = jnp.where(f[1] & ~empty, mbox_z(box), box); bots = jnp.where(f[1] & (bots[:, :1] > -500), jnp.stack([bots[:, 0], bots[:, 1], NZ - 1 - bots[:, 2]], 1), bots)
    w = jnp.where(f[2], jnp.transpose(w, (2, 1, 0)), w); pos = jnp.where(f[2], tr(pos), pos); tgt = jnp.where(f[2], tr(tgt), tgt); box = jnp.where(f[2] & ~empty, tbox(box), box); bots = jnp.where(f[2] & (bots[:, :1] > -500), jnp.stack([bots[:, 2], bots[:, 1], bots[:, 0]], 1), bots)
    wp = jnp.pad(w, ((0, 0), (PAD, PAD), (0, 0)), constant_values=AIR)
    wp = jnp.pad(wp, ((PAD, PAD), (0, 0), (PAD, PAD)), constant_values=ROCK)
    return dict(w=wp.astype(jnp.int8), box=box, pos=pos, tgt=tgt, near=d['near'], near_y=d['near_y'], pack=d['pack'], bots=bots, scen=jnp.asarray(scen, jnp.int32))


def make_one(key, scen, p_crowd=0.35):
    k1, k2 = jax.random.split(key)
    d = jax.lax.switch(scen, GENS, k1)
    return finish(k2, d, scen, p_crowd)


def make_bank(key, scens, p_crowd=0.35):
    """A bank of worlds, one per entry of `scens` (int array)."""
    keys = jax.random.split(key, scens.shape[0])
    return jax.vmap(lambda k, sc: make_one(k, sc, p_crowd))(keys, scens)


def state_from(sample, key, p_pert=0.0):
    k1, k2, k3 = jax.random.split(key, 3)
    t = jax.random.randint(k1, (), 8, 60)
    pert_t = jnp.where(jax.random.uniform(k2) < p_pert, t, -1)
    best = S.dist3(sample['pos'], sample['tgt'])
    return S.State(w=sample['w'], box=sample['box'], pos=sample['pos'], tgt=sample['tgt'], near=sample['near'], near_y=sample['near_y'], pack=sample['pack'],
                   hp=jnp.float32(S.MAX_HP), t=jnp.int32(0), since=jnp.int32(0), best=best, visits=jnp.zeros((NX, NZ), jnp.int32).at[sample['pos'][0], sample['pos'][2]].add(1),
                   bots=sample['bots'], key=k3, last=jnp.int32(S.A_WAIT), pert_t=pert_t.astype(jnp.int32), perturbed=jnp.asarray(False), scen=sample['scen'])
