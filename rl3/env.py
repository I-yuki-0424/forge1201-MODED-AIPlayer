"""Batched environment: a bank of worlds on the device, auto-reset by copying a bank entry into the finished environment."""
import jax
import jax.numpy as jnp
from . import sim as S
from . import gen as G
from .obs import observe

# the training mix over scenarios 0..6 (column gap end rim wall lake cliff)
MIX = (0.14, 0.16, 0.16, 0.20, 0.12, 0.11, 0.11)


def scen_ids(n, mix=MIX):
    reps = [max(1, round(n * m)) for m in mix]
    ids = sum(([i] * r for i, r in enumerate(reps)), [])
    return jnp.array((ids * 2)[:n] if len(ids) < n else ids[:n], jnp.int32)


def take(bank, idx):
    return jax.tree_util.tree_map(lambda a: a[idx], bank)


def reset_one(bank, idx, key, p_pert):
    return G.state_from(take(bank, idx), key, p_pert)


def reset_all(bank, key, n, p_pert):
    k1, k2 = jax.random.split(key)
    idx = jax.random.randint(k1, (n,), 0, bank['w'].shape[0])
    keys = jax.random.split(k2, n)
    return jax.vmap(lambda i, k: reset_one(bank, i, k, p_pert))(idx, keys)


def step_batch(states, actions, bank, key, shaping, p_pert, p_noise=1.0):
    """Step every env; finished ones are replaced by a fresh world. Returns (next states, Out of the finished step, scenario ids of the finished step)."""
    ns, out = jax.vmap(lambda s, a: S.step(s, a, shaping, p_noise))(states, actions)
    n = actions.shape[0]
    k1, k2 = jax.random.split(key)
    idx = jax.random.randint(k1, (n,), 0, bank['w'].shape[0])
    keys = jax.random.split(k2, n)
    fresh = jax.vmap(lambda i, k: reset_one(bank, i, k, p_pert))(idx, keys)
    d = out.done
    merged = jax.tree_util.tree_map(lambda a, b: jnp.where(d.reshape((-1,) + (1,) * (a.ndim - 1)), b, a), ns, fresh)
    return merged, out, states.scen, states.perturbed | out.perturbed_now


def observe_batch(states):
    return jax.vmap(observe)(states)


def mask_batch(states):
    return jax.vmap(S.valid_mask)(states)
