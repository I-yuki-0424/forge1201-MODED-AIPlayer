"""RL-MOVE-v3 simulator: one bot, one target, a voxel world at cell level (docs/proposed/RL-MOVE-v3.md).

Pure JAX, no Python control flow on traced values, so thousands of environments run under vmap/scan. The rules mirror what the live action layer can do
(src/skills/planner.js walk/step-up-1/drop-up-to-3, src/work/bot/{bridge,moves}.js bridge/pillar/descend, blind mine/place): a model of the cell-level physics,
not of the engine. Everything the policy sees comes from `obs.py` and is rebuilt identically in JS (src/experts/move3/obs.js; golden file tests/golden_move3.json).
"""
from typing import NamedTuple
import jax
import jax.numpy as jnp

NX, NY, NZ = 40, 32, 40            # the playable grid; the world array is padded by PAD on every side
PAD = 4
AIR, SOLID, WATER, LAVA, OWN, OTHER, ROCK, PART = 0, 1, 2, 3, 4, 5, 6, 7   # ROCK: solid that is never dug (obsidian, bedrock, the edge of the grid); PART: a partial block (slab, fence): in the way, no floor
DIRS = ((0, -1), (1, 0), (0, 1), (-1, 0))                          # N E S W as (dx, dz)
A_WALK, A_BRIDGE, A_DIG = 0, 4, 8
A_PILLAR, A_DESCEND, A_DIGUP, A_DIGDOWN, A_UNLAY, A_WAIT, A_SIDESTEP = 12, 13, 14, 15, 16, 17, 18
NA = 19
ACTIONS = ['walk_n', 'walk_e', 'walk_s', 'walk_w', 'bridge_n', 'bridge_e', 'bridge_s', 'bridge_w', 'dig_n', 'dig_e', 'dig_s', 'dig_w',
           'pillar', 'descend', 'dig_up', 'dig_down', 'unlay', 'wait', 'sidestep']
HORIZON = 240
MAX_BOTS = 6
MAX_HP = 20.0
P_MOVE_OK, P_PLACE_OK, P_DIG_OK = 0.97, 0.95, 0.8                  # noise: the body stops off the cell centre, a missed placement, a dig that takes longer
PACK_CAP = 64
SH = (NX + 2 * PAD, NY + 2 * PAD, NZ + 2 * PAD)                    # padded world shape


class State(NamedTuple):
    w: jnp.ndarray          # int8 [SH] padded world
    box: jnp.ndarray        # int32 [6] x0 x1 y0 y1 z0 z1 inclusive: where natural blocks may be dug (the pit)
    pos: jnp.ndarray        # int32 [3] feet cell (unpadded)
    tgt: jnp.ndarray        # int32 [3]
    near: jnp.ndarray       # int32
    near_y: jnp.ndarray     # int32
    pack: jnp.ndarray       # int32 blocks in the pack
    hp: jnp.ndarray         # float32
    t: jnp.ndarray          # int32 decisions so far
    since: jnp.ndarray      # int32 decisions since the best distance improved
    best: jnp.ndarray       # float32 best distance so far
    visits: jnp.ndarray     # int32 [NX, NZ] times the bot stood in each column
    bots: jnp.ndarray       # int32 [MAX_BOTS, 3] other bots' feet cells (-1000 = none)
    key: jnp.ndarray        # PRNG key
    last: jnp.ndarray       # int32 last action
    pert_t: jnp.ndarray     # int32 decision at which the world hurts the bot (-1 none)
    perturbed: jnp.ndarray  # bool that has happened
    scen: jnp.ndarray       # int32 scenario id


def cell(w, x, y, z):
    return w[x + PAD, y + PAD, z + PAD]


def passable(c):
    return c == AIR


def solid(c):
    return (c == SOLID) | (c == OWN) | (c == OTHER) | (c == ROCK)


def standable(w, x, y, z):
    return passable(cell(w, x, y, z)) & passable(cell(w, x, y + 1, z)) & solid(cell(w, x, y - 1, z))


def in_box(box, x, y, z):
    return (x >= box[0]) & (x <= box[1]) & (y >= box[2]) & (y <= box[3]) & (z >= box[4]) & (z <= box[5])


def diggable(c, box, x, y, z):
    """A cell the bot may break: its own temporary blocks anywhere, natural blocks only inside the pit box."""
    return (c == OWN) | ((c == SOLID) & in_box(box, x, y, z))


def dist3(pos, tgt):
    d = (pos - tgt).astype(jnp.float32)
    return jnp.sqrt(d[0] ** 2 + d[2] ** 2 + (0.7 * d[1]) ** 2)


