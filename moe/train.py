"""PPO training of one expert on running simulator shards.

The expert sees the observation of the environment and nothing about its own goal: one model per goal, the catalogue says which. Reward is the
only place the goal enters: +1 when the scenario ends in success, -0.2 when the bot dies, a small cost per command, and a potential-based
shaping on the number of goal items held (Ng et al. 1999: the shaping does not change which policy is best). Nothing else is rewarded.
"""
import json
import os
import pathlib
import time

import jax
import numpy as np

from . import catalog, policy, ppo
from .features import Featurizer
from .vec import Vec

GAMMA = 0.99
STEP_COST = 0.003
DEATH = -0.2


class Goal:
    """What the catalogue says about an expert's goal, as numbers: the potential used for shaping."""
    APPROACH = 0.2          # weight of "the target block is in view and near" (hand-specified shaping, allowed on this side; potential-based, so it does not change the best policy)

    def __init__(self, expert, feat=None):
        self.have = dict(expert["goal"].get("have", {}))
        self.max_steps = expert["max_steps"]
        self.rel = catalog.relevance(expert)           # scan groups the router shows this expert (MOE-v2)
        self.skill = expert.get("kind", "item") == "skill"
        self.approach_ids = None
        if feat is not None and expert.get("approach"):
            names = set(expert["approach"])
            self.approach_ids = np.array([i for i, n in enumerate(feat.names) if n in names], dtype=np.int64)

    def potential(self, feat, o):
        p = 0.0
        if self.rel and o.get("scan") is not None:
            tg, g = feat.targets(o, self.rel, self.skill)
            if g is not None:                                   # nearest relevant target within 4 chunks, hidden or not: 1 at the target, 0 at 64 blocks
                p += (1.0 if self.skill else 0.4) * (1.0 - float(tg[0, 3]))
        if self.have:
            counts = feat.counts(o, list(self.have))
            p += 0.5 * sum(min(c / t, 1.0) for c, t in zip(counts, self.have.values())) / len(self.have)
        if self.approach_ids is not None and len(self.approach_ids) and o.get("scan") is None:
            vi, vd = np.asarray(o["view_item"]), np.asarray(o["view_dist"], dtype=np.float32)
            hit = np.isin(vi, self.approach_ids)
            if hit.any():
                p += self.APPROACH * (1.0 - float(vd[hit].min()))        # view_dist is 1 for "nothing", smaller is nearer
        return p


def transition_reward(goal, pot_prev, pot_next, outcome):
    """Reward of one step: shaping gamma*phi(s') - phi(s) (phi of a final state is 0), the step cost, and the end of the episode."""
    r = GAMMA * pot_next - pot_prev - STEP_COST
    if outcome == "success":
        r += 1.0
    elif outcome == "died":
        r += DEATH
    return r


class EnvState:
    __slots__ = ("pend", "ret", "n")

    def __init__(self):
        self.pend, self.ret, self.n = None, 0.0, 0


