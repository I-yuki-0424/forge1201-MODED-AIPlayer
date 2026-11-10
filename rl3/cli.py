"""python -m rl3.cli train|eval|export|golden ..."""
import argparse, json, os, sys, time
import numpy as np
import jax, jax.numpy as jnp
from . import ppo, gen as G, env as E, sim as S, obs as O


def outdir(p):
    # /out/NAME is the container mount on the VPS; on the PC it is ~/rl3/runs
    if p.startswith('/out/') and not os.path.isdir('/out'):
        return os.path.join(os.path.expanduser('~/rl3/runs'), p[5:])
    return p


def export(params_path, out, meta):
    """The policy as JSON for src/experts/move3/policy.js: float32 matrices, base64, row-major [in, out]. The value head is not needed to act."""
    import base64
    p = ppo.load_params(params_path)
    enc = lambda a: base64.b64encode(np.asarray(a, np.float32).tobytes()).decode()
    doc = dict(kind='move3', version=1, obs_dim=O.OBS_DIM, na=S.NA, hid=int(p['w1'].shape[1]), actions=S.ACTIONS, meta=meta,
               w1=enc(p['w1']), b1=enc(p['b1']), w2=enc(p['w2']), b2=enc(p['b2']), wp=enc(p['wp']), bp=enc(p['bp']))
    json.dump(doc, open(out, 'w'))
    print('exported', out, os.path.getsize(out), 'bytes')
    # a few observations with the logits, so that the JS loader can be tested against this exact file
    key = jax.random.PRNGKey(5)
    bank = jax.jit(G.make_bank)(key, jnp.array([i % G.NSCEN for i in range(14)], jnp.int32))
    st = jax.vmap(lambda i, k: G.state_from(E.take(bank, i), k, 0.0))(jnp.arange(14), jax.random.split(key, 14))
    ob = jax.vmap(O.observe)(st)
    logits, _ = ppo.forward(p, ob)
    json.dump(dict(obs=[[round(float(v), 6) for v in r] for r in np.asarray(ob)], logits=[[round(float(v), 5) for v in r] for r in np.asarray(logits)]), open(out.replace('.json', '.check.json'), 'w'))


def boxes_of(w):
    """Greedy cover of a voxel array by boxes of one code each: [[x0, y0, z0, x1, y1, z1, code], ...] (inclusive). Few big boxes for the structured worlds."""
    done = np.zeros(w.shape, bool); out = []
    nx, ny, nz = w.shape
    for x in range(nx):
        for y in range(ny):
            for z in range(nz):
                c = w[x, y, z]
                if c == 0 or done[x, y, z]: continue
                x1 = x
                while x1 + 1 < nx and w[x1 + 1, y, z] == c and not done[x1 + 1, y, z]: x1 += 1
                z1 = z
                while z1 + 1 < nz and np.all((w[x:x1 + 1, y, z1 + 1] == c) & ~done[x:x1 + 1, y, z1 + 1]): z1 += 1
                y1 = y
                while y1 + 1 < ny and np.all((w[x:x1 + 1, y1 + 1, z:z1 + 1] == c) & ~done[x:x1 + 1, y1 + 1, z:z1 + 1]): y1 += 1
                done[x:x1 + 1, y:y1 + 1, z:z1 + 1] = True
                out.append([x, y, z, x1, y1, z1, int(c)])
    return out


def scenarios(out, per, seed, crowd):
    """Worlds of the simulator as lists of boxes, for the live harness (scripts/work/move3_live.js): the same generators, built with /fill on a real server."""
    ids = jnp.array([i % G.NSCEN for i in range(per * G.NSCEN)], jnp.int32)
    bank = jax.jit(lambda k: G.make_bank(k, ids, crowd))(jax.random.PRNGKey(seed))
    rows = []
    for i in range(len(ids)):
        w = np.asarray(bank['w'][i])[S.PAD:S.PAD + S.NX, S.PAD:S.PAD + S.NY, S.PAD:S.PAD + S.NZ]
        rows.append(dict(scen=G.SCEN_NAMES[int(ids[i])], boxes=boxes_of(w), pos=[int(v) for v in bank['pos'][i]], tgt=[int(v) for v in bank['tgt'][i]], near=int(bank['near'][i]), nearY=int(bank['near_y'][i]),
                         pack=int(bank['pack'][i]), dig=[int(v) for v in bank['box'][i]], bots=[[int(v) for v in b] for b in np.asarray(bank['bots'][i]) if b[0] > -500]))
    json.dump(dict(grid=[S.NX, S.NY, S.NZ], rows=rows), open(out, 'w'))
    print(f'scenarios: {len(rows)} worlds, {sum(len(r["boxes"]) for r in rows)} boxes -> {out}')


