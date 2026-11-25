#!/usr/bin/env python3
"""scripts/t26/speed_report.py RUN [RUN ...]   one line per run of speed_ab.sh (docs/implemented/SPEED-v1.md, TASK-20261125-079): speed asked, tick rate achieved (the server's game time over
wall time while the test ran), ms per tick (mean of the samples, worst P95 and P99), the server's CPU (mean and peak, % of one core), the harness's event loop (worst p99 and max) and CPU,
the test's wall time and its result per trial. Reads /mnt/data/forgeaip-play/t26/out/<RUN>/ (speed-w*.jsonl, <test>-w*.json, <test>-w*.log)."""
import glob, json, os, re, statistics, sys

HOME = "/mnt/data/forgeaip-play/t26/out"


def run_line(run):
    d = os.path.join(HOME, run)
    rep = [json.load(open(f)) for f in glob.glob(f"{d}/*-w[0-9].json")]
    rows = [json.loads(l) for f in glob.glob(f"{d}/speed-w*.jsonl") for l in open(f) if l.strip()]
    rows = [r for r in rows if r.get("gametime") is not None]
    srv = [r for r in rows if any(n.startswith("live-") for n in r["cpu"])]          # the samples while the harness ran
    out = {"run": run}
    if rep:
        r = rep[0]
        out.update(seed=r.get("seed"), speed=r.get("speed"), sec=r.get("sec"), passed=f"{r.get('passed')}/{len(r.get('trials', []))}",
                   trials=[(t["bot"], t["ok"], (t.get("detail") or {}).get("sec"), (t.get("detail") or {}).get("ticks")) for t in r.get("trials", [])])
    if len(srv) >= 2:
        a, b = srv[0], srv[-1]
        out["tps"] = round((b["gametime"] - a["gametime"]) / (b["t"] - a["t"]), 1)
        out["target"] = a["target_tps"]
        ms = [r["mspt"] for r in srv if r["mspt"] is not None]
        out["mspt_mean"] = round(statistics.mean(ms), 1) if ms else None
        out["p95_max"] = max((r["p95"] or 0) for r in srv); out["p99_max"] = max((r["p99"] or 0) for r in srv)
        sc = [v for r in srv for n, v in r["cpu"].items() if not n.startswith("live-")]
        hc = [v for r in srv for n, v in r["cpu"].items() if n.startswith("live-")]
        out["srv_cpu"] = f"{round(statistics.mean(sc))}/{round(max(sc))}" if sc else None
        out["harness_cpu"] = f"{round(statistics.mean(hc))}/{round(max(hc))}" if hc else None
        out["host_load"] = round(statistics.mean(r["load"] for r in srv), 1)
        hb = [r["host_busy"] for r in srv if r.get("host_busy") is not None]; st = [r["steal"] for r in srv if r.get("steal") is not None]
        out["host_busy"] = round(statistics.mean(hb)) if hb else None; out["steal"] = round(statistics.mean(st), 1) if st else None
        # the achieved rate minute by minute: the worst minute says whether the factor was kept all the way, not only on average
        per = [(b["gametime"] - a["gametime"]) / (b["t"] - a["t"]) for a, b in zip(srv, srv[1:]) if b["t"] > a["t"] and b["gametime"] >= a["gametime"]]
        out["tps_min"] = round(min(per), 1) if per else None
    lag = []
    for f in glob.glob(f"{d}/*-w[0-9].log"):
        for m in re.finditer(r"\[loop\] lag p50 (\d+) p99 (\d+) max (\d+) ms \| cpu (\d+) %", open(f, errors="replace").read()):
            lag.append(tuple(map(int, m.groups())))
    if lag:
        out["loop_p99_max"] = max(x[1] for x in lag); out["loop_max"] = max(x[2] for x in lag); out["node_cpu_mean"] = round(statistics.mean(x[3] for x in lag))
    return out


for run in sys.argv[1:]:
    print(json.dumps(run_line(run)))