def arrived(pos, tgt, near, near_y):
    dh = jnp.hypot((pos[0] - tgt[0]).astype(jnp.float32), (pos[2] - tgt[2]).astype(jnp.float32))
    return (dh <= near) & (jnp.abs(pos[1] - tgt[1]) <= near_y)


def fall_from(w, x, y, z, col_air_at=None):
    """Land the bot falling from feet cell y in column x,z. Returns (landing y, dead, damage). `col_air_at`: a cell y treated as air (a block just broken)."""
    col = w[x + PAD, :, z + PAD]
    if col_air_at is not None:
        col = col.at[col_air_at + PAD].set(AIR)
    yp = jnp.arange(col.shape[0])
    below = yp < (y + PAD)
    blocking = below & (col != AIR) & (col != WATER)
    ymax = jnp.max(jnp.where(blocking, yp, -1))
    void = ymax < 0
    hit = col[jnp.clip(ymax, 0, col.shape[0] - 1)]
    lava = (~void) & (hit == LAVA)
    land = ymax + 1 - PAD
    dist = y - land
    wet = col[jnp.clip(ymax + 1, 0, col.shape[0] - 1)] == WATER
    dmg = jnp.where(wet, 0.0, jnp.maximum(0.0, dist - 3.0).astype(jnp.float32))
    dead = void | lava
    return jnp.where(dead, y, land), dead, dmg


class Res(NamedTuple):
    valid: jnp.ndarray      # bool
    pos: jnp.ndarray        # int32 [3]
    edits: jnp.ndarray      # int32 [3, 4] x y z code (code < 0: no edit)
    dpack: jnp.ndarray      # int32
    dmg: jnp.ndarray        # float32 (falls)
    dead: jnp.ndarray       # bool (a fall into lava or out of the world)
    kind: jnp.ndarray       # int32 0 move, 1 place (can miss), 2 dig (can be slow), 3 other


NOEDIT = jnp.full((3, 4), -1, jnp.int32)


def _res(valid, pos, edits=NOEDIT, dpack=0, dmg=0.0, dead=False, kind=3):
    return Res(jnp.asarray(valid), jnp.asarray(pos, jnp.int32), jnp.asarray(edits, jnp.int32), jnp.asarray(dpack, jnp.int32),
               jnp.asarray(dmg, jnp.float32), jnp.asarray(dead), jnp.asarray(kind, jnp.int32))


def _edit(x, y, z, code, ok=True):
    return jnp.where(ok, jnp.stack([x, y, z, jnp.asarray(code, jnp.int32)]), jnp.full((4,), -1, jnp.int32))


def bot_at(bots, x, y, z):
    return jnp.any((bots[:, 0] == x) & (bots[:, 2] == z) & ((bots[:, 1] == y) | (bots[:, 1] + 1 == y) | (bots[:, 1] == y + 1)))


def a_walk(s, d):
    dx, dz = DIRS[d]
    x, y, z = s.pos[0], s.pos[1], s.pos[2]
    nx, nz = x + dx, z + dz
    w = s.w
    here = standable(w, x, y, z)
    up = standable(w, nx, y + 1, nz) & passable(cell(w, x, y + 2, z))
    leave = passable(cell(w, nx, y, nz)) & passable(cell(w, nx, y + 1, nz))
    # drops of 0..3: the first landing, with free cells all the way
    land = jnp.int32(-10000); ok = jnp.asarray(False)
    free_run = jnp.asarray(True)
    for k in range(4):
        yy = y - k
        free_run = free_run & passable(cell(w, nx, yy, nz))
        hit = leave & free_run & standable(w, nx, yy, nz) & ~ok
        land = jnp.where(hit, yy, land); ok = ok | hit
    ny = jnp.where(up, y + 1, land)
    valid = here & (up | ok) & ~bot_at(s.bots, nx, ny, nz)
    return _res(valid, jnp.stack([nx, ny, nz]), kind=0)


def a_bridge(s, d):
    """A block under the next cell, then onto it (the live `bridge` move: sneak to the edge, place against the side face, step on)."""
    dx, dz = DIRS[d]
    x, y, z = s.pos[0], s.pos[1], s.pos[2]
    fx, fz = x + dx, z + dz
    c = cell(s.w, fx, y - 1, fz)
    valid = (standable(s.w, x, y, z) & ((c == AIR) | (c == WATER)) & passable(cell(s.w, fx, y, fz)) & passable(cell(s.w, fx, y + 1, fz))
             & (s.pack >= 1) & ~bot_at(s.bots, fx, y, fz))
    return _res(valid, jnp.stack([fx, y, fz]), jnp.stack([_edit(fx, y - 1, fz, OWN), NOEDIT[0], NOEDIT[0]]), dpack=-1, kind=1)