def golden(out, n, seed):
    """States of every scenario after a few random valid actions, with the simulator's observation and mask: the contract test of src/experts/move3 (rules.js, obs.js)."""
    import base64
    key = jax.random.PRNGKey(seed)
    bank = jax.jit(G.make_bank)(key, jnp.array([i % G.NSCEN for i in range(n)], jnp.int32))
    step = jax.jit(lambda s, a: S.step(s, a, 0.0, 1.0)[0])
    obs_f, mask_f = jax.jit(O.observe), jax.jit(S.valid_mask)
    rows = []
    for i in range(n):
        s = G.state_from(E.take(bank, i), jax.random.PRNGKey(seed + i), 0.0)
        for t in range(i % 7 * 4):
            m = np.asarray(mask_f(s)); k = jax.random.PRNGKey(1000 + t + 31 * i)
            a = int(jax.random.choice(k, S.NA, p=jnp.asarray(m / m.sum())))
            s = step(s, jnp.int32(a))
        w = np.asarray(s.w); x, y, z = [int(v) for v in s.pos]
        x0, x1, z0, z1 = max(-S.PAD, x - 13), min(S.NX + S.PAD - 1, x + 13), max(-S.PAD, z - 13), min(S.NZ + S.PAD - 1, z + 13)
        win = w[x0 + S.PAD:x1 + S.PAD + 1, :, z0 + S.PAD:z1 + S.PAD + 1].astype(np.int8)      # all of y: unpadded y runs -PAD .. NY + PAD - 1
        vis = np.asarray(s.visits); xs, zs = np.nonzero(vis)
        rows.append(dict(pos=[x, y, z], tgt=[int(v) for v in s.tgt], near=int(s.near), nearY=int(s.near_y), pack=int(s.pack), hp=float(s.hp), t=int(s.t), since=int(s.since), last=int(s.last),
                         box=[int(v) for v in s.box], bots=[[int(v) for v in b] for b in np.asarray(s.bots) if b[0] > -500], visits=[[int(a_), int(b_), int(vis[a_, b_])] for a_, b_ in zip(xs, zs)],
                         win=dict(x0=x0, y0=-S.PAD, z0=z0, nx=int(win.shape[0]), ny=int(win.shape[1]), nz=int(win.shape[2]), data=base64.b64encode(win.tobytes()).decode()),
                         obs=[round(float(v), 6) for v in np.asarray(obs_f(s))], mask=[bool(v) for v in np.asarray(mask_f(s))], scen=int(s.scen)))
    json.dump(dict(dims=dict(obs=O.OBS_DIM, na=S.NA), rows=rows), open(out, 'w'))
    print(f'golden: {len(rows)} states -> {out}')


