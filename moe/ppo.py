"""PPO for the candidate-scoring policies: per-environment trajectories, GAE with exact bootstrap at the cut, clipped objective, Adam."""
import jax
import jax.numpy as jnp
import numpy as np
import optax

from . import policy


class Traj:
    """Completed transitions of one environment, in time order. A transition is complete when the next observation (and its value) is known."""
    def __init__(self):
        self.ctx, self.cand, self.mask = [], [], []
        self.a, self.logp, self.v, self.r, self.done, self.next_v = [], [], [], [], [], []

    def __len__(self):
        return len(self.a)

    def add(self, ctx, cand, mask, a, logp, v, r, done, next_v):
        for l, x in ((self.ctx, ctx), (self.cand, cand), (self.mask, mask), (self.a, a), (self.logp, logp), (self.v, v), (self.r, r), (self.done, done), (self.next_v, next_v)):
            l.append(x)

    def clear(self):
        self.__init__()


def gae(r, v, done, next_v, gamma, lam):
    """Advantages of one trajectory. `next_v[t]` is the value of the observation after step t (ignored where done[t]); the cut at the end is exact."""
    n = len(r)
    adv = np.zeros(n, dtype=np.float32)
    last = 0.0
    for t in reversed(range(n)):
        live = 1.0 - done[t]
        delta = r[t] + gamma * next_v[t] * live - v[t]
        last = delta + gamma * lam * live * last
        adv[t] = last
    return adv, adv + np.asarray(v, dtype=np.float32)


def batch_of(trajs, gamma=0.99, lam=0.95):
    parts = {k: [] for k in ("ctx", "cand", "mask", "a", "logp", "adv", "ret", "v")}
    for t in trajs:
        if not len(t):
            continue
        adv, ret = gae(t.r, t.v, t.done, t.next_v, gamma, lam)
        parts["ctx"].append(np.stack(t.ctx)); parts["cand"].append(np.stack(t.cand)); parts["mask"].append(np.stack(t.mask))
        parts["a"].append(np.asarray(t.a, dtype=np.int32)); parts["logp"].append(np.asarray(t.logp, dtype=np.float32))
        parts["adv"].append(adv); parts["ret"].append(ret); parts["v"].append(np.asarray(t.v, dtype=np.float32))
    if not parts["a"]:
        return None
    return {k: np.concatenate(v) for k, v in parts.items()}


def make_update(lr=5e-4, clip=0.2, vf=0.5, ent=0.01, max_grad=0.5):
    opt = optax.chain(optax.clip_by_global_norm(max_grad), optax.adam(lr))

    def loss_fn(p, b):
        logits, v = policy.forward(p, b["ctx"], b["cand"], b["mask"])
        lp_all = jax.nn.log_softmax(logits)
        logp = lp_all[jnp.arange(logits.shape[0]), b["a"]]
        ratio = jnp.exp(logp - b["logp"])
        adv = b["adv"]
        pg = -jnp.minimum(ratio * adv, jnp.clip(ratio, 1 - clip, 1 + clip) * adv).mean()
        vl = 0.5 * ((v - b["ret"]) ** 2).mean()
        pr = jnp.exp(lp_all)
        entropy = -jnp.where(b["mask"], pr * lp_all, 0.0).sum(-1).mean()
        kl = (b["logp"] - logp).mean()
        cf = (jnp.abs(ratio - 1.0) > clip).mean()
        return pg + vf * vl - ent * entropy, {"pg": pg, "vl": vl, "entropy": entropy, "kl": kl, "clipfrac": cf}

    @jax.jit
    def step(params, state, b):
        (loss, aux), g = jax.value_and_grad(loss_fn, has_aux=True)(params, b)
        up, state = opt.update(g, state, params)
        return optax.apply_updates(params, up), state, loss, aux

    return opt, step


def update(params, opt_state, step, data, rng, epochs=4, minibatch=512):
    """Several epochs over `data` (dict of arrays) in shuffled minibatches; advantages are normalised over the whole batch."""
    n = len(data["a"])
    adv = data["adv"]
    data = dict(data, adv=((adv - adv.mean()) / (adv.std() + 1e-8)).astype(np.float32))
    aux_sum, k = {}, 0
    for _ in range(epochs):
        perm = rng.permutation(n)
        for i in range(0, n - minibatch + 1 if n >= minibatch else 1, minibatch):
            idx = perm[i:i + minibatch]
            params, opt_state, _, aux = step(params, opt_state, {kk: jnp.asarray(vv[idx]) for kk, vv in data.items() if kk != "v"})
            for kk, vv in aux.items():
                aux_sum[kk] = aux_sum.get(kk, 0.0) + float(vv)
            k += 1
    return params, opt_state, {kk: vv / max(k, 1) for kk, vv in aux_sum.items()}
