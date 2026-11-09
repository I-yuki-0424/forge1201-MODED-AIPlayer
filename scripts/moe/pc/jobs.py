"""Job runner for the MoE experiments inside WSL on the PC (and anywhere with the simulator binary, the tiles and the moe package): no docker, no shell quoting.

  jobs.py train  --tag T [--experts a,b] [--par 8] [--seed 0] [--controls 1]     train + evaluate + controls, one pipeline per expert, `par` at a time
  jobs.py router --tag T                                                          train the XGBoost / LightGBM routers
  jobs.py chain  --tag T --scenario chain-placed --router rules|xgb|lgb --experts net|solver [--episodes 60] [--greedy-stall]
  jobs.py eval   --tag T --expert E --scenario S --policy net|solver|random [--episodes 200]

Layout: ~/moe/{code,scenarios,x,runs/T/EXPERT/...,logs}; tiles ~/sim/tiles; simulator ~/sim/forgeaip-sim-moe2. Training shards run the worlds vps-s0..s2, evaluation vps-s3 and vps-s4
(held out), as in docs/proposed/MOE-v1.md. Processes run at nice 10: the PC's owner comes first.
"""
import argparse
import concurrent.futures as cf
import json
import os
import pathlib
import subprocess
import sys
import time

HOME = pathlib.Path.home()
MOE = HOME / "moe"
SIM = HOME / "sim"
BIN = SIM / "forgeaip-sim-moe2"
X = MOE / "x"
SCN = MOE / "scenarios"
PY = sys.executable
ENV = dict(os.environ, PYTHONPATH=str(MOE / "code"), JAX_PLATFORMS="cpu", PYTHONDONTWRITEBYTECODE="1", OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1", MKL_NUM_THREADS="1", NUMEXPR_NUM_THREADS="1", XLA_FLAGS="--xla_cpu_multi_thread_eigen=false intra_op_parallelism_threads=1")
# steps budget and stop rate per expert (item experts: the v1 budget; the ore and movement experts, which the owner wants most accurate: more, and a higher bar)
BUDGET = {"coal": 600_000, "raw_iron": 800_000, "move": 1_500_000, "unstick": 1_200_000}
STOP = {"coal": 0.985, "raw_iron": 0.985, "move": 0.99, "unstick": 0.985}


def nice():
    os.nice(10)


def catalog():
    sys.path.insert(0, str(MOE / "code"))
    from moe import catalog as C
    return C.load()


def scenarios_of(e, only=None):
    """Scenario files an expert trains on: its own and its variants, except the `ablate-*` ones (controls run only on request: --only-scenario)."""
    names = [e["id"]] + [f"{e['id']}-{v}" for v in e["start"].get("variants", {}) if not v.startswith("ablate")]
    return [only] if only else names


def shards_up(base, scn_list, worlds, count, bots, seed, log):
    for f in X.glob(f"{base}.s*.current"):
        f.unlink()
    (X / f"{base}.done").unlink(missing_ok=True)
    procs = []
    for i in range(count):
        scn = scn_list[i % len(scn_list)]
        w = worlds[i % len(worlds)]
        cmd = [str(BIN), "run", "--root", str(X), "--base", base, "--shard", str(i), "--bots", str(bots), "--days", "3", "--tiles", str(SIM / "tiles"), "--world", w,
               "--reward", str(SIM / "r/reward-v6.json"), "--progress", str(SIM / "r/progress-list.json"), "--seed", str(seed + i), "--scenario", str(SCN / f"{scn}.json")]
        procs.append(subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=open(log, "ab"), preexec_fn=nice))
    return procs


def shards_down(procs):
    for p in procs:
        if p.poll() is None:
            p.terminate()
    for p in procs:
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()


def cleanup(base):
    """The exchange files of a finished run (observations as JSON lines, step events): 100 GB for one evening of runs on the PC, never read again."""
    import shutil
    for d in X.glob(f"{base}-s*-sim*"):
        shutil.rmtree(d, ignore_errors=True)


