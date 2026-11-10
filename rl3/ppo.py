"""PPO with GAE on the batched simulator (RL-MOVE-v3, "Training"): masked categorical policy, MLP 256 x 256, two phases (shaped, then unshaped)."""
import json, time, os, math
from functools import partial
import numpy as np
import jax, jax.numpy as jnp
import optax
from . import sim as S, gen as G, env as E, obs as O

HID = 256


def init_params(key, hid=HID):
    k = jax.random.split(key, 4)
    g = lambda kk, i, o, sc=1.0: jax.random.normal(kk, (i, o)) * (sc * math.sqrt(2.0 / i))
    return dict(w1=g(k[0], O.OBS_DIM, hid), b1=jnp.zeros(hid), w2=g(k[1], hid, hid), b2=jnp.zeros(hid), wp=g(k[2], hid, S.NA, 0.01), bp=jnp.zeros(S.NA), wv=g(k[3], hid, 1, 1.0), bv=jnp.zeros(1))


def forward(p, x):
    h = jnp.tanh(x @ p['w1'] + p['b1'])
    h = jnp.tanh(h @ p['w2'] + p['b2'])
    return h @ p['wp'] + p['bp'], (h @ p['wv'] + p['bv'])[..., 0]


def masked_logits(logits, mask):
    return jnp.where(mask, logits, -1e9)


class Traj:
    pass


def make_rollout(n_env, T, gamma, lam):
    obs_b = jax.vmap(O.observe_packed)
    mask_b = jax.vmap(S.valid_mask)

    @jax.jit
    def rollout(params, states, bank, key, shaping, p_pert):
        def body(carry, _):
            st, k = carry
            k, k1, k2 = jax.random.split(k, 3)
            patch, vis, vec = obs_b(st)
            mask = mask_b(st)
            logits, v = forward(params, O.unpack(patch, vis, vec))
            ml = masked_logits(logits, mask)
            a = jax.random.categorical(k1, ml)
            logp = jax.nn.log_softmax(ml)[jnp.arange(n_env), a]
            st2, out, scen, pf = E.step_batch(st, a, bank, k2, shaping, p_pert)
            rec = dict(patch=patch, vis=vis, vec=vec, mask=mask, a=a, logp=logp, v=v, r=out.reward, d=out.done, arr=out.arrived, dead=out.died, scen=scen, pf=pf)
            return (st2, k), rec
        (st, key), tr = jax.lax.scan(body, (states, key), None, length=T)
        patch, vis, vec = obs_b(st)
        _, last_v = forward(params, O.unpack(patch, vis, vec))
        # GAE
        def gae(carry, x):
            adv, nv = carry
            r, v, d = x
            nonterm = 1.0 - d.astype(jnp.float32)
            delta = r + gamma * nv * nonterm - v
            adv = delta + gamma * lam * nonterm * adv
            return (adv, v), adv
        _, advs = jax.lax.scan(gae, (jnp.zeros(n_env), last_v), (tr['r'], tr['v'], tr['d']), reverse=True)
        tr['adv'] = advs; tr['ret'] = advs + tr['v']
        return st, tr, key
    return rollout


