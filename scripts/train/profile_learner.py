#!/usr/bin/env python3
"""Where does the learner's time go? Stage-by-stage timing of DPOD's goal learner (botsystem_goal_ppo.py) on real observations,
for the current device (CPU here, the GPU on the owner's PC once WSL2 is there). Nothing is faked but the actions, advantages
and rewards: the observations are the environment's own (any exchange/<base>-*/env_to_policy.jsonl), the goal arrays come from
the learner's own GoalSpace.

  python3 profile_learner.py --obs exchange/<run>/env_to_policy.jsonl [--dpod ../Decision-Process-order-driven] [--out profile.json]

Prints, per stage, milliseconds and samples/s:
  serve      one policy forward for N observations (what a bot waits for)
  parts      forward+backward of each loss term at the sizes one gradient step uses (PPO unroll, SIL unroll, world-model aux, plan)
  step       one fused gradient step (GoalLearner._update) at the default sizes
  update     GoalLearner.update() for B segments with the default sizes and with sizes scaled with B (large matrices)
"""
import argparse, json, os, sys, time
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--obs", required=True)
ap.add_argument("--dpod", default=os.environ.get("DPOD_DIR", str(Path(__file__).resolve().parent.parent.parent.parent / "Decision-Process-order-driven")))
ap.add_argument("--out", default="")
ap.add_argument("--serve-n", default="1,4,16,64,256,1024")
ap.add_argument("--segs", default="16,64,256")
ap.add_argument("--reps", type=int, default=3)
ap.add_argument("--learner-args", default="", help="flags given to every learner, e.g. '--scale 8 --tf32 1 --enc-chunk 512'")
ap.add_argument("--only-update", action="store_true", help="skip the serve and parts stages")
a = ap.parse_args()
sys.path.insert(0, a.dpod); sys.path.insert(0, str(Path(a.dpod) / "scripts"))
import numpy as np, jax, jax.numpy as jnp
import botsystem_goal_ppo as G
from botsystem_goal_wm import GoalWM, sizes_from_hello

hello, obs = None, []
for line in open(a.obs):
    r = json.loads(line)
    if r.get("type") == "hello" and hello is None: hello = r
    elif r.get("type") == "obs" and r.get("env_id") == 0: obs.append(r)
    if len(obs) >= 3000: break
assert hello and len(obs) > 200, "need a hello and a few hundred observations of env 0"
sizes = sizes_from_hello(hello, 2)
model = GoalWM(sizes, kind_prior=True)
params = model.init(jax.random.PRNGKey(0))
goals = G.GoalSpace(sizes, hello["milestones"])
dev = jax.devices()[0]
print(f"device {dev.platform}:{dev.device_kind}  jax {jax.__version__}  params {model.param_counts(params)[0]:,}  obs {len(obs)}", flush=True)

def arrays(i):
    m = obs[i % len(obs)]
    x = G.to_arrays(m["obs"], sizes)
    return {**x, **goals.encode(None, goals.values(m["obs"]), m["step"], 150, 2)}

pool = [arrays(i) for i in range(len(obs))]
rng = np.random.default_rng(0)

def timeit(fn, reps=a.reps):
    out = fn(); jax.block_until_ready(out)               # compile + first run
    ts = []
    for _ in range(reps):
        t = time.perf_counter(); out = fn(); jax.block_until_ready(out); ts.append(time.perf_counter() - t)
    return min(ts)

res = {"device": f"{dev.platform}:{dev.device_kind}", "serve": {}, "parts": {}, "step": {}, "update": {}}

# -- serve: one forward for N observations
serve = jax.jit(model.step)
for n in ([] if a.only_update else map(int, a.serve_n.split(","))):
    batch = {k: np.stack([pool[i % len(pool)][k] for i in range(n)]) for k in pool[0]}
    h = np.zeros((n, model.width), np.float32)
    t = timeit(lambda: serve(params, h, batch))
    res["serve"][n] = {"ms": t * 1e3, "per_s": n / t}
    print(f"serve  N={n:5d}  {t*1e3:8.1f} ms  {n/t:9.0f} obs/s", flush=True)

def segs(B, T=32):
    out = []
    for b in range(B):
        s0 = int(rng.integers(0, len(pool) - T))
        xs = [pool[s0 + i] for i in range(T)]
        n_c = [int(x["cand_mask"].sum()) for x in xs]
        out.append({"h0": np.zeros(model.width, np.float32), "obs": xs, "act": [int(rng.integers(0, max(c, 1))) for c in n_c],
                    "logp": list(-np.log(np.maximum(n_c, 1)).astype(np.float32)), "val": list(rng.normal(0, 0.1, T).astype(np.float32)),
                    "rew": list(rng.normal(0, 0.1, T).astype(np.float32)), "dt": [60.0] * T, "done": [False] * T, "boot": 0.0,
                    "u": [0] * T, "tch": [-1] * T, "src": [0] * T})
    return out

