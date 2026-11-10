"""The observation of the movement policy (RL-MOVE-v3): an ego-centred voxel patch plus a vector. The layout is the contract with src/experts/move3/obs.js
(golden file: tests/golden_move3.json, written by `python -m rl3.cli golden`). Nothing here looks beyond what the live bot's world model gives it."""
import jax
import jax.numpy as jnp
from .sim import *   # noqa: F401,F403
from . import sim as S

PR = (4, 3, 4)                      # patch radii x y z -> 9 x 7 x 9
PATCH = (2 * PR[0] + 1, 2 * PR[1] + 1, 2 * PR[2] + 1)
NCH = 5                             # solid, diggable, water, lava, other (another bot's block or body)
RAY_DIRS = ((0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1))
RAY_LEN = 12
NVEC = 48
OBS_PATCH = NCH * PATCH[0] * PATCH[1] * PATCH[2]
OBS_VIS = PATCH[0] * PATCH[2]
OBS_DIM = OBS_PATCH + OBS_VIS + NVEC
VEC_NAMES = (['tx', 'ty', 'tz', 'dh', 'd3', 'ux', 'uz', 'pack', 'hp', 'since', 'time', 'near', 'near_y', 'in_box', 'floor_own', 'floor_other', 'standable']
             + [f'last_{n}' for n in S.ACTIONS] + [f'ray{i}' for i in range(8)] + ['b1x', 'b1z', 'b2x', 'b2z'])
assert len(VEC_NAMES) == NVEC


def _clip(v, lo, hi):
    return jnp.clip(v, lo, hi)


def patch_of(s):
    x, y, z = s.pos[0], s.pos[1], s.pos[2]
    p = jax.lax.dynamic_slice(s.w, (x + PAD - PR[0], y + PAD - PR[1], z + PAD - PR[2]), PATCH)
    gx = (x - PR[0] + jnp.arange(PATCH[0]))[:, None, None]
    gy = (y - PR[1] + jnp.arange(PATCH[1]))[None, :, None]
    gz = (z - PR[2] + jnp.arange(PATCH[2]))[None, None, :]
    sol = S.solid(p)
    dig = S.diggable(p, s.box, gx, gy, gz)
    body = jnp.zeros(PATCH, bool)
    for i in range(S.MAX_BOTS):
        b = s.bots[i]
        body = body | ((gx == b[0]) & (gz == b[2]) & ((gy == b[1]) | (gy == b[1] + 1)))
    other = (p == S.OTHER) | body
    return jnp.stack([sol, dig, p == S.WATER, p == S.LAVA, other]).astype(jnp.float32)


def rays_of(s):
    x, y, z = s.pos[0], s.pos[1], s.pos[2]
    out = []
    for dx, dz in RAY_DIRS:
        alive = jnp.asarray(True); run = jnp.float32(0)
        for k in range(1, RAY_LEN + 1):
            ok = S.standable(s.w, x + k * dx, y, z + k * dz)
            alive = alive & ok
            run = run + alive.astype(jnp.float32)
        out.append(run / RAY_LEN)
    return jnp.stack(out)


def nearest_bots(s):
    valid = s.bots[:, 0] > -500
    dx = (s.bots[:, 0] - s.pos[0]).astype(jnp.float32); dz = (s.bots[:, 2] - s.pos[2]).astype(jnp.float32)
    d = jnp.where(valid, jnp.hypot(dx, dz), 1e9)
    order = jnp.argsort(d)[:2]
    ok = d[order] < 1e8
    f = jnp.stack([jnp.where(ok[0], dx[order[0]], 0.0), jnp.where(ok[0], dz[order[0]], 0.0), jnp.where(ok[1], dx[order[1]], 0.0), jnp.where(ok[1], dz[order[1]], 0.0)])
    return _clip(f / 8.0, -1.0, 1.0)


def observe_packed(s):
    """(patch bool [OBS_PATCH], visits uint8 [OBS_VIS] in 0..4, vec float32 [NVEC]): a quarter of the memory of `observe` for rollout buffers."""
    x, y, z = s.pos[0], s.pos[1], s.pos[2]
    patch = patch_of(s).reshape(-1) > 0.5
    vpad = jnp.pad(s.visits, ((PR[0], PR[0]), (PR[2], PR[2])))
    vis = jnp.minimum(jax.lax.dynamic_slice(vpad, (x, z), (PATCH[0], PATCH[2])), 4).astype(jnp.uint8).reshape(-1)
    d = (s.tgt - s.pos).astype(jnp.float32)
    dh = jnp.hypot(d[0], d[2])
    ux = jnp.where(dh > 1e-6, d[0] / jnp.maximum(dh, 1e-6), 0.0); uz = jnp.where(dh > 1e-6, d[2] / jnp.maximum(dh, 1e-6), 0.0)
    d3 = S.dist3(s.pos, s.tgt)
    floor = S.cell(s.w, x, y - 1, z)
    vec = jnp.concatenate([
        jnp.stack([_clip(d[0] / 32, -1.5, 1.5), _clip(d[1] / 32, -1.5, 1.5), _clip(d[2] / 32, -1.5, 1.5), _clip(dh / 48, 0, 1.5), _clip(d3 / 48, 0, 1.5), ux, uz,
                   _clip(s.pack / 32.0, 0, 2), s.hp / S.MAX_HP, _clip(s.since / 50.0, 0, 2), s.t / S.HORIZON, s.near / 3.0, s.near_y / 4.0,
                   S.in_box(s.box, x, y, z).astype(jnp.float32), (floor == S.OWN).astype(jnp.float32), (floor == S.OTHER).astype(jnp.float32),
                   S.standable(s.w, x, y, z).astype(jnp.float32)]),
        jax.nn.one_hot(s.last, S.NA), rays_of(s), nearest_bots(s)])
    return patch, vis, vec.astype(jnp.float32)


def unpack(patch, vis, vec):
    return jnp.concatenate([patch.astype(jnp.float32), vis.astype(jnp.float32) / 4.0, vec], axis=-1)


def observe(s):
    return unpack(*observe_packed(s))