def make_update(opt, clip=0.2, vf=0.5, ent=0.01, epochs=3, mb=8192):
    def loss_fn(params, b, ent_c):
        x = O.unpack(b['patch'], b['vis'], b['vec'])
        logits, v = forward(params, x)
        ml = masked_logits(logits, b['mask'])
        lp_all = jax.nn.log_softmax(ml)
        lp = jnp.take_along_axis(lp_all, b['a'][:, None], 1)[:, 0]
        ratio = jnp.exp(lp - b['logp'])
        adv = (b['adv'] - b['adv'].mean()) / (b['adv'].std() + 1e-6)
        pg = -jnp.minimum(ratio * adv, jnp.clip(ratio, 1 - clip, 1 + clip) * adv).mean()
        vl = 0.5 * ((v - b['ret']) ** 2).mean()
        p = jnp.exp(lp_all)
        en = -(jnp.where(b['mask'], p * lp_all, 0.0)).sum(-1).mean()
        return pg + vf * vl - ent_c * en, (pg, vl, en)

    @jax.jit
    def update(params, opt_state, tr, key, ent_c):
        flat = {k: v.reshape((-1,) + v.shape[2:]) for k, v in tr.items() if k in ('patch', 'vis', 'vec', 'mask', 'a', 'logp', 'adv', 'ret')}
        n = flat['a'].shape[0]; mb_ = min(mb, n); nmb = n // mb_
        def epoch(carry, k):
            params, opt_state = carry
            perm = jax.random.permutation(k, n)[:nmb * mb_].reshape(nmb, mb_)
            def mbstep(c, idx):
                params, opt_state = c
                b = {kk: vv[idx] for kk, vv in flat.items()}
                (l, aux), g = jax.value_and_grad(loss_fn, has_aux=True)(params, b, ent_c)
                up, opt_state = opt.update(g, opt_state, params)
                return (optax.apply_updates(params, up), opt_state), (l,) + aux
            (params, opt_state), ls = jax.lax.scan(mbstep, (params, opt_state), perm)
            return (params, opt_state), jax.tree_util.tree_map(jnp.mean, ls)
        (params, opt_state), ls = jax.lax.scan(epoch, (params, opt_state), jax.random.split(key, epochs))
        return params, opt_state, jax.tree_util.tree_map(lambda x: x[-1], ls)
    return update


def wilson(k, n, z=1.96):
    if n == 0: return (0.0, 0.0, 0.0)
    p = k / n; d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d; h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (p, max(0.0, c - h), min(1.0, c + h))


def evaluate(policy, bank, key, n_per, p_pert, p_noise=1.0):
    """Greedy episodes on a held-out bank. policy(states) -> actions. Returns per-scenario dict of counts. The bank is laid out so that entry i has scenario bank['scen'][i]."""
    n = bank['w'].shape[0]
    keys = jax.random.split(key, n)
    st = jax.vmap(lambda i, k: G.state_from(E.take(bank, i), k, p_pert))(jnp.arange(n), keys)

    @jax.jit
    def run(st):
        def body(c, _):
            st, fin, arr, dead = c
            a = policy(st)
            ns, out = jax.vmap(lambda s, a: S.step(s, a, 0.0, p_noise))(st, a)
            ns = jax.tree_util.tree_map(lambda new, old: jnp.where(fin.reshape((-1,) + (1,) * (new.ndim - 1)), old, new), ns, st)
            arr = arr | (out.arrived & ~fin); dead = dead | (out.died & ~fin)
            return (ns, fin | out.done, arr, dead), None
        z = jnp.zeros(n, bool)
        (st, fin, arr, dead), _ = jax.lax.scan(body, (st, z, z, z), None, length=S.HORIZON)
        return st, arr, dead
    st, arr, dead = run(st)
    arr = np.asarray(arr); dead = np.asarray(dead); pf = np.asarray(st.perturbed); scen = np.asarray(bank['scen'])
    res = {}
    for i, name in enumerate(G.SCEN_NAMES):
        m = scen == i
        res[name] = dict(n=int(m.sum()), arrived=int(arr[m].sum()), died=int(dead[m].sum()), perturbed=int(pf[m].sum()), rec=int((arr & pf)[m].sum()))
    tot = dict(n=int(len(scen)), arrived=int(arr.sum()), died=int(dead.sum()), perturbed=int(pf.sum()), rec=int((arr & pf).sum()))
    res['all'] = tot
    return res


def greedy_policy(params):
    def pol(st):
        obs = jax.vmap(O.observe)(st); mask = jax.vmap(S.valid_mask)(st)
        logits, _ = forward(params, obs)
        return jnp.argmax(masked_logits(logits, mask), -1)
    return pol