def fill_replay(rep, n):
    for i in range(n):
        x = {k: v for k, v in pool[i % len(pool)].items() if k not in G.GOAL_KEYS}
        m = obs[(i + 1) % len(obs)]["obs"]
        lab = {**G.wm_labels(G.to_arrays(m, sizes), m, False, 0, True),
               **{k: np.zeros(G.NH, np.int32 if k in ("her_kind", "her_id") else np.float32) for k in ("her_kind", "her_id", "her_delta", "her_label", "her_mask")}}
        rep.add(x, lab)

def sil_chunks(n):
    out = []
    for _ in range(n):
        s = segs(1)[0]; out.append({"h0": s["h0"], "obs": s["obs"], "act": s["act"], "ret": list(rng.normal(0, 0.3, 32).astype(np.float32))})
    return out

def learner(extra=()):
    args = G.parse_args(["--root", "/tmp", "--base", "p", *a.learner_args.split(), *extra])
    if a.learner_args and "--tf32" in a.learner_args and args.tf32: jax.config.update("jax_default_matmul_precision", "tensorfloat32")
    return args, G.GoalLearner(args, model, params)

# -- parts: forward+backward of each loss term at the sizes of one gradient step (default flags)
if not a.only_update:
    args, L = learner()
    B = args.batch_segs; mb = max(1, B // args.minibatches)
    def stack(ss, T=32):
        return {"obs": {k: np.stack([np.stack([o[k] for o in s["obs"]]) for s in ss]) for k in ss[0]["obs"][0]}, "h0": np.stack([s["h0"] for s in ss]),
                "act": np.stack([np.asarray(s["act"], np.int32) for s in ss])}
    sb_ = stack(segs(mb)); ret = np.zeros((mb, 32), np.float32); valid = np.ones((mb, 32), np.float32)
    ppo = jax.jit(jax.value_and_grad(lambda P: L._unroll(P, sb_["h0"], sb_["obs"])[0].sum()))
    t = timeit(lambda: ppo(params)); res["parts"]["ppo_unroll"] = {"samples": mb * 32, "ms": t * 1e3}
    print(f"parts  ppo unroll   {mb}x32 = {mb*32:5d} samples  {t*1e3:8.1f} ms", flush=True)
    sil_s = stack(segs(args.sil_batch))
    silf = jax.jit(jax.value_and_grad(lambda P: L._unroll(P, sil_s["h0"], sil_s["obs"])[0].sum()))
    t = timeit(lambda: silf(params)); res["parts"]["sil_unroll"] = {"samples": args.sil_batch * 32, "ms": t * 1e3}
    print(f"parts  sil unroll   {args.sil_batch}x32 = {args.sil_batch*32:5d} samples  {t*1e3:8.1f} ms", flush=True)
    rep = G.Replay(2000); fill_replay(rep, 600)
    ao, al = rep.sample(args.aux_batch, rng)
    auxf = jax.jit(jax.value_and_grad(lambda P: model.aux_loss(P, ao, al)[0]))
    t = timeit(lambda: auxf(params)); res["parts"]["aux"] = {"samples": args.aux_batch, "ms": t * 1e3}
    print(f"parts  world-model aux {args.aux_batch:5d} samples  {t*1e3:8.1f} ms", flush=True)
    po, pl = G.dummy_plan(pool[0], args.plan_batch, model.L)
    plf = jax.jit(jax.value_and_grad(lambda P: model.plan_loss(P, po, pl["task"], pl["seq"], pl["mask"])[0]))
    t = timeit(lambda: plf(params)); res["parts"]["plan"] = {"samples": args.plan_batch, "ms": t * 1e3}
    print(f"parts  plan loss    {args.plan_batch:5d} samples  {t*1e3:8.1f} ms", flush=True)

# -- update(): the whole thing, defaults and scaled
for B in map(int, a.segs.split(",")):
    for label, extra in (("default sizes", []), ("sizes x B/16", ["--aux-batch", str(64 * B // 16), "--sil-batch", str(max(4, 4 * B // 16)), "--plan-batch", str(max(32, 32 * B // 16))])):
        if label != "default sizes" and B == 16: continue
        args, L = learner(["--batch-segs", str(B), *extra])
        rep = G.Replay(4000); fill_replay(rep, 1200); prep = G.Replay(500)
        sil = sil_chunks(max(8, args.sil_batch))
        ss = segs(B)
        scale = G.ReturnScale()
        L.update(ss, scale, rep, rng, prep, sil)                          # compile
        t0 = time.perf_counter()
        for _ in range(max(1, a.reps - 1)): L.update(ss, scale, rep, rng, prep, sil)
        t = (time.perf_counter() - t0) / max(1, a.reps - 1)
        key = f"B={B} {label}"
        res["update"][key] = {"seconds": t, "steps": B * 32, "steps_per_s": B * 32 / t}
        print(f"update {key:24} {t:7.2f} s for {B*32:6d} steps = {B*32/t:8.0f} steps/s", flush=True)
if a.out: Path(a.out).write_text(json.dumps(res, indent=1))