def pit_golden(out, n):
    """Chunks after a few greedy stations, with the simulator's features, mask, candidate ids and context: the contract test of src/experts/pit/model.js."""
    from . import pitsim as P, pitppo
    import base64
    obs_f = jax.jit(P.observe); step = jax.jit(P.step)
    rows = []
    for i in range(n):
        s = P.gen(jax.random.PRNGKey(100 + i))
        for t in range(i % 4):
            feats, mask, idx, glob = obs_f(s)
            if not bool(jnp.any(mask)): break
            s, _ = step(s, jnp.int32(0), idx)
        feats, mask, idx, glob = obs_f(s)
        m = np.asarray(s.m)
        rows.append(dict(m=base64.b64encode(m.astype(np.int8).tobytes()).decode(), bot=[int(v) for v in s.bot], t=int(s.t), lastN=float(s.last_n),
                         feats=[[round(float(v), 6) for v in r] for r in np.asarray(feats)], mask=[bool(v) for v in np.asarray(mask)], idx=[int(v) for v in np.asarray(idx)], glob=[round(float(v), 6) for v in np.asarray(glob)]))
    json.dump(dict(n=P.N, h=P.H, k=P.K, nf=P.NF, ng=P.NG, rows=rows), open(out, 'w')); print(f'pit golden: {len(rows)} chunks -> {out}')


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    t = sub.add_parser('train'); t.add_argument('--out', default='/out/run'); t.add_argument('--envs', type=int, default=1024); t.add_argument('--T', type=int, default=128)
    t.add_argument('--updates', type=int, default=300); t.add_argument('--seed', type=int, default=0); t.add_argument('--lr', type=float, default=3e-4)
    t.add_argument('--bank', type=int, default=2048); t.add_argument('--eval-n', type=int, default=700); t.add_argument('--init', default=None)
    t.add_argument('--eval-every', type=int, default=25); t.add_argument('--noise', type=float, default=1.0); t.add_argument('--p-pert', type=float, default=0.35)
    x = sub.add_parser('export'); x.add_argument('--params', required=True); x.add_argument('--out', required=True); x.add_argument('--meta', default='{}')
    sc = sub.add_parser('scenarios'); sc.add_argument('--out', required=True); sc.add_argument('--per', type=int, default=6); sc.add_argument('--seed', type=int, default=4242); sc.add_argument('--crowd', type=float, default=0.0)
    pt = sub.add_parser('pit-train'); pt.add_argument('--out', default='/out/pit'); pt.add_argument('--envs', type=int, default=512); pt.add_argument('--updates', type=int, default=300); pt.add_argument('--seed', type=int, default=0)
    pe = sub.add_parser('pit-eval'); pe.add_argument('--params', default=None); pe.add_argument('--n', type=int, default=1024); pe.add_argument('--seed', type=int, default=99)
    px = sub.add_parser('pit-export'); px.add_argument('--params', required=True); px.add_argument('--out', required=True); px.add_argument('--meta', default='{}')
    pg = sub.add_parser('pit-golden'); pg.add_argument('--out', default='tests/golden_pit.json'); pg.add_argument('--n', type=int, default=12)
    g = sub.add_parser('golden'); g.add_argument('--out', default='tests/golden_move3.json'); g.add_argument('--n', type=int, default=21); g.add_argument('--seed', type=int, default=7)
    e = sub.add_parser('eval'); e.add_argument('--params'); e.add_argument('--policy', default='net', choices=['net', 'random', 'scripted']); e.add_argument('--n', type=int, default=1400); e.add_argument('--seed', type=int, default=12345)
    e.add_argument('--out', default=None); e.add_argument('--noise', type=float, default=1.0)
    a = ap.parse_args()
    if a.cmd == 'train':
        ppo.train(outdir(a.out), n_env=a.envs, T=a.T, updates=a.updates, seed=a.seed, lr=a.lr, bank_n=a.bank, eval_n=a.eval_n, init=(outdir(a.init) if a.init else None), eval_every=a.eval_every, p_pert=a.p_pert, noise=a.noise,
                  log=lambda s: print(s, flush=True))
    elif a.cmd == 'export':
        export(outdir(a.params), outdir(a.out), json.loads(a.meta))
    elif a.cmd == 'scenarios':
        scenarios(outdir(a.out), a.per, a.seed, a.crowd)
    elif a.cmd == 'pit-train':
        from . import pitppo
        pitppo.train(outdir(a.out), n_env=a.envs, updates=a.updates, seed=a.seed, log=lambda s: print(s, flush=True))
    elif a.cmd == 'pit-eval':
        from . import pitppo
        out = {}
        key = jax.random.PRNGKey(a.seed)
        for name, pol in (('greedy', pitppo.greedy_policy), ('tiles', pitppo.tiles_policy)) + ((('net', pitppo.net_policy(pitppo.load_params(outdir(a.params)))),) if a.params else ()):
            out[name] = pitppo.episode_stats(pol, key, a.n)
            print(name, json.dumps({k: round(v, 3) for k, v in out[name].items()}), flush=True)
    elif a.cmd == 'pit-export':
        from . import pitppo, pitsim
        import base64
        p = pitppo.load_params(outdir(a.params))
        enc = lambda x: base64.b64encode(np.asarray(x, np.float32).tobytes()).decode()
        doc = dict(kind='pit', version=1, nf=pitsim.NF, ng=pitsim.NG, k=pitsim.K, hid=int(p['w1'].shape[1]), meta=json.loads(a.meta), w1=enc(p['w1']), b1=enc(p['b1']), w2=enc(p['w2']), b2=enc(p['b2']), ws=enc(p['ws']), bs=enc(p['bs']))
        json.dump(doc, open(outdir(a.out), 'w')); print('exported', outdir(a.out))
    elif a.cmd == 'pit-golden':
        pit_golden(outdir(a.out), a.n)
    elif a.cmd == 'golden':
        golden(a.out, a.n, a.seed)
    elif a.cmd == 'eval':
        key = jax.random.PRNGKey(a.seed)
        hold = jax.jit(G.make_bank)(key, E.scen_ids(a.n, (1 / 7,) * 7))
        if a.policy == 'net':
            pol = ppo.greedy_policy(ppo.load_params(outdir(a.params)))
        elif a.policy == 'scripted':
            from . import baseline
            pol = baseline.policy
        else:
            pol = lambda st: jax.random.categorical(jax.random.PRNGKey(1), jnp.where(jax.vmap(S.valid_mask)(st), 0.0, -1e9))
        out = {}
        for name, pp in (('plain', 0.0), ('perturbed', 1.0)):
            out[name] = ppo.summarise(ppo.evaluate(pol, hold, jax.random.PRNGKey(a.seed + 1), a.n, pp, a.noise))
        print(json.dumps(out, indent=1))
        if a.out: json.dump(out, open(outdir(a.out), 'w'), indent=1)


if __name__ == '__main__':
    main()