def summarise(res):
    out = {}
    for k, v in res.items():
        p, lo, hi = wilson(v['arrived'], v['n']); out[k] = dict(n=v['n'], success=round(p, 4), lo=round(lo, 4), hi=round(hi, 4), died=round(v['died'] / max(1, v['n']), 4))
        if v['perturbed']:
            q, qlo, qhi = wilson(v['rec'], v['perturbed']); out[k].update(recovery=round(q, 4), rec_lo=round(qlo, 4), rec_hi=round(qhi, 4), perturbed=v['perturbed'])
    return out


def save_params(params, path):
    np.savez(path, **{k: np.asarray(v) for k, v in params.items()})


def load_params(path):
    z = np.load(path)
    return {k: jnp.asarray(z[k]) for k in z.files}


def train(out, n_env=1024, T=128, updates=300, seed=0, lr=3e-4, bank_n=2048, refresh=128, shaped_frac=0.6, p_pert=0.35, eval_every=25, eval_n=700, init=None, log=print):
    os.makedirs(out, exist_ok=True)
    key = jax.random.PRNGKey(seed)
    key, kb, kp, ke, kr = jax.random.split(key, 5)
    make_bank = jax.jit(G.make_bank)
    bank = make_bank(kb, E.scen_ids(bank_n))
    hold = jax.jit(G.make_bank)(ke, E.scen_ids(eval_n, (1 / 7,) * 7))
    params = load_params(init) if init else init_params(kp)
    sched = optax.linear_schedule(lr, lr * 0.1, updates * 3 * (n_env * T // 8192))
    opt = optax.chain(optax.clip_by_global_norm(0.5), optax.adam(sched))
    opt_state = opt.init(params)
    rollout = make_rollout(n_env, T, 0.995, 0.95)
    update = make_update(opt)
    st = E.reset_all(bank, kr, n_env, p_pert)
    t0 = time.time(); best = -1.0; hist = []
    pause = os.environ.get('RL3_PAUSE')
    for u in range(updates):
        while pause and os.path.exists(pause):
            time.sleep(30)
        shaping = 1.0 if u < shaped_frac * updates else 0.0
        key, k1, k2, k3 = jax.random.split(key, 4)
        if u % 4 == 3:                                    # a quarter of the bank is replaced every four updates, so the policy never sees the same worlds twice for long
            off = ((u // 4) * refresh) % (bank_n - refresh + 1)
            new = make_bank_slice(k3, refresh)
            bank = jax.tree_util.tree_map(lambda b, n_: jax.lax.dynamic_update_slice_in_dim(b, n_, off, 0), bank, new)
        st, tr, _ = rollout(params, st, bank, k1, shaping, p_pert)
        ent_c = 0.01 * (1 - u / updates) + 0.002
        params, opt_state, aux = update(params, opt_state, tr, k2, ent_c)
        if u % 5 == 0 or u == updates - 1:
            d = np.asarray(tr['d']); a = np.asarray(tr['arr']); dd = np.asarray(tr['dead'])
            log(f'u {u:4d} t {time.time()-t0:7.0f}s shaping {shaping:.0f} ep_end {d.sum():6d} arrive {a.sum() / max(1, d.sum()):.3f} died {dd.sum() / max(1, d.sum()):.3f} rew/step {float(np.asarray(tr["r"]).mean()):+.4f} loss {[round(float(x), 4) for x in aux]}')
        if (u + 1) % eval_every == 0 or u == updates - 1:
            r = summarise(evaluate(greedy_policy(params), hold, jax.random.PRNGKey(99), eval_n, 0.0))['all']
            log(f'EVAL u {u + 1}: success {r["success"]:.3f} [{r["lo"]:.3f}, {r["hi"]:.3f}] died {r["died"]:.3f}')
            hist.append(dict(u=u + 1, success=r['success']))
            save_params(params, os.path.join(out, 'last.npz'))
            if r['success'] >= best and shaping == 0.0: best = r['success']; save_params(params, os.path.join(out, 'best.npz'))
    save_params(params, os.path.join(out, 'last.npz'))
    return params


_slice_cache = {}
def make_bank_slice(key, n):
    if n not in _slice_cache:
        _slice_cache[n] = jax.jit(lambda k: G.make_bank(k, E.scen_ids(n)))
    return _slice_cache[n](key)
