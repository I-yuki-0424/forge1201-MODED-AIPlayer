import time, sys
import jax, jax.numpy as jnp
from rl3 import sim as S, gen as G, env as E, obs as O
key = jax.random.PRNGKey(0)
t0 = time.time()
bank = jax.jit(G.make_bank, static_argnums=())(key, E.scen_ids(70))
jax.block_until_ready(bank)
print('bank', bank['w'].shape, f'{time.time()-t0:.1f}s', 'obs dim', O.OBS_DIM)
for i, n in enumerate(G.SCEN_NAMES):
    sel = (bank['scen'] == i)
    print(n, int(sel.sum()), 'start-target dist', [round(float(S.dist3(bank['pos'][j], bank['tgt'][j])), 1) for j in range(70) if int(bank['scen'][j]) == i][:3],
          'standable start', [bool(S.standable(bank['w'][j], *[int(v) for v in bank['pos'][j]])) for j in range(70) if int(bank['scen'][j]) == i][:3],
          'standable tgt', [bool(S.standable(bank['w'][j], *[int(v) for v in bank['tgt'][j]])) for j in range(70) if int(bank['scen'][j]) == i][:3])
N = 64
st = E.reset_all(bank, jax.random.PRNGKey(1), N, 0.3)
ob = E.observe_batch(st); mk = E.mask_batch(st)
print('obs', ob.shape, 'mask valid share', float(mk.mean()))
step = jax.jit(E.step_batch)
t0 = time.time(); k = jax.random.PRNGKey(2); tot = 0.0; done = 0
for i in range(100):
    k, k1, k2 = jax.random.split(k, 3)
    mk = E.mask_batch(st)
    a = jax.random.categorical(k1, jnp.where(mk, 0.0, -1e9))
    st, out, sc, pf = step(st, a, bank, k2, 1.0, 0.3)
    tot += float(out.reward.sum()); done += int(out.done.sum())
jax.block_until_ready(st.pos)
print('100 steps x', N, f'{time.time()-t0:.1f}s', 'reward', tot / N, 'done', done)
