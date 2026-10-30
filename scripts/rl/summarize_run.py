#!/usr/bin/env python3
"""Print the training curve and per-update statistics of a run (test/report helper). Usage: summarize_run.py exchange/run1"""
import json, sys
from pathlib import Path

d = Path(sys.argv[1])
r = [json.loads(l) for l in open(d / "train" / "train_log.jsonl")]
print("upd steps  eps succ  ret   len  entropy  kl      clipfrac  vl     upd_s wall_s")
for x in r:
    print(f"{x['update']:3d} {x['steps_total']:6d} {x['batch_episodes']:3d} {x['successes']:3d} {x['mean_return']:5.2f} {x['mean_steps']:5.1f} {x['entropy']:7.3f} "
          f"{x['approx_kl']:7.4f} {x['clipfrac']:6.3f} {x['vl']:6.3f} {x['update_s']:5.1f} {x['wall_s']:6.0f}")
eps = [json.loads(l) for l in open(d / "train" / "episodes.jsonl")]
print(f"\nepisodes {len(eps)}, successes {sum(e['success'] for e in eps)}, truncated {sum(e['truncated'] for e in eps)}, mean steps {sum(e['steps'] for e in eps)/len(eps):.1f}")
