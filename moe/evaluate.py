"""Evaluation of a policy on running shards: success rate with a Wilson 95 % interval, commands per episode, outcomes (success / timeout / died)."""
import collections
import json
import math
import time


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def run(vec, decide, episodes, timeout_s=600, on_episode=None):
    """Play until `episodes` episodes ended. `decide(list of Obs) -> list of candidate indices`. Returns a summary dict."""
    outcomes, lengths = collections.Counter(), []
    t0 = time.time()
    n_done = 0
    while n_done < episodes and time.time() - t0 < timeout_s:
        obs = vec.poll()
        if not obs:
            time.sleep(0.0003)
            continue
        live = []
        for ob in obs:
            if ob.terminated:
                if ob.step > 0:                      # (a terminal observation at step 0 would be a leftover of a restart)
                    outcomes[ob.outcome or "?"] += 1
                    lengths.append(ob.step)
                    n_done += 1
                    if on_episode:
                        on_episode(ob)
            else:
                live.append(ob)
        if live:
            for ob, a in zip(live, decide(live)):
                vec.act(ob, a)
    n = sum(outcomes.values())
    k = outcomes["success"]
    lo, hi = wilson(k, n)
    return {"episodes": n, "success": k, "rate": k / n if n else 0.0, "wilson95": [round(lo, 3), round(hi, 3)], "outcomes": dict(outcomes),
            "mean_commands": sum(lengths) / len(lengths) if lengths else 0.0, "seconds": round(time.time() - t0, 1)}


def line(name, s):
    return json.dumps(dict(name=name, **s))
