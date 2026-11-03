#!/usr/bin/env python3
"""Mean ticks per phase of successful commands, real vs simulator (the `ph` field of events.jsonl: [[phase, first tick]]); a phase lasts until
the next one starts, the last until the command ends.   phases.py --real <run dir>.. --sim <run dir>.."""
import argparse, json, collections, statistics as st
ap = argparse.ArgumentParser(); ap.add_argument('--real', nargs='+', required=True); ap.add_argument('--sim', nargs='+', required=True); a = ap.parse_args()
def load(ds):
    dur = collections.defaultdict(lambda: collections.defaultdict(float)); n = collections.Counter(); tot = collections.Counter()
    for d in ds:
        for l in open(d + '/events.jsonl'):
            r = json.loads(l)
            if r.get('event') != 'step' or r['reason'] != 'ok' or not r.get('ph'): continue
            c = r['cmd']; n[c] += 1; tot[c] += r['ticks']; ph = r['ph']
            for i, (nm, t) in enumerate(ph):
                if nm in ('plan', 'approach', 'replan', 'go_to_item', 'chase'): nm = 'walk' if nm != 'chase' else nm
                dur[c][nm] += (ph[i + 1][1] if i + 1 < len(ph) else r['ticks']) - t
    return dur, n, tot
R, S = load(a.real), load(a.sim)
for c in ('mine', 'tunnel', 'move_to', 'place', 'craft'):
    if not R[1][c] or not S[1][c]: continue
    print(f"{c}: mean ticks real {R[2][c] / R[1][c]:.1f} (n {R[1][c]})  sim {S[2][c] / S[1][c]:.1f} (n {S[1][c]})")
    for nm in sorted(set(R[0][c]) | set(S[0][c]), key=lambda k: -R[0][c].get(k, 0)):
        r, s_ = R[0][c].get(nm, 0) / R[1][c], S[0][c].get(nm, 0) / S[1][c]
        if r + s_ >= 0.3: print(f"    {nm:20} real {r:6.1f}  sim {s_:6.1f}  per command")
