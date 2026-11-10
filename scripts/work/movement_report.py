#!/usr/bin/env python3
"""Movement-related error rates of the work console from its logs (problems.jsonl[.1], health.jsonl[.1]) in two windows: before and after a time (epoch seconds, e.g. a deploy).
A record is movement-related when a walk failed: reason unreachable / stuck / timeout / wrong_dimension with a `why` about getting somewhere (not the aim: `reach block`; not a bridge).
Usage: movement_report.py DATA_DIR SPLIT_EPOCH [HOURS_BEFORE=3] [HOURS_AFTER=all]. Test/analysis code, throwaway-grade."""
import json, sys, collections, os

MOVE_WHY = ('could not get to the container', 'too far from the station', 'far from the job', 'walking back to the job failed', 'start cell not standable', 'still far from the station', 'target chunk not loaded', 'end of partial path', 'no leg of any length')
MOVE_REASON = ('unreachable', 'stuck', 'timeout', 'wrong_dimension')

def load(path_base, name):
    out = []
    for suf in ('.1', ''):
        p = os.path.join(path_base, name + suf)
        if os.path.exists(p):
            for l in open(p, errors='replace'):
                try: out.append(json.loads(l))
                except Exception: pass
    return out

def window(problems, health, t0, t1):
    hp = [h for h in health if t0 <= h['t'] / 1000 < t1]
    minutes = sum(h['sec'] for h in hp) / 60 or 1
    bot_min = sum(h['working'] * h['sec'] for h in hp) / 60 or 1
    units = sum(h['done'] for h in hp); failed = sum(h['failed'] for h in hp)
    pr = [p for p in problems if t0 <= p['t'] / 1000 < t1 and p.get('kind') in ('unit_failed', 'janitor_failed')]
    mv = [p for p in pr if p.get('reason') in MOVE_REASON and any(w in (p.get('why') or '') for w in MOVE_WHY)]
    by = collections.Counter((p.get('kind'), p.get('stage'), (p.get('why') or '')[:48]) for p in mv)
    lag = [h['lagMs'] for h in hp] or [0]
    return dict(minutes=round(minutes, 1), working_bots=round(bot_min / minutes, 1), units=units, units_per_min=round(units / minutes, 2), failed_units=failed,
                movement_failures=len(mv), movement_failures_per_min=round(len(mv) / minutes, 2), movement_failures_per_working_bot_hour=round(len(mv) / (bot_min / 60), 1),
                movement_failures_per_100_unit_attempts=round(100 * len(mv) / max(1, units + failed), 1), lag_avg_ms=round(sum(lag) / len(lag)), lag_max_ms=max(lag), top=by.most_common(5))

if __name__ == '__main__':
    d, split = sys.argv[1], float(sys.argv[2]); hb = float(sys.argv[3]) if len(sys.argv) > 3 else 3
    pa = load(d, 'problems.jsonl'); he = load(d, 'health.jsonl'); end = 1e12
    print(json.dumps({'before': window(pa, he, split - hb * 3600, split), 'after': window(pa, he, split, end)}, indent=1))