def a_dig(s, d):
    dx, dz = DIRS[d]
    x, y, z = s.pos[0], s.pos[1], s.pos[2]
    nx, nz = x + dx, z + dz
    c0, c1 = cell(s.w, nx, y, nz), cell(s.w, nx, y + 1, nz)
    d0, d1 = diggable(c0, s.box, nx, y, nz), diggable(c1, s.box, nx, y + 1, nz)
    valid = standable(s.w, x, y, z) & (d0 | d1) & (s.pack < PACK_CAP)
    ey = jnp.where(d0, y, y + 1)
    return _res(valid, s.pos, jnp.stack([_edit(nx, ey, nz, AIR), NOEDIT[0], NOEDIT[0]]), dpack=1, kind=2)


def a_pillar(s):
    x, y, z = s.pos[0], s.pos[1], s.pos[2]
    w = s.w
    valid = standable(w, x, y, z) & passable(cell(w, x, y + 2, z)) & (s.pack >= 1)
    under = cell(w, x, y - 1, z)
    take = under == OWN                                   # the block two below the new feet goes back to the pack
    edits = jnp.stack([_edit(x, y, z, OWN), _edit(x, y - 1, z, AIR, take), NOEDIT[0]])
    return _res(valid, jnp.stack([x, y + 1, z]), edits, dpack=jnp.where(take, 0, -1), kind=1)


def a_descend(s):
    x, y, z = s.pos[0], s.pos[1], s.pos[2]
    w = s.w
    high = passable(cell(w, x, y - 2, z)) & passable(cell(w, x, y - 3, z))
    valid = standable(w, x, y, z) & high & (s.pack >= 0) & (cell(w, x, y - 1, z) != ROCK) & (cell(w, x, y - 1, z) != OTHER)
    edits = jnp.stack([_edit(x, y - 2, z, OWN), _edit(x, y - 1, z, AIR), NOEDIT[0]])
    return _res(valid, jnp.stack([x, y - 1, z]), edits, dpack=0, kind=1)


def a_digup(s):
    x, y, z = s.pos[0], s.pos[1], s.pos[2]
    c = cell(s.w, x, y + 2, z)
    valid = standable(s.w, x, y, z) & diggable(c, s.box, x, y + 2, z) & (s.pack < PACK_CAP)
    return _res(valid, s.pos, jnp.stack([_edit(x, y + 2, z, AIR), NOEDIT[0], NOEDIT[0]]), dpack=1, kind=2)


def a_digdown(s):
    x, y, z = s.pos[0], s.pos[1], s.pos[2]
    c = cell(s.w, x, y - 1, z)
    ny, dead, dmg = fall_from(s.w, x, y, z, col_air_at=y - 1)
    valid = standable(s.w, x, y, z) & diggable(c, s.box, x, y - 1, z) & (s.pack < PACK_CAP) & ~dead & (s.hp - dmg >= 5.0)     # never a fall that kills or hurts badly
    return _res(valid, jnp.stack([x, ny, z]), jnp.stack([_edit(x, y - 1, z, AIR), NOEDIT[0], NOEDIT[0]]), dpack=1, dmg=dmg, dead=dead, kind=2)


def a_unlay(s):
    """Pick up one of its own blocks beside the floor (the one farthest from the target): bridges are taken away behind the bot."""
    x, y, z = s.pos[0], s.pos[1], s.pos[2]
    best = jnp.float32(-1.0); bx = bz = jnp.int32(0); ok = jnp.asarray(False)
    for dx, dz in DIRS:
        c = cell(s.w, x + dx, y - 1, z + dz)
        d = jnp.hypot((x + dx - s.tgt[0]).astype(jnp.float32), (z + dz - s.tgt[2]).astype(jnp.float32))
        take = (c == OWN) & (d > best)
        best = jnp.where(take, d, best); bx = jnp.where(take, x + dx, bx); bz = jnp.where(take, z + dz, bz); ok = ok | (c == OWN)
    valid = standable(s.w, x, y, z) & ok & (s.pack < PACK_CAP)
    return _res(valid, s.pos, jnp.stack([_edit(bx, y - 1, bz, AIR), NOEDIT[0], NOEDIT[0]]), dpack=1, kind=2)


