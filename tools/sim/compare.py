#!/usr/bin/env python3
"""Compare the simulator with the real Forge game on the same policy, sites and rules (scripts/train/validate-sim.sh).
  python3 tools/sim/compare.py <real steps.jsonl ...> -- <sim steps.jsonl ...>
Per command: share, success rate, failure reasons, median ticks of successful commands. Per episode: progress entries at the end
and at 1/3 and 2/3 of the 3 days, deaths, days survived, steps. Prints real | sim | ratio or difference, and flags what differs."""
import collections, json, statistics as st, sys

def load(paths):
    rows = []
    for p in paths:
        shard = p
        for l in open(p):
            r = json.loads(l); r["k"] = (shard, r["env"], r["ep"]); rows.append(r)
    return rows

def per_cmd(rows):
    out = {}
    by = collections.defaultdict(list)
    for r in rows: by[r["cmd"]].append(r)
    n = len(rows)
    for c, rs in by.items():
        ok = [r for r in rs if r["reason"] == "ok"]
        fails = collections.Counter(r["reason"] for r in rs if r["reason"] != "ok")
        out[c] = {"n": len(rs), "share": len(rs) / n, "ok": len(ok) / len(rs), "ticks": st.median([r["ticks"] for r in ok]) if ok else None,
                  "ticks_mean": st.mean([r["ticks"] for r in ok]) if ok else None, "fails": fails}
    return out

def episodes(rows):
    eps = collections.defaultdict(list)
    for r in rows: eps[r["k"]].append(r)
    res = []
    for k, rs in eps.items():
        rs.sort(key=lambda r: r["step"])
        done = rs[-1]["clock"] >= 0.999
        at = lambda f: max([r["n_prog"] for r in rs if r["clock"] <= f] or [0])
        res.append({"done": done, "end": rs[-1]["n_prog"], "d1": at(1 / 3), "d2": at(2 / 3), "reached_d1": rs[-1]["clock"] >= 1 / 3, "reached_d2": rs[-1]["clock"] >= 2 / 3,
                    "deaths": sum(1 for r in rs if (r.get("terms") or {}).get("death", 0) < 0), "surv": sum((r.get("terms") or {}).get("survival", 0) for r in rs),
                    "steps": len(rs), "ret": sum(r["reward"] for r in rs)})
    return res

def fmt(x, d=2):
    return "-" if x is None else (f"{x:.{d}f}" if isinstance(x, float) else str(x))

def main():
    a = sys.argv[1:]
    if "--" not in a: sys.exit(__doc__)
    i = a.index("--")
    real, sim = load(a[:i]), load(a[i + 1:])
    print(f"steps: real {len(real)}  sim {len(sim)}\n")
    cr, cs = per_cmd(real), per_cmd(sim)
    print(f"{'command':10} {'n real':>7} {'n sim':>8} | {'share real':>10} {'share sim':>9} | {'ok real':>7} {'ok sim':>7} | {'ticks real':>10} {'ticks sim':>9} {'ratio':>6}")
    for c in sorted(set(cr) | set(cs), key=lambda c: -(cr.get(c, {}).get("n", 0))):
        r, s = cr.get(c), cs.get(c)
        ratio = (s["ticks"] / r["ticks"]) if r and s and r["ticks"] and s["ticks"] else None
        print(f"{c:10} {fmt(r and r['n']):>7} {fmt(s and s['n']):>8} | {fmt(r and r['share']):>10} {fmt(s and s['share']):>9} | {fmt(r and r['ok']):>7} {fmt(s and s['ok']):>7} | {fmt(r and r['ticks'], 1):>10} {fmt(s and s['ticks'], 1):>9} {fmt(ratio):>6}")
    print("\nfailure reasons per command (real | sim):")
    for c in sorted(set(cr) | set(cs)):
        fr = dict(cr.get(c, {}).get("fails", collections.Counter()).most_common(4)); fs = dict(cs.get(c, {}).get("fails", collections.Counter()).most_common(4))
        if fr or fs: print(f"  {c:9} {fr}  |  {fs}")
    er, es = episodes(real), episodes(sim)
    def agg(e, key, only=None):
        v = [x[key] for x in e if (only is None or x[only])]
        return (len(v), st.mean(v) if v else None, st.median(v) if v else None)
    print("\nepisodes (mean; n in brackets) real | sim")
    for label, key, only in (("progress at 1/3 of the run", "d1", "reached_d1"), ("progress at 2/3", "d2", "reached_d2"), ("progress at the end (finished episodes)", "end", "done"),
                             ("deaths per finished episode", "deaths", "done"), ("survival reward (days survived)", "surv", "done"), ("steps per finished episode", "steps", "done"), ("return", "ret", "done")):
        nr, mr, _ = agg(er, key, only); ns, ms, _ = agg(es, key, only)
        print(f"  {label:42} real {fmt(mr):>6} [{nr}]   sim {fmt(ms):>6} [{ns}]")

main()
