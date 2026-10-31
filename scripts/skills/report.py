#!/usr/bin/env python3
"""Report on one or more command-benchmark runs (scripts/skills/bench.js); test tooling, stdlib only.

    python3 scripts/skills/report.py exchange/b1 [exchange/b2 ...]     per-command table (pooled), failures, disagreements
    python3 scripts/skills/report.py exchange/b1 --trace 37             timeline of one trial: phases, key changes, position

Rates come with Wilson 95 % intervals: 10 of 10 alone only bounds a command's true success rate at >= 0.72.
A pass is the SERVER's verdict (bench.js grades over RCON); `disagree` counts trials where the bot's own verdict differed.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return 0.0, 1.0
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


def load(run: Path) -> list[dict]:
    return [json.loads(line) for line in (run / "trials.jsonl").read_text().splitlines() if line.strip()]


def table(runs: list[Path]) -> None:
    rows = [dict(r, run=run.name) for run in runs for r in load(run)]
    by: dict[str, list[dict]] = {}
    for r in rows:
        by.setdefault(r["command"], []).append(r)
    print(f"runs: {', '.join(r.name for r in runs)}")
    print(f"{'command':10s} {'n':>4s} {'pass':>5s} {'rate':>6s}  {'wilson95':>13s} {'disagree':>8s} {'harness':>7s} {'median ticks':>12s}")
    tot_k = tot_n = 0
    for cmd in sorted(by):
        rs = by[cmd]
        valid = [r for r in rs if not r.get("harness_error")]
        k, n = sum(r["ok"] for r in valid), len(valid)
        lo, hi = wilson(k, n)
        dis = sum(1 for r in valid if r["bot"]["ok"] != r["ok"])
        ticks = sorted(r["ticks"] for r in valid) or [0]
        print(f"{cmd:10s} {n:4d} {k:5d} {k / max(n, 1):6.2f}  [{lo:.2f}, {hi:.2f}] {dis:8d} {len(rs) - n:7d} {ticks[len(ticks) // 2]:12d}")
        tot_k += k
        tot_n += n
    lo, hi = wilson(tot_k, tot_n)
    print(f"{'TOTAL':10s} {tot_n:4d} {tot_k:5d} {tot_k / max(tot_n, 1):6.2f}  [{lo:.2f}, {hi:.2f}]")
    bad = [r for r in rows if not r["ok"] or r.get("harness_error") or (r.get("bot") and r["bot"]["ok"] != r["ok"])]
    if bad:
        print("\nfailures, harness errors and disagreements:")
    for r in bad:
        if r.get("harness_error"):
            print(f"  {r['run']}#{r['n']:<4d} {r['command']:9s} HARNESS {r['harness_error']}")
            continue
        print(f"  {r['run']}#{r['n']:<4d} {r['command']:9s} bot={'ok' if r['bot']['ok'] else r['bot']['reason']} server={'ok' if r['ok'] else 'FAIL'} "
              f"args={json.dumps(r['args'])} scenario={json.dumps(r.get('scenario'))}")
        print(f"         bot detail={json.dumps(r['bot']['detail'])[:300]}  server={json.dumps(r['server']['measured'])[:200]}")


def timeline(run: Path, n: int) -> None:
    t = json.loads((run / "traces" / f"{n}.json").read_text())
    print(f"trial {n}: {t['command']} {json.dumps(t['args'])}")
    print(f"  bot: {json.dumps(t['result'])}")
    print(f"  server: {json.dumps(t['server'])}")
    phases: dict[int, list[dict]] = {}
    for p in t["phases"]:
        phases.setdefault(p["t"], []).append(p)
    prev_keys = None
    for row in t["trace"]:
        tick, phase, keys, x, y, z, vx, vy, vz, yaw, pitch, ground, slot = row
        ps = phases.pop(tick, [])
        for p in ps:
            print(f"  t={tick:<5d} PHASE {json.dumps({k: v for k, v in p.items() if k != 't'})}")
        if keys != prev_keys or ps:
            print(f"  t={tick:<5d} keys={keys:11s} pos=({x:9.3f},{y:8.3f},{z:9.3f}) v=({vx:6.3f},{vy:6.3f},{vz:6.3f}) "
                  f"yaw={yaw:6.3f} pitch={pitch:6.3f} ground={ground} slot={slot}")
            prev_keys = keys
    for ps in phases.values():
        for p in ps:
            print(f"  t={p['t']:<5d} PHASE {json.dumps({k: v for k, v in p.items() if k != 't'})}")
    if t["trace"]:
        print(f"  end t={t['trace'][-1][0]} pos=({t['trace'][-1][3]}, {t['trace'][-1][4]}, {t['trace'][-1][5]})")


def main(argv: list[str]) -> int:
    if "--trace" in argv:
        i = argv.index("--trace")
        timeline(Path(argv[0]), int(argv[i + 1]))
        return 0
    table([Path(a) for a in argv])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]) if len(sys.argv) > 1 else (print(__doc__) or 2))
