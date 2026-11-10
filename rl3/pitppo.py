"""PPO for the pit expert: a shared scoring network over K candidate stations (permutation-invariant: the same MLP scores every candidate from its features and the global context)."""
import json, math, os, time
import numpy as np
import jax, jax.numpy as jnp
import optax
from . import pitsim as P

HID = 64


def init_params(key, hid=HID):
    k = jax.random.split(key, 4)
    g = lambda kk, i, o, sc=1.0: jax.random.normal(kk, (i, o)) * (sc * math.sqrt(2.0 / i))
    return dict(w1=g(k[0], P.NF + P.NG, hid), b1=jnp.zeros(hid), w2=g(k[1], hid, hid), b2=jnp.zeros(hid), ws=g(k[2], hid, 1, 0.1), bs=jnp.zeros(1), wv=g(k[3], hid, 1), bv=jnp.zeros(1))


def forward(p, feats, glob, mask):
    """feats [..., K, NF], glob [..., NG], mask [..., K] -> (logits [..., K], value [...])."""
    x = jnp.concatenate([feats, jnp.broadcast_to(glob[..., None, :], feats.shape[:-1] + (P.NG,))], -1)
    h = jnp.tanh(x @ p['w1'] + p['b1'])
    h = jnp.tanh(h @ p['w2'] + p['b2'])
    logits = (h @ p['ws'] + p['bs'])[..., 0]
    m = mask.astype(jnp.float32)[..., None]
    pooled = (h * m).sum(-2) / jnp.maximum(m.sum(-2), 1.0)
    return jnp.where(mask, logits, -1e9), (pooled @ p['wv'] + p['bv'])[..., 0]


obs_b = jax.vmap(P.observe)


def reset_b(key, n):
    return jax.vmap(P.gen)(jax.random.split(key, n))


@jax.jit
def _reset_all(key, n_dummy):
    return None


def make_rollout(n_env, T, gamma=0.99, lam=0.95):
    @jax.jit
    def rollout(params, states, key):
        def body(c, _):
            st, k = c
            k, k1, k2 = jax.random.split(k, 3)
            feats, mask, idx, glob = obs_b(st)
            # an environment with no candidate at all has finished (everything dug or nothing reachable): offer a dummy
            has = jnp.any(mask, -1)
            logits, v = forward(params, feats, glob, jnp.where(has[:, None], mask, jnp.arange(P.K)[None, :] == 0))
            a = jax.random.categorical(k1, logits)
            logp = jax.nn.log_softmax(logits)[jnp.arange(n_env), a]
            ns, out = jax.vmap(P.step)(st, a, idx)
            done = out.done | ~has
            fresh = reset_b(k2, n_env)
            merged = jax.tree_util.tree_map(lambda x, y: jnp.where(done.reshape((-1,) + (1,) * (x.ndim - 1)), y, x), ns, fresh)
            rew = jnp.where(has, out.reward, 0.0)
            rec = dict(feats=feats, glob=glob, mask=jnp.where(has[:, None], mask, jnp.arange(P.K)[None, :] == 0), a=a, logp=logp, v=v, r=rew, d=done, dug=out.dug * has, moved=out.moved * has, stuck=out.stuck * has, left=jnp.where(out.done, out.left, 0.0), fin=out.done & has)
            return (merged, k), rec
        (st, key), tr = jax.lax.scan(body, (states, key), None, length=T)
        feats, mask, idx, glob = obs_b(st)
        _, last_v = forward(params, feats, glob, jnp.where(jnp.any(mask, -1)[:, None], mask, jnp.arange(P.K)[None, :] == 0))
        def gae(carry, x):
            adv, nv = carry
            r, v, d = x
            nt = 1.0 - d.astype(jnp.float32)
            delta = r + gamma * nv * nt - v
            adv = delta + gamma * lam * nt * adv
            return (adv, v), adv
        _, advs = jax.lax.scan(gae, (jnp.zeros(n_env), last_v), (tr['r'], tr['v'], tr['d']), reverse=True)
        tr['adv'] = advs; tr['ret'] = advs + tr['v']
        return st, tr, key
    return rollout


