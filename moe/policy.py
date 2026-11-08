"""A small candidate-scoring policy (one per expert) in JAX.

The context vector goes through two layers to a hidden vector h; every candidate row goes through two layers to c_k; the score of candidate k is
a small network over [c_k, h, c_k * h]; the value comes from h. Weights are shared over the K candidates, so the model does not depend on the order in
which the environment lists them. About 90 k parameters.
"""
import jax
import jax.numpy as jnp
import numpy as np

NEG = -1e9


def _lin(key, n_in, n_out, scale=1.0):
    return {"w": jax.random.normal(key, (n_in, n_out), dtype=jnp.float32) * (scale / np.sqrt(n_in)), "b": jnp.zeros((n_out,), dtype=jnp.float32)}


def init(key, ctx_dim, cand_dim, hidden=96):
    k = jax.random.split(key, 8)
    return {"c1": _lin(k[0], ctx_dim, hidden), "c2": _lin(k[1], hidden, hidden),
            "k1": _lin(k[2], cand_dim, hidden), "k2": _lin(k[3], hidden, hidden),
            "s1": _lin(k[4], 3 * hidden, hidden), "s2": _lin(k[5], hidden, 1, 0.01),
            "v1": _lin(k[6], hidden, hidden), "v2": _lin(k[7], hidden, 1, 1.0)}


def n_params(params):
    return int(sum(np.prod(x.shape) for x in jax.tree_util.tree_leaves(params)))


def _dense(p, x):
    return x @ p["w"] + p["b"]


def forward(params, ctx, cand, mask):
    """ctx [B, Dc], cand [B, K, Dk], mask [B, K] -> (masked logits [B, K], value [B])."""
    h = jnp.tanh(_dense(params["c2"], jnp.tanh(_dense(params["c1"], ctx))))
    c = jnp.tanh(_dense(params["k2"], jnp.tanh(_dense(params["k1"], cand))))
    hb = jnp.broadcast_to(h[:, None, :], c.shape)
    s = jnp.tanh(_dense(params["s1"], jnp.concatenate([c, hb, c * hb], axis=-1)))
    logits = _dense(params["s2"], s)[..., 0]
    v = _dense(params["v2"], jnp.tanh(_dense(params["v1"], h)))[..., 0]
    return jnp.where(mask, logits, NEG), v


@jax.jit
def act_sample(params, ctx, cand, mask, key):
    logits, v = forward(params, ctx, cand, mask)
    a = jnp.argmax(logits + jax.random.gumbel(key, logits.shape), axis=-1)
    logp = jax.nn.log_softmax(logits)[jnp.arange(logits.shape[0]), a]
    return a, logp, v


@jax.jit
def act_greedy(params, ctx, cand, mask):
    logits, v = forward(params, ctx, cand, mask)
    return jnp.argmax(logits, axis=-1), v


def save(path, params, meta):
    flat = {f"{k}/{kk}": np.asarray(vv) for k, v in params.items() for kk, vv in v.items()}
    np.savez(path, **flat, __meta__=np.frombuffer(__import__("json").dumps(meta).encode(), dtype=np.uint8))


def load(path):
    z = np.load(path, allow_pickle=False)
    params, meta = {}, __import__("json").loads(bytes(z["__meta__"]).decode())
    for k in z.files:
        if k == "__meta__":
            continue
        a, b = k.split("/")
        params.setdefault(a, {})[b] = jnp.asarray(z[k])
    return params, meta
