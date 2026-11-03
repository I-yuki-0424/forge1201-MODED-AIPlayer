#!/usr/bin/env python3
"""Why does the simulator differ from the real game? Cause-level comparison of two sets of run directories (events.jsonl written by
the real environment and, since 2026-11-03, by the simulator; env_to_policy.jsonl for what the bots saw):

  python3 tools/sim/causes.py --real exchange/val-s0-... exchange/val-s1-... --sim exchange/valsim-s0-... [--data tools/sim/data/data.json]

Prints, real | sim, per 1,000 game seconds so runs of different length compare:
  1. damage by (damage type, attacker): hp lost and number of hits, plus deaths per hour and the real server's death messages
  2. exposure: share of observations with a hostile within 16 blocks, by time of day and by kind; hostile within 4 blocks
  3. failure reasons per command, with the share that happened in a command that also took damage
Nothing here is fitted: it is a table, and the reading is the reader's (docs/proposed/SIM-RUST-v1.md section 11)."""
import argparse, collections, glob, json, math, sys

HOST = {'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'spider', 'cave_spider', 'creeper', 'enderman', 'witch', 'zombie_villager', 'pillager', 'phantom', 'slime', 'silverfish'}

def steps(dirs):
    for d in dirs:
        try:
            for l in open(d + '/events.jsonl'):
                r = json.loads(l)
                if r.get('event') == 'step': r['_run'] = d; yield r
        except FileNotFoundError: pass

def damage(rows):
    hp = collections.Counter(); n = collections.Counter(); ticks = 0; deaths = 0; msgs = collections.Counter(); stuck = 0
    for r in rows:
        ticks += r['ticks']
        for d in r.get('dmg') or []:
            if d['k'] == 'hit': k = (d.get('src') or '?', d.get('by') or '-'); hp[k] += d.get('d') or 0; n[k] += 1
            elif d['k'] == 'loss': hp[('no event', '-')] += d.get('d') or 0; n[('no event', '-')] += 1
            elif d['k'] == 'death': deaths += 1; msgs[d['msg']] += 1
        if r.get('died'): deaths += 1
    return hp, n, ticks, deaths, msgs

def exposure(dirs, ents):
    tot = [0, 0]; night = [0, 0]; day = [0, 0]; near = 0; kinds = collections.Counter(); n = 0; bk = collections.Counter()
    for d in dirs:
        try: f = open(d + '/env_to_policy.slim.jsonl')
        except FileNotFoundError:
            try: f = open(d + '/env_to_policy.jsonl')
            except FileNotFoundError: continue
        for l in f:
            if '"type":"obs"' not in l: continue
            o = json.loads(l)['obs']; n += 1
            hs = [(ents[i], o['ent_feat'][k][3] * 16) for k, i in enumerate(o['ent_type']) if i and ents[i] in HOST]
            nt = o['self'][12] > 0.5
            (night if nt else day)[0] += 1
            if hs:
                (night if nt else day)[1] += 1
                for nm in {h[0] for h in hs}: kinds[nm] += 1
                nd = min(h[1] for h in hs)
                if nd <= 4: near += 1
                bk['<=2' if nd <= 2 else '<=4' if nd <= 4 else '<=8' if nd <= 8 else '<=16'] += 1
    return n, day, night, near, kinds, bk

def fails(rows):
    out = collections.defaultdict(collections.Counter); hurt = collections.defaultdict(collections.Counter); cnt = collections.Counter()
    for r in rows:
        cnt[r['cmd']] += 1
        out[r['cmd']][r['reason']] += 1
        if r['reason'] != 'ok' and any((d.get('d') or 0) > 0 for d in r.get('dmg') or []): hurt[r['cmd']][r['reason']] += 1
    return out, hurt, cnt

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--real', nargs='+', required=True); ap.add_argument('--sim', nargs='+', required=True); ap.add_argument('--data', default='tools/sim/data/data.json'); ap.add_argument('--real-obs', nargs='*', default=None, help='more real run directories for the exposure section only (runs without the damage log)')
    a = ap.parse_args()
    ents = json.load(open(a.data))['entities']
    R, S = list(steps(a.real)), list(steps(a.sim))
    hr, nr, tr, dr, mr = damage(R); hs, ns, ts, ds, ms = damage(S)
    hours = lambda t: t / 20 / 3600
    print(f"steps real {len(R)} ({hours(tr):.2f} h of bot time)   sim {len(S)} ({hours(ts):.2f} h)\n")
    print("1. hp lost per bot-hour, by (damage type, attacker)            real            sim")
    for k in sorted(set(hr) | set(hs), key=lambda k: -(hr[k] + hs[k])):
        print(f"   {k[0]:18} {k[1]:14} {hr[k] / max(hours(tr), 1e-9):8.1f} ({nr[k]:4d} hits)  {hs[k] / max(hours(ts), 1e-9):8.1f} ({ns[k]:5d} hits)")
    print(f"   total{'':28} {sum(hr.values()) / max(hours(tr), 1e-9):8.1f}              {sum(hs.values()) / max(hours(ts), 1e-9):8.1f}")
    print(f"   deaths per bot-hour: real {dr / max(hours(tr), 1e-9):.2f}  sim {ds / max(hours(ts), 1e-9):.2f}   real death messages: {dict(mr.most_common(6))}\n")
    er, es = exposure(a.real + (a.real_obs or []), ents), exposure(a.sim, ents)
    print("2. exposure (observations with a hostile within 16 blocks)       real            sim")
    p = lambda x, y: x / y if y else 0.0
    print(f"   day   {p(er[1][1], er[1][0]):.3f}  ({er[1][0]} obs)                  {p(es[1][1], es[1][0]):.3f}  ({es[1][0]} obs)")
    print(f"   night {p(er[2][1], er[2][0]):.3f}  ({er[2][0]} obs)                  {p(es[2][1], es[2][0]):.3f}  ({es[2][0]} obs)")
    print(f"   nearest hostile, share of all observations: " + "  ".join(f"{b} real {p(er[5][b], er[0]):.3f} / sim {p(es[5][b], es[0]):.3f}" for b in ('<=2', '<=4', '<=8', '<=16')))
    for k in sorted(set(er[4]) | set(es[4]), key=lambda k: -(er[4][k] + es[4][k]))[:8]:
        print(f"   {k:14} {p(er[4][k], er[0]):.3f}                               {p(es[4][k], es[0]):.3f}")
    print("\n3. non-ok outcomes per command (share of that command's steps; in brackets: share of the failures in a command that also took damage)")
    fr, hr2, cr = fails(R); fs, hs2, cs = fails(S)
    for c in sorted(set(cr) | set(cs), key=lambda c: -(cr[c] + cs[c])):
        def f(F, H, C):
            bad = [(k, v) for k, v in F[c].most_common() if k != 'ok']
            return ' '.join(f"{k} {v / C[c]:.2f}" + (f"[{H[c][k] / v:.0%}]" if H[c][k] else '') for k, v in bad[:4]) or '-'
        print(f"   {c:9} real n={cr[c]:5d}: {f(fr, hr2, cr)}\n   {'':9} sim  n={cs[c]:5d}: {f(fs, hs2, cs)}")
    print("\n4. repeated failures (one cause counted many times)")
    print_loops("real", R); print_loops("sim", S)

def loops(rows):
    """A failing command the policy repeats on the same target is one cause counted many times: failures vs distinct (bot, episode, target)."""
    rep = collections.defaultdict(collections.Counter)
    for r in rows:
        if r['reason'] != 'ok': rep[(r['cmd'], r['reason'])][(r['_run'], r['env_id'], r['episode'], json.dumps(r.get('args'), sort_keys=True))] += 1
    return rep

def print_loops(title, rows):
    rep = loops(rows)
    print(f"   {title}")
    for k, c in sorted(rep.items(), key=lambda kv: -sum(kv[1].values()))[:8]:
        n = sum(c.values())
        print(f"     {k[0]:9} {k[1]:15} {n:5d} failures from {len(c):4d} distinct targets; the most repeated: {[v for _, v in c.most_common(3)]}")

main()
