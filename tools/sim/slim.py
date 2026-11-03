#!/usr/bin/env python3
"""Reduce env_to_policy.jsonl of run directories to what tools/sim/causes.py reads (entities, health, food, night flag, dt_ticks), written
next to it as env_to_policy.slim.jsonl: ~1 % of the size, so a validation run can be moved between machines.   slim.py <run dir>..."""
import json, sys
for d in sys.argv[1:]:
    n = 0
    with open(d + "/env_to_policy.jsonl") as f, open(d + "/env_to_policy.slim.jsonl", "w") as o:
        for l in f:
            if '"type":"obs"' not in l: continue
            r = json.loads(l); ob = r["obs"]
            o.write(json.dumps({"type": "obs", "env_id": r["env_id"], "episode": r["episode"], "step": r["step"], "obs": {"ent_type": ob["ent_type"], "ent_feat": ob["ent_feat"], "self": ob["self"][:13], "dt_ticks": ob["dt_ticks"]}}, separators=(",", ":")) + "\n"); n += 1
    print(d, n, "observations")
