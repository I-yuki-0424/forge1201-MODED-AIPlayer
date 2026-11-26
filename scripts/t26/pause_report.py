#!/usr/bin/env python3
"""The pause table of build_t runs (src/build/pauses.js): sums the per-minute `[pauses N min]` lines of each log.

    python3 scripts/t26/pause_report.py LOG [LOG ...] [--from MIN] [--to MIN]

Prints per log: pauses over 0.5 s, their seconds, by class (cpu, retry, bot, server, other) and by label, plus the progress line's
bot time (walk, dig, place ...) at the last minute in range, so the pause seconds can be read against the crew's time.
"""
import json, re, sys

def main(argv):
    lo, hi, logs = 0, 10**9, []
    i = 0
    while i < len(argv):
        if argv[i] == '--from': lo = int(argv[i + 1]); i += 2; continue
        if argv[i] == '--to': hi = int(argv[i + 1]); i += 2; continue
        logs.append(argv[i]); i += 1
    for path in logs:
        cls, lab, n, sec, mins, last = {}, {}, 0, 0, 0, None
        for line in open(path, errors='replace'):
            m = re.match(r'\[pauses (\d+) min\] (\{.*\})\s*$', line)
            if m and lo <= int(m.group(1)) <= hi:
                d = json.loads(m.group(2)); mins += 1; n += d['pauses']; sec += d['seconds']
                for k, v in d['byClass'].items(): c = cls.setdefault(k, [0, 0]); c[0] += v['n']; c[1] += v['s']
                for k, v in d['byLabel'].items(): c = lab.setdefault(k, [0, 0]); c[0] += v['n']; c[1] += v['s']
            p = re.match(r'\[progress (\d+) min\].* time (\{[^}]*\})', line)
            if p and lo <= int(p.group(1)) <= hi: last = (int(p.group(1)), json.loads(p.group(2)))
        print(f'== {path}: minutes {mins}, pauses over 0.5 s {n}, {sec} s')
        for k, (c, s) in sorted(cls.items(), key=lambda kv: -kv[1][1]): print(f'   {k:8s} {c:6d} pauses {s:7d} s  {100 * s / max(1, sec):5.1f} %')
        print('   by label:')
        for k, (c, s) in sorted(lab.items(), key=lambda kv: -kv[1][1])[:16]: print(f'     {s:7d} s {c:6d}x  {k}')
        if last: print(f'   bot time at minute {last[0]} (ms): {json.dumps(last[1])}')

if __name__ == '__main__':
    main(sys.argv[1:])