def cli(args, log, timeout=None):
    r = subprocess.run([PY, "-m", "moe.cli", *args], env=ENV, stdout=subprocess.PIPE, stderr=open(log, "ab"), preexec_fn=nice, timeout=timeout, cwd=str(MOE / "code"))
    with open(log, "ab") as f:                      # keep the whole stdout (chain traces) next to the stderr
        f.write(r.stdout)
    return r.stdout.decode().strip().splitlines()[-1] if r.stdout.strip() else ""


def evaluate(tag, e, scn, policy, episodes, seed, log, out, worlds=("vps-s3", "vps-s4")):
    """One evaluation on the held-out worlds: policy = net | solver | random. Rows go to `out` (jsonl) with the scenario name."""
    base = f"{tag}-ev-{e['id']}-{scn}-{policy}"
    procs = shards_up(base, [scn], list(worlds), 2, 2, 9000 + seed, log)
    try:
        pol = {"net": f"net:{MOE / 'runs' / tag / e['id'] / 'final.npz'}", "solver": "solver", "random": "random"}[policy]
        last = cli(["eval", "--expert", e["id"], "--root", str(X), "--base", base, "--shards", "0,1", "--policy", pol, "--episodes", str(episodes), "--seed", str(seed + 1)], log, timeout=3600)
        row = json.loads(last)
        row["scenario"] = scn
        row["worlds"] = ",".join(worlds)
        with open(out, "a") as f:
            f.write(json.dumps(row) + "\n")
        return row
    finally:
        shards_down(procs)
        cleanup(base)