def make_update(opt, clip=0.2, vf=0.5, epochs=4, mb=4096):
    def loss_fn(params, b, ent_c):
        logits, v = forward(params, b['feats'], b['glob'], b['mask'])
        lp_all = jax.nn.log_softmax(logits)
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
        flat = {k: v.reshape((-1,) + v.shape[2:]) for k, v in tr.items() if k in ('feats', 'glob', 'mask', 'a', 'logp', 'adv', 'ret')}
        n = flat['a'].shape[0]; mb_ = min(mb, n); nmb = n // mb_
        def epoch(c, k):
            params, opt_state = c
            perm = jax.random.permutation(k, n)[:nmb * mb_].reshape(nmb, mb_)
            def mbs(c2, idx):
                params, opt_state = c2
                b = {kk: vv[idx] for kk, vv in flat.items()}
                (l, aux), g = jax.value_and_grad(loss_fn, has_aux=True)(params, b, ent_c)
                up, opt_state = opt.update(g, opt_state, params)
                return (optax.apply_updates(params, up), opt_state), (l,) + aux
            (params, opt_state), ls = jax.lax.scan(mbs, (params, opt_state), perm)
            return (params, opt_state), jax.tree_util.tree_map(jnp.mean, ls)
        (params, opt_state), ls = jax.lax.scan(epoch, (params, opt_state), jax.random.split(key, epochs))
        return params, opt_state, jax.tree_util.tree_map(lambda x: x[-1], ls)
    return update


# ------------------------------------------------------------------ evaluation and baselines
def episode_stats(policy, key, n, max_steps=P.MAX_STATIONS):
    """Run n fresh chunks to the end with `policy(state, feats, mask, idx, glob, t) -> a` and report seconds, stations, cells per station, leftover, stuck."""
    st = reset_b(key, n)
    @jax.jit
    def run(st):
        def body(c, t):
            st, fin, sec, stations, dug, left, stuck = c
            feats, mask, idx, glob = obs_b(st)
            has = jnp.any(mask, -1)
            a = policy(st, feats, mask, idx, glob, t)
            ns, out = jax.vmap(P.step)(st, a, idx)
            act = ~fin & has
            ns = jax.tree_util.tree_map(lambda x, y: jnp.where(act.reshape((-1,) + (1,) * (x.ndim - 1)), x, y), ns, st)
            sec = sec - jnp.where(act, out.reward * 10.0, 0.0)
            stations = stations + act; dug = dug + jnp.where(act, out.dug, 0.0); stuck = stuck + jnp.where(act, out.stuck, 0.0)
            end = fin | (act & out.done) | ~has
            left = jnp.where(end & ~fin, P.band_left(ns.m) if False else jax.vmap(P.band_left)(ns.m).astype(jnp.float32), left)
            return (ns, end, sec, stations, dug, left, stuck), None
        z = jnp.zeros(n)
        (st, fin, sec, stations, dug, left, stuck), _ = jax.lax.scan(body, (st, jnp.zeros(n, bool), z, z, z, z, z), jnp.arange(max_steps))
        left = jnp.where(fin, left, jax.vmap(P.band_left)(st.m).astype(jnp.float32))
        return sec, stations, dug, left, stuck
    sec, stations, dug, left, stuck = [np.asarray(x) for x in run(st)]
    # the leftover penalty is already in `sec` through the reward of the last step; report time without it
    sec_clean = sec - P.T_LEFT * left
    return dict(seconds=float(sec_clean.mean()), seconds_all=float(sec.mean()), stations=float(stations.mean()), cells_per_station=float(dug.sum() / max(1.0, stations.sum())),
                left=float(left.mean()), stuck=float(stuck.mean()), n=int(n))


def net_policy(params):
    def pol(st, feats, mask, idx, glob, t):
        logits, _ = forward(params, feats, glob, jnp.where(jnp.any(mask, -1)[:, None], mask, jnp.arange(P.K)[None, :] == 0))
        return jnp.argmax(logits, -1)
    return pol


def greedy_policy(st, feats, mask, idx, glob, t):
    return jnp.zeros(mask.shape[0], jnp.int32)               # candidates come sorted by dig count minus distance: the first is the greedy choice