def train(vec, expert, out_dir, budget=300_000, seed=0, rollout=4096, epochs=3, minibatch=512, lr=5e-4, ent=0.01, hidden=64,
          stop_rate=0.97, stop_window=200, min_steps=30_000, log=print, done_file=None):
    cat = catalog.load()
    goal = None
    rel = catalog.relevance(expert)
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    while vec.vocab() is None:
        vec.poll()
        if time.time() - t0 > 120:
            raise RuntimeError("no hello from the simulator within 120 s")
        time.sleep(0.05)
    feat = Featurizer(vec.vocab(), cat["items"])
    goal = Goal(expert, feat)
    key = jax.random.PRNGKey(seed)
    key, k0 = jax.random.split(key)
    params = policy.init(k0, feat.ctx_dim, feat.cand_dim, hidden)
    opt, step_fn = ppo.make_update(lr=lr, ent=ent)
    opt_state = opt.init(params)
    rng = np.random.default_rng(seed)
    meta = {"expert": expert["id"], "hidden": hidden, "core": cat["items"], "ctx_dim": feat.ctx_dim, "cand_dim": feat.cand_dim, "seed": seed,
            "rel": list(rel), "params": policy.n_params(params), "lr": lr, "ent": ent, "gamma": GAMMA, "step_cost": STEP_COST}
    log(f"[{expert['id']}] {meta['params']} parameters, ctx {feat.ctx_dim}, cand {feat.cand_dim}")
    envs, trajs = {}, {}
    steps = updates = episodes = 0
    recent = []          # 1 = success, last `stop_window` episodes
    ep_log = open(out / "episodes.jsonl", "w")      # a run starts from scratch: no resume, so no stale rows
    tr_log = open(out / "train_log.jsonl", "w")
    last_report = time.time()
    t_start = time.time()
    solved_at = None
    while steps < budget:
        obs = vec.poll()
        if not obs:
            time.sleep(0.0015)
            continue
        live = [ob for ob in obs if not ob.terminated]
        v_live, a_live, lp_live = [], [], []
        if live:
            ctx = np.stack([feat.ctx(ob.raw, rel, goal.skill) for ob in live])
            cc = [feat.cands(ob.raw, rel, goal.skill) for ob in live]
            cand_full, mask_full = np.stack([c[0] for c in cc]), np.stack([c[1] for c in cc])
            cand, mask = policy.trim(cand_full, mask_full)             # the network sees only as many candidates as the longest list; the buffer keeps all 64
            key, k1 = jax.random.split(key)
            a, lp, v = policy.act_sample(params, ctx, cand, mask, k1)
            a_live, lp_live, v_live = np.asarray(a), np.asarray(lp), np.asarray(v)
        for ob in obs:
            if ob.terminated:
                st = envs.get(ob.key)
                if st is not None and st.pend is not None:
                    p = st.pend
                    r = transition_reward(goal, p["pot"], 0.0, ob.outcome)
                    trajs.setdefault(ob.key, ppo.Traj()).add(p["ctx"], p["cand"], p["mask"], p["a"], p["lp"], p["v"], r, 1.0, 0.0)
                    st.ret += r
                    st.pend = None
                    steps += 1
                    episodes += 1
                    recent.append(1 if ob.outcome == "success" else 0)
                    recent = recent[-stop_window:]
                    ep_log.write(json.dumps({"ep": episodes, "steps_total": steps, "outcome": ob.outcome, "commands": ob.step, "return": round(st.ret, 3)}) + "\n")
                envs.pop(ob.key, None)
        for i, ob in enumerate(live):
            st = envs.setdefault(ob.key, EnvState())
            pot = goal.potential(feat, ob.raw)
            if st.pend is not None:
                p = st.pend
                r = transition_reward(goal, p["pot"], pot, "")
                trajs.setdefault(ob.key, ppo.Traj()).add(p["ctx"], p["cand"], p["mask"], p["a"], p["lp"], p["v"], r, 0.0, float(v_live[i]))
                st.ret += r
                steps += 1
            st.pend = {"ctx": ctx[i], "cand": cand_full[i], "mask": mask_full[i], "a": int(a_live[i]), "lp": float(lp_live[i]), "v": float(v_live[i]), "pot": pot}
            vec.act(ob, int(a_live[i]))
        if sum(len(t) for t in trajs.values()) >= rollout:
            data = ppo.batch_of(list(trajs.values()), GAMMA)
            for t in trajs.values():
                t.clear()
            if data is not None:
                params, opt_state, aux = ppo.update(params, opt_state, step_fn, data, rng, epochs, minibatch)
                updates += 1
                row = {"update": updates, "steps": steps, "episodes": episodes, "success_recent": round(float(np.mean(recent)), 3) if recent else None,
                       "n_recent": len(recent), "sps": round(steps / (time.time() - t_start), 1), **{k: round(v, 4) for k, v in aux.items()}}
                tr_log.write(json.dumps(row) + "\n")
                tr_log.flush()
                ep_log.flush()
                if time.time() - last_report > 20:
                    last_report = time.time()
                    log(f"[{expert['id']}] {json.dumps(row)}")
                if updates % 10 == 0:
                    policy.save(out / "checkpoint.npz", params, dict(meta, steps=steps, updates=updates))
                if len(recent) >= stop_window and steps >= min_steps and np.mean(recent) >= stop_rate:
                    solved_at = steps
                    break
    policy.save(out / "final.npz", params, dict(meta, steps=steps, updates=updates, episodes=episodes, solved_at=solved_at,
                                                 success_recent=float(np.mean(recent)) if recent else None, seconds=round(time.time() - t_start, 1)))
    ep_log.close()
    tr_log.close()
    if done_file:
        pathlib.Path(done_file).write_text(str(steps))
    return {"steps": steps, "updates": updates, "episodes": episodes, "success_recent": float(np.mean(recent)) if recent else None, "solved_at": solved_at,
            "seconds": round(time.time() - t_start, 1)}
