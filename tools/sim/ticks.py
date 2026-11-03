#!/usr/bin/env python3
"""Ticks per successful command, real vs simulator: median, mean, 90th percentile, and n.   ticks.py --real <run dir>.. --sim <run dir>.."""
import argparse, json, statistics as st, collections
ap = argparse.ArgumentParser(); ap.add_argument('--real', nargs='+', required=True); ap.add_argument('--sim', nargs='+', required=True); a = ap.parse_args()
def load(ds):
    t = collections.defaultdict(list)
    for d in ds:
        for l in open(d + '/events.jsonl'):
            r = json.loads(l)
            if r.get('event') == 'step' and r['reason'] == 'ok': t[r['cmd']].append(r['ticks'])
    return t
R, S = load(a.real), load(a.sim)
q = lambda v, f: sorted(v)[int(f * (len(v) - 1))]
print(f"{'command':9} {'n real':>7} {'n sim':>8} | {'median r/s':>11} {'mean r/s':>13} {'q90 r/s':>11} | mean ratio")
for c in sorted(set(R) | set(S), key=lambda c: -len(R.get(c, []))):
    r, s = R.get(c, []), S.get(c, [])
    if len(r) < 5 or len(s) < 5: continue
    print(f"{c:9} {len(r):7d} {len(s):8d} | {st.median(r):5.0f}/{st.median(s):<5.0f} {st.mean(r):6.1f}/{st.mean(s):<6.1f} {q(r, .9):5.0f}/{q(s, .9):<5.0f} | {st.mean(s) / st.mean(r):.2f}")
