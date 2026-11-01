#!/usr/bin/env python3
"""Training status from the run files (no server access): scripts/train/summary.py <exchange> <base>
Per bot of the live run: steps, commands by kind with their success rate, failure reasons, deaths, reward per term;
learner: last update, stage, episodes."""
import collections
import json
import sys
from pathlib import Path


def lines(p):
    try:
        with open(p) as f:
            for x in f:
                try:
                    yield json.loads(x)
                except ValueError:
                    pass
    except OSError:
        return


root, base = Path(sys.argv[1]), sys.argv[2]
run = (root / f"{base}.current").read_text().strip()
steps = collections.defaultdict(collections.Counter)
ok = collections.defaultdict(collections.Counter)
reasons, terms, eps, errs = collections.Counter(), collections.Counter(), [], []
for e in lines(root / run / "events.jsonl"):
    ev = e.get("event")
    if ev == "step":
        steps[e["env_id"]][e["cmd"]] += 1
        ok[e["env_id"]][e["cmd"]] += e["ok"]
        if not e["ok"]:
            reasons[f'{e["cmd"]}:{e["reason"]}'] += 1
        for k, v in (e.get("terms") or {}).items():
            terms[k] += v
    elif ev == "episode_end":
        eps.append(e)
    elif e.get("level") in ("warn", "error"):
        errs.append(e)
print(f"run {run}: {sum(sum(c.values()) for c in steps.values())} steps, {len(eps)} episodes ended")
for b in sorted(steps):
    print(f"  bot {b}: " + ", ".join(f"{k} {v} ({ok[b][k] / v:.0%} ok)" for k, v in steps[b].most_common()))
print("  failures:", ", ".join(f"{k} {v}" for k, v in reasons.most_common(8)) or "none")
print("  reward by term:", ", ".join(f"{k} {v:.3f}" for k, v in terms.items()) or "none")
for e in eps[-5:]:
    print(f"  episode bot {e['env_id']} #{e['episode']}: return {e['return']}, nights {e['nights']} (slept {e['slept']}), {e['wall_s']} s, died {e['terminated']}")
for e in errs[-3:]:
    print(f"  {e['level']}: {e['event']} {json.dumps({k: v for k, v in e.items() if k not in ('schema', 'ts', 'seq', 'run_id', 'bot_id', 'component', 'level', 'event')})[:200]}")
tl = list(lines(root / base / "train" / "train_log.jsonl"))
up = [x for x in tl if x.get("event") == "update"]
model = [x for x in tl if x.get("event") == "model"]
if model:
    m = model[-1]
    print(f"learner: {m['name']} params {m['params_total']}, learn={m['learn']}" + (f", stage {m['stage']}" if "stage" in m else "")
          + (f", init {m['init']}" if m.get("init") else ""))
if up:
    u = up[-1]
    print(f"  update {u['update']}: steps {u['total_steps']}" + (f", stage {u['stage']}" if "stage" in u else "")
          + f", entropy {u['ent']:.3f}, kl {u['kl']:.4f}, staleness {u['staleness_mean']}")
    if "goals" in u:   # GoalWM learner (DPOD botsystem_goal_ppo.py)
        g = u["goals"]
        print(f"  goals: reached {g['reached']} of {g['assigned']} assigned (task goals {g['task_reached']} of {g['task_assigned']}), "
              f"archive {u['archive']} dims, replay {u['replay']}; world model ok {u['aux_ok']:.3f} inv {u['aux_inv']:.3f} reach {u['aux_reach']:.3f}; "
              f"u_gain {u['u_gain']:.3f}")
        print(f"  most tried goals: {u['top_goals']}")
for x in tl:
    if x.get("event") == "stage_switch":
        print(f"  stage switch -> {x['to']}: {x['reason']}")