def a_sidestep(s):
    """One step away from the nearest other bot (spacing): the walk that ends farthest from it."""
    best = jnp.float32(-1.0); out = s.pos; ok = jnp.asarray(False)
    near = jnp.min(jnp.where(s.bots[:, 0] > -500, jnp.hypot((s.bots[:, 0] - s.pos[0]).astype(jnp.float32), (s.bots[:, 2] - s.pos[2]).astype(jnp.float32)), 99.0))
    bi = jnp.argmin(jnp.where(s.bots[:, 0] > -500, jnp.hypot((s.bots[:, 0] - s.pos[0]).astype(jnp.float32), (s.bots[:, 2] - s.pos[2]).astype(jnp.float32)), 99.0))
    b = s.bots[bi]
    for d in range(4):
        r = a_walk(s, d)
        dd = jnp.hypot((r.pos[0] - b[0]).astype(jnp.float32), (r.pos[2] - b[2]).astype(jnp.float32))
        take = r.valid & (dd > best) & (dd > near)
        best = jnp.where(take, dd, best); out = jnp.where(take, r.pos, out); ok = ok | take
    return _res(ok & (near < 3.0), out, kind=0)


def a_wait(s):
    return _res(True, s.pos)


def all_results(s):
    """Every action's result (stacked Res with a leading axis NA)."""
    rs = [a_walk(s, d) for d in range(4)] + [a_bridge(s, d) for d in range(4)] + [a_dig(s, d) for d in range(4)]
    rs += [a_pillar(s), a_descend(s), a_digup(s), a_digdown(s), a_unlay(s), a_wait(s), a_sidestep(s)]
    return jax.tree_util.tree_map(lambda *xs: jnp.stack(xs), *rs)


def valid_mask(s):
    return all_results(s).valid


def apply_edits(w, edits):
    for i in range(edits.shape[0]):
        e = edits[i]
        ok = e[3] >= 0
        x = jnp.clip(e[0] + PAD, 0, SH[0] - 1); y = jnp.clip(e[1] + PAD, 0, SH[1] - 1); z = jnp.clip(e[2] + PAD, 0, SH[2] - 1)
        w = w.at[x, y, z].set(jnp.where(ok, e[3].astype(w.dtype), w[x, y, z]))
    return w


def perturb(s):
    """The world hurts the bot once (recovery training): scaffolding near it collapses, or it is moved to another cell nearby.
    Returns (window, start, pos, hp, dead): only a 5 x 4 x 5 window of the world can change, so only that is written back."""
    k1, k2, k3 = jax.random.split(s.key, 3)
    kind = jax.random.randint(k1, (), 0, 2)
    x, y, z = s.pos[0], s.pos[1], s.pos[2]
    start = jnp.stack([x - 2 + PAD, y - 3 + PAD, z - 2 + PAD])
    win = jax.lax.dynamic_slice(s.w, start, (5, 4, 5))
    win_air = jnp.where(win == OWN, jnp.int8(AIR), win)
    w_col = jax.lax.dynamic_update_slice(s.w, win_air, start)
    ny, dead, dmg = fall_from(w_col, x, y, z)
    # displacement: the first standable of 48 random cells within 5 blocks, up to 5 below and 2 above
    ox = jax.random.randint(k2, (48,), -5, 6); oz = jax.random.randint(k3, (48,), -5, 6); oy = jax.random.randint(k3, (48,), -5, 3)
    cx = jnp.clip(x + ox, 0, NX - 1); cz = jnp.clip(z + oz, 0, NZ - 1); cy = jnp.clip(y + oy, 1, NY - 3)
    ok = jax.vmap(lambda a, b, c: standable(s.w, a, b, c))(cx, cy, cz)
    first = jnp.argmax(ok); found = jnp.any(ok)
    disp = jnp.where(found, jnp.stack([cx[first], cy[first], cz[first]]), s.pos)
    # a collapse that kills (an abyss) or drops the bot into water (the live planner swims it out) is not a movement failure the policy can recover from: it becomes a displacement
    collapsed = (kind == 0) & ~dead & (cell(w_col, x, ny, z) != WATER)
    dead = dead & collapsed
    pos = jnp.where(collapsed, jnp.stack([x, ny, z]), disp)
    window = jnp.where(collapsed, win_air, win)
    hp = s.hp - jnp.where(collapsed, dmg, 0.0)
    return window, start, pos, hp, jnp.where(collapsed, dead, False)