def tile_centres():
    """The live method's stations (pit.js stationsOf, TILE 5): tiles of ceil(16 / 5) = 4 per side, the middle first."""
    def cut(lo, hi, tile=5):
        n = -(-(hi - lo + 1) // tile); ln = hi - lo + 1
        return [(lo + ln * i // n, lo + ln * (i + 1) // n - 1) for i in range(n)]
    cx = cz = 7.5
    out = []
    for xa, xb in cut(0, 15):
        for za, zb in cut(0, 15):
            out.append(((xa + xb) // 2, (za + zb) // 2))
    out.sort(key=lambda c: (math.hypot(c[0] - cx, c[1] - cz), c[0], c[1]))
    return out


def tiles_policy(st, feats, mask, idx, glob, t):
    """Stations at the tile centres in the live order, layer by layer (depth 1 first): the first tile centre whose neighbourhood still has work; the candidate list is searched for it."""
    cent = jnp.array(tile_centres(), jnp.int32)
    x = idx // (P.N * P.ND); z = (idx // P.ND) % P.N; dd = idx % P.ND
    rank = jnp.full((P.N, P.N), 99, jnp.int32)
    for i in range(cent.shape[0]):
        rank = rank.at[cent[i, 0], cent[i, 1]].set(i)
    r = rank[x, z]                                      # [B, K]
    score = jnp.where(mask & (dd == 0), -r.astype(jnp.float32) - jnp.where(r == 99, 1000.0, 0.0), -1e9)
    score = jnp.where(jnp.any(score > -1e8, -1)[:, None], score, jnp.where(mask, -dd.astype(jnp.float32) * 0 - 1.0, -1e9))
    return jnp.argmax(score, -1)


def train(out, n_env=512, T=40, updates=300, seed=0, lr=5e-4, eval_n=512, log=print):
    os.makedirs(out, exist_ok=True)
    key = jax.random.PRNGKey(seed)
    key, kp, kr = jax.random.split(key, 3)
    params = init_params(kp)
    opt = optax.chain(optax.clip_by_global_norm(0.5), optax.adam(optax.linear_schedule(lr, lr * 0.1, updates * 4 * max(1, (n_env * T) // 4096))))
    opt_state = opt.init(params)
    rollout = make_rollout(n_env, T); update = make_update(opt)
    st = reset_b(kr, n_env)
    t0 = time.time(); pause = os.environ.get('RL3_PAUSE'); best = 1e9
    for u in range(updates):
        while pause and os.path.exists(pause): time.sleep(30)
        key, k1, k2 = jax.random.split(key, 3)
        st, tr, _ = rollout(params, st, k1)
        params, opt_state, aux = update(params, opt_state, tr, k2, 0.02 * (1 - u / updates) + 0.002)
        if u % 10 == 0 or u == updates - 1:
            fin = np.asarray(tr['fin']); n_ep = max(1, int(fin.sum()))
            log(f'u {u:4d} t {time.time()-t0:6.0f}s episodes {n_ep} reward/step {float(np.asarray(tr["r"]).mean()):+.3f} cells/station {float(np.asarray(tr["dug"]).sum() / max(1, np.asarray(tr["dug"] > 0).sum())):.1f} stuck/ep {float(np.asarray(tr["stuck"]).sum() / n_ep):.2f} loss {[round(float(x), 4) for x in aux]}')
        if (u + 1) % 50 == 0 or u == updates - 1:
            r = episode_stats(net_policy(params), jax.random.PRNGKey(777), eval_n)
            log(f'EVAL u {u + 1}: ' + json.dumps({k: round(v, 3) for k, v in r.items()}))
            np.savez(os.path.join(out, 'last.npz'), **{k: np.asarray(v) for k, v in params.items()})
            if r['seconds_all'] < best: best = r['seconds_all']; np.savez(os.path.join(out, 'best.npz'), **{k: np.asarray(v) for k, v in params.items()})
    return params


def load_params(path):
    z = np.load(path)
    return {k: jnp.asarray(z[k]) for k in z.files}