def pipeline(a, e):
    tag, eid = a.tag, e["id"]
    out = MOE / "runs" / tag / eid
    out.mkdir(parents=True, exist_ok=True)
    log = out / "pipeline.log"
    t0 = time.time()
    steps = a.steps or BUDGET.get(eid, 300_000)
    scn = scenarios_of(e, a.only_scenario or None)
    base = f"{tag}-tr-{eid}"
    procs = shards_up(base, scn, ["vps-s0", "vps-s1", "vps-s2"], a.shards, 2, 1000 + 100 * a.seed, log)
    try:
        res = cli(["train", "--expert", eid, "--root", str(X), "--base", base, "--shards", ",".join(str(i) for i in range(a.shards)), "--out", str(out), "--budget", str(steps),
                   "--seed", str(a.seed), "--stop-rate", str(0.995 if a.hard else STOP.get(eid, 0.97)), "--stop-window", str(500 if a.hard else 200)], log)
    finally:
        shards_down(procs)
        cleanup(base)
    (out / "train_result.json").write_text(res + "\n")
    rows = {}
    if (out / "final.npz").exists():
        for s in scn:
            rows[s] = {"net": evaluate(tag, e, s, "net", a.episodes, a.seed, log, out / "eval.jsonl")}
    if a.controls:
        for s in scn:
            for pol in ("solver", "random"):
                evaluate(tag, e, s, pol, a.episodes, a.seed, log, out / "controls.jsonl")
    summary = {s: r["net"]["rate"] for s, r in rows.items()}
    print(f"[{time.strftime('%H:%M:%S')}] {eid}: trained {res[:160]}  held-out {summary}  ({time.time() - t0:.0f} s)", flush=True)
    return eid


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train"); t.add_argument("--tag", required=True); t.add_argument("--experts", default="all"); t.add_argument("--par", type=int, default=8)
    t.add_argument("--seed", type=int, default=0); t.add_argument("--controls", type=int, default=1); t.add_argument("--steps", type=int, default=0); t.add_argument("--shards", type=int, default=3)
    t.add_argument("--episodes", type=int, default=200); t.add_argument("--hard", action="store_true", help="stop only at 0.995 over 500 episodes (the owner's bar for movement)"); t.add_argument("--only-scenario", default="", help="train and evaluate on this one scenario file only (an ablation)")
    r = sub.add_parser("router"); r.add_argument("--tag", required=True); r.add_argument("--extra", default="")
    c = sub.add_parser("chain"); c.add_argument("--tag", required=True); c.add_argument("--scenario", required=True); c.add_argument("--router", default="rules"); c.add_argument("--experts", default="net")
    c.add_argument("--episodes", type=int, default=60); c.add_argument("--greedy-stall", action="store_true"); c.add_argument("--seed", type=int, default=0); c.add_argument("--out", default="chain.jsonl")
    c.add_argument("--worlds", default="vps-s3,vps-s4"); c.add_argument("--trace", type=int, default=0); c.add_argument("--trace-fail", action="store_true"); c.add_argument("--trace-steps", action="store_true"); c.add_argument("--dump-states", default="")
    m = sub.add_parser("assemble"); m.add_argument("--into", required=True); m.add_argument("--sources", required=True, help="comma list of tags, later ones override earlier ones")
    v = sub.add_parser("eval"); v.add_argument("--tag", required=True); v.add_argument("--expert", required=True); v.add_argument("--scenario", required=True); v.add_argument("--policy", default="net")
    v.add_argument("--episodes", type=int, default=200); v.add_argument("--seed", type=int, default=0); v.add_argument("--worlds", default="vps-s3,vps-s4")
    a = ap.parse_args()
    cat = catalog()
    ex = {e["id"]: e for e in cat["experts"]}
    runs = MOE / "runs" / getattr(a, "tag", getattr(a, "into", ""))
    runs.mkdir(parents=True, exist_ok=True)
    if a.cmd == "train":
        names = list(ex) if a.experts == "all" else a.experts.split(",")
        # the hard and slow ones first, so that the pool is not left waiting for the long runs at the end
        names.sort(key=lambda n: -BUDGET.get(n, 0))
        with cf.ThreadPoolExecutor(a.par) as pool:
            for fut in cf.as_completed([pool.submit(pipeline, a, ex[n]) for n in names]):
                fut.result()
        return
    if a.cmd == "assemble":
        import shutil
        dst = MOE / "runs" / a.into
        for src in a.sources.split(","):
            for d in sorted((MOE / "runs" / src).iterdir()):
                if (d / "final.npz").exists():
                    (dst / d.name).mkdir(parents=True, exist_ok=True)
                    for f in ("final.npz", "train_result.json", "eval.jsonl", "controls.jsonl"):
                        if (d / f).exists():
                            shutil.copy2(d / f, dst / d.name / f)
                    print(f"{d.name} <- {src}")
        return
    if a.cmd == "router":
        print(cli(["router", "--out", str(runs / "router")] + (["--extra", ",".join(str(runs / x) for x in a.extra.split(","))] if a.extra else []), runs / "router.log"))
        return
    if a.cmd == "eval":
        print(evaluate(a.tag, ex[a.expert], a.scenario, a.policy, a.episodes, a.seed, runs / "eval.log", runs / f"eval-{a.expert}.jsonl", tuple(a.worlds.split(","))))
        return
    if a.cmd == "chain":
        base = f"{a.tag}-ch-{a.scenario}-{a.router}-{a.experts}" + ("-greedy" if a.greedy_stall else "") + f"-{a.seed}"
        procs = shards_up(base, [a.scenario], a.worlds.split(","), 3 if "," in a.worlds and len(a.worlds.split(",")) > 2 else 2, 2, 7000 + a.seed, runs / "chain.log")
        try:
            rt = "rules" if a.router == "rules" else f"{a.router}:{runs / 'router' / ('router.' + a.router)}"
            ek = "solver" if a.experts == "solver" else f"net:{runs}"
            args = ["chain", "--root", str(X), "--base", base, "--shards", ",".join(str(i) for i in range(3 if len(a.worlds.split(",")) > 2 else 2)), "--router", rt, "--experts", ek, "--episodes", str(a.episodes), "--scenario", a.scenario,
                    "--out", str(runs / a.out), "--timeout", "3000"] + (["--greedy-stall"] if a.greedy_stall else []) + (["--trace", str(a.trace)] if a.trace else []) + (["--trace-fail"] if a.trace_fail else []) + (["--trace-steps"] if a.trace_steps else []) + (["--dump-states", str(runs / a.dump_states)] if a.dump_states else [])
            print(cli(args, runs / "chain.log", timeout=7200))
        finally:
            shards_down(procs)
            cleanup(base)


if __name__ == "__main__":
    main()
