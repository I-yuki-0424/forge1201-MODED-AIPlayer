#!/usr/bin/env python3
"""Placing pace of a build_t run per 10 minutes (TASK-20261125-081): blocks placed, the share of bot time in supply trips and walking, clicks dropped (clickGone),
blocks off their cell (misplaced), the machine's mid-build moves, from the log's [progress N min] lines.

Usage: pace_report.py LOG [--step 10]
"""
import json
import re
import sys


def rows(path):
    for line in open(path, errors='replace'):
        m = re.match(r'\[progress (\d+) min\].*? work (\{[^}]*\}).*? time (\{[^}]*\}) stats (\{.*\})\s*$', line.strip())
        if not m:
            continue
        try:
            work, time = json.loads(m.group(2)), json.loads(m.group(3))
        except ValueError:
            continue
        stats = m.group(4)
        num = lambda k: int((re.search(r'"%s":(\d+)' % k, stats) or [0, 0])[1])
        yield int(m.group(1)), work, time, {k: num(k) for k in ('placed', 'clickGone', 'misplaced', 'machineMoved', 'packDeposits', 'trips', 'deaths')}


def main():
    a = sys.argv[1:]
    step = int(a[a.index('--step') + 1]) if '--step' in a else 10
    path = a[0]
    by = {}
    for m, w, t, s in rows(path):
        by[m] = (w, t, s)
    ms = sorted(by)
    if not ms:
        print('no progress lines'); return
    print(f'== {path}')
    print(' minutes     placed  /min   trip %  walk %  clickGone  misplaced  machineMoved  packDeposits  to place')
    prev = None
    for m in ms:
        if prev is not None and m - prev < step and m != ms[-1]:
            continue
        if prev is None:
            prev = m; continue
        (w0, t0, s0), (w1, t1, s1) = by[prev], by[m]
        dt = max(1, m - prev)
        tot = sum(t1.values()) - sum(t0.values())
        share = lambda k: 100.0 * (t1.get(k, 0) - t0.get(k, 0)) / tot if tot > 0 else 0.0
        placed = s1['placed'] - s0['placed']
        d = lambda k: s1[k] - s0[k]
        print(f' {prev:3d}-{m:3d}   {placed:6d} {placed / dt:5.1f}   {share("trip"):5.1f}   {share("walk"):5.1f}   {d("clickGone"):8d}   {d("misplaced"):8d}   {d("machineMoved"):11d}   {d("packDeposits"):11d}   {w1.get("place", 0):7d}')
        prev = m


if __name__ == '__main__':
    main()
