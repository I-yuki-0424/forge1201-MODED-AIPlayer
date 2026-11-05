#!/usr/bin/env python3
"""Add readable tags and the iron-tier results to the MLflow runs that DPOD's scripts/mlflow_ingest_botsystem.py made from exchange/<base> (experiment side-botsystem).
DPOD's ingest knows only 'stop' events, so finished runs show RUNNING and no scenario is recorded; this adds, per run: tags forgeaip.scenario / forgeaip.state / forgeaip.note and
metrics reach_<entry> (share of episodes) and reach_<entry>_last_block (last block of 60 episodes) for the four iron-tier entries, parsed from scn_report.py / pc.sh wsl-report text.
  scripts/train/mlflow_tags.py            (host: gathers the reports, then runs the apply step in the dpod-mlflow container)
Files stay the source of truth; metrics are the printed report numbers of that moment (re-run after a run grew). Tags/metrics only, no artifacts."""
import json, os, re, subprocess, sys
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DPOD = os.path.abspath(os.path.join(REPO, "..", "Decision-Process-order-driven"))
# base -> (where the run lives, scenario, state, note)
META = {
 "iron-a": ("vps", "iron-a", "moved", "A on the VPS CPU: ~86k steps beyond runc, then continued on the PC as iron-a-g"),
 "iron-b": ("vps", "iron-b", "moved", "B on the VPS CPU: ~540k steps beyond runc, then continued on the PC as iron-b-g"),
 "iron-c": ("vps", "iron-c", "moved", "C on the VPS CPU: ~77k steps beyond runc, then continued on the PC as iron-c-g"),
 "iron-a-g": ("pc", "iron-a", "finished", "A (iron in front, furnace in the kit): 2 M steps from runc on the PC GPU; pickaxe 57 % in the last fifth"),
 "iron-b-g": ("pc", "iron-b", "finished", "B (furnace 3-5 blocks, iron 10-16 blocks away): 2 M steps; pickaxe 53 % and rising"),
 "iron-c-g": ("pc", "iron-c", "finished", "C (iron in front, furnace 50 blocks away): 2 M steps; pickaxe 73 %"),
 "main1": ("pc", "normal", "finished", "plain normal starts from runc, presentation fix only (control), 3 M steps: pickaxe 1 of 3169"),
 "normal-ap": ("vps", "normal", "stopped", "plain normal starts + fix + approach candidates on the VPS CPU; stopped at ~100k steps, flat"),
 "normal-kit": ("pc", "normal-kit", "stopped", "A/B/C materials without a furnace, natural iron; stopped at ~4.5 M to fork into kit-ctl and kit-mask"),
 "kit-ctl": ("pc", "normal-kit", "stopped", "fork of normal-kit WITHOUT the iron-sink mask (control), stopped at 6.3 M"),
 "kit-mask": ("pc", "normal-kit", "finished", "fork of normal-kit WITH the iron-sink mask, to 7.0 M: pickaxe 6.6 % overall, 18 % in the last block"),
 "normal-kit-c2": ("vps", "normal-kit", "stopped", "kit-mask continued on the VPS CPU (4 bots): unstable updates (clipfrac 0.2-0.4), stopped at 7.2 M"),
 "normal-mk": ("pc", "normal", "interrupted", "plain normal starts from runc with mask + approach + presentation fix; WSL VM restarted at ~12:26, relaunch scheduled 17:55 JST"),
}
ENTRIES = ["collect_iron", "smelt_iron", "craft_iron_pickaxe", "craft_iron_sword"]
LINE = re.compile(r"^\s+(%s)\s+(\d+)/(\d+)\s+([\d.]+)%%.*by block:\s*(.*)$" % "|".join(ENTRIES))
def parse(text):
    out, cur = {}, None
    for l in text.splitlines():
        m = re.match(r"^== (\S+): (\d+) episodes", l)
        if m: cur = m.group(1); out[cur] = {"episodes": int(m.group(2))}; continue
        m = LINE.match(l)
        if m and cur:
            blocks = [float(x) for x in m.group(5).split()]
            out[cur][m.group(1)] = {"k": int(m.group(2)), "n": int(m.group(3)), "last_block": blocks[-1] if blocks else None}
    return out
def gather():
    res = {}
    vps = [b for b, v in META.items() if v[0] == "vps"]; pc = [b for b, v in META.items() if v[0] == "pc"]
    r = subprocess.run([sys.executable, "-I", f"{REPO}/tools/sim/scn_report.py", f"{REPO}/exchange", *vps], capture_output=True, text=True); res.update(parse(r.stdout))
    r = subprocess.run([f"{REPO}/scripts/train/pc.sh", "wsl-report", *pc, "--blocks", "5"], capture_output=True, text=True); res.update(parse(r.stdout))
    return res
def apply(meta, rep):
    import mlflow
    from mlflow.tracking import MlflowClient
    c = MlflowClient(); exp = c.get_experiment_by_name("side-botsystem")
    runs = {r.data.tags.get("source_key", ""): r for r in c.search_runs([exp.experiment_id], max_results=500)}
    for base, (where, scn, state, note) in meta.items():
        r = runs.get(f"exchange/{base}")
        if not r: print("no run for", base); continue
        for k, v in (("forgeaip.scenario", scn), ("forgeaip.state", state), ("forgeaip.note", note), ("forgeaip.where", where)): c.set_tag(r.info.run_id, k, v)
        d = rep.get(base, {})
        for e in ENTRIES:
            if e in d:
                c.log_metric(r.info.run_id, f"reach_{e}", d[e]["k"] / max(1, d[e]["n"]))
                if d[e]["last_block"] is not None: c.log_metric(r.info.run_id, f"reach_{e}_last_block", d[e]["last_block"])
        if "episodes" in d: c.log_metric(r.info.run_id, "reach_episodes", d["episodes"])
        print(f"{base}: {state}, pickaxe {d.get('craft_iron_pickaxe', {}).get('k', '-')}/{d.get('craft_iron_pickaxe', {}).get('n', '-')}")
if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--apply":
        apply(META, json.load(open(sys.argv[2])))
    else:
        rep = gather(); tmp = f"{REPO}/exchange/.mlflow_tags.json"; json.dump(rep, open(tmp, "w"))
        subprocess.run(["docker", "run", "--rm", "-v", "dpod-mlflow:/venv:ro", "-v", f"{DPOD}/mlflow_local:/store", "-v", f"{REPO}:/repo:ro", "-e", "MLFLOW_TRACKING_URI=sqlite:////store/mlflow.db",
                        "python:3.12-slim", "/venv/bin/python", "/repo/scripts/train/mlflow_tags.py", "--apply", "/repo/exchange/.mlflow_tags.json"], check=True)