def bots_move(s, key):
    """Other bots wander: each tries a random walk step now and then (a moving obstacle)."""
    def one(b, k):
        k1, k2 = jax.random.split(k)
        d = jax.random.randint(k1, (), 0, 4)
        dxz = jnp.array(DIRS, jnp.int32)[d]
        nx, nz = b[0] + dxz[0], b[2] + dxz[1]
        fake = s._replace(pos=b)
        ok = standable(s.w, nx, b[1], nz) & (b[0] > -500) & (jax.random.uniform(k2) < 0.4)
        return jnp.where(ok, jnp.stack([nx, b[1], nz]), b)
    keys = jax.random.split(key, MAX_BOTS)
    return jax.vmap(one)(s.bots, keys)


class Out(NamedTuple):
    reward: jnp.ndarray
    done: jnp.ndarray
    arrived: jnp.ndarray
    died: jnp.ndarray
    perturbed_now: jnp.ndarray


def step(s, a, shaping=1.0, p_noise=1.0):
    """One decision. Returns (state, Out). An invalid action is a wait that costs 0.05."""
    k0, k1, k2, k3 = jax.random.split(s.key, 4)
    rs = all_results(s)
    pick = lambda x: x[a]
    r = jax.tree_util.tree_map(pick, rs)
    valid = r.valid
    u = jax.random.uniform(k1)
    fail_p = jnp.where(r.kind == 0, 1 - P_MOVE_OK, jnp.where(r.kind == 1, 1 - P_PLACE_OK, jnp.where(r.kind == 2, 1 - P_DIG_OK, 0.0)))
    ok = valid & (u >= fail_p * p_noise)
    d_old = dist3(s.pos, s.tgt)
    pos = jnp.where(ok, r.pos, s.pos)
    w = apply_edits(s.w, jnp.where(ok, r.edits, -1))
    pack = jnp.clip(s.pack + jnp.where(ok, r.dpack, 0), 0, PACK_CAP)
    hp = s.hp - jnp.where(ok, r.dmg, 0.0)
    dead = ok & r.dead
    near_other = jnp.any((jnp.abs(s.bots[:, 0] - pos[0]) <= 1) & (jnp.abs(s.bots[:, 2] - pos[2]) <= 1) & (s.bots[:, 0] > -500))
    on_other = cell(w, pos[0], pos[1] - 1, pos[2]) == OTHER
    bots = bots_move(s._replace(w=w), k2)
    s2 = s._replace(w=w, pos=pos, pack=pack, hp=hp, bots=bots, t=s.t + 1, last=jnp.where(valid, a, A_WAIT).astype(jnp.int32), key=k0)
    # the world hurts the bot once
    fire = (s2.pert_t == s2.t) & ~s2.perturbed
    window, start, ppos, php, dead_p = perturb(s2._replace(key=k3))
    old_win = jax.lax.dynamic_slice(s2.w, start, (5, 4, 5))
    s2 = s2._replace(w=jax.lax.dynamic_update_slice(s2.w, jnp.where(fire, window, old_win), start), pos=jnp.where(fire, ppos, s2.pos),
                     hp=jnp.where(fire, php, s2.hp), perturbed=s2.perturbed | fire)
    dead = dead | (fire & dead_p)
    dead = dead | (s2.hp <= 0)
    d_new = dist3(s2.pos, s2.tgt)
    improved = d_new < s2.best - 0.5
    since = jnp.where(improved, 0, s2.since + 1); best = jnp.where(improved, d_new, s2.best)
    visits = s2.visits.at[s2.pos[0], s2.pos[2]].add(1)
    arr = arrived(s2.pos, s2.tgt, s2.near, s2.near_y) & ~dead
    timeout = s2.t >= HORIZON
    done = arr | dead | timeout
    left = jnp.sum((s2.w == OWN).astype(jnp.float32))
    rew = -0.01 - jnp.where(valid, 0.0, 0.05) + shaping * 0.02 * (d_old - d_new)
    rew = rew - 0.2 * ((r.kind == 1) & ok & near_other).astype(jnp.float32) - 0.2 * on_other.astype(jnp.float32)
    rew = rew - 0.004 * jnp.minimum(s2.visits[s2.pos[0], s2.pos[2]].astype(jnp.float32), 12.0)       # going round the same cells again and again costs a little more each time
    rew = rew + jnp.where(arr, 1.0 - jnp.minimum(0.05 * left, 0.5), 0.0) + jnp.where(dead, -1.0, 0.0)
    s4 = s2._replace(since=since, best=best, visits=jnp.minimum(visits, 100))
    return s4, Out(rew, done, arr, dead, fire)
