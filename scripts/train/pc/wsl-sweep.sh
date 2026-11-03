#!/usr/bin/env bash
# Calibration sweep on the PC (WSL2): V simulator variants run at once, each with its own FORGEAIP_MOBS overrides (tools/sim/src/mobs.rs `tune`),
# 2 shards x 2 bots on the validation tiles with the stand-in policy for `mins` minutes. Results (events.jsonl + slimmed observations) are left in
# C:\forgeaip\dl\sw<k>\ for tools/sim/causes.py on the VPS.    wsl-sweep.sh <mins> "<overrides 0>" "<overrides 1>" ...
mins=$1; shift
BIN=~/sim/forgeaip-sim.val; cp /mnt/c/forgeaip/dl/forgeaip-sim.val $BIN; chmod +x $BIN; mkdir -p ~/sim/tilesval; cp -n /mnt/c/forgeaip/dl/tilesval/*.tile ~/sim/tilesval/; cp /mnt/c/forgeaip/dl/smoke_policy.py ~/sim/
k=0
for ov in "$@"; do
  X=$HOME/xs$k; rm -rf "$X"; mkdir -p "$X"
  for i in 0 1; do
    FORGEAIP_MOBS="$ov" timeout $((mins * 60 + 30)) $BIN run --root "$X" --base valsim --shard $i --bots 2 --days 3 --tiles ~/sim/tilesval --world vps-s$i \
      --reward ~/sim/r/reward-v6.json --progress ~/sim/r/progress-list.json --seed $((77 + i)) > "$X/shard$i.log" 2>&1 < /dev/null &
  done
  sleep 2
  for i in 0 1; do
    PYTHONPATH=$HOME/dpod nohup "$HOME/gpuvenv/bin/python" -W ignore ~/sim/smoke_policy.py "$X" valsim $i $((mins * 60)) ~/dpod/scripts teacher "$X/val-sim-s$i.jsonl" > "$X/policy$i.log" 2>&1 < /dev/null &
  done
  k=$((k + 1))
done
wait
k=0
for ov in "$@"; do
  d=/mnt/c/forgeaip/dl/sw$k; rm -rf $d; mkdir -p $d
  for r in $HOME/xs$k/valsim-s*-sim*; do b=$(basename $r); mkdir -p $d/$b; cp $r/events.jsonl $d/$b/
    python3 - "$r" "$d/$b" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src + '/env_to_policy.jsonl') as f, open(dst + '/env_to_policy.slim.jsonl', 'w') as o:
    for l in f:
        if '"type":"obs"' not in l: continue
        x = json.loads(l); ob = x['obs']
        o.write(json.dumps({"type": "obs", "env_id": x["env_id"], "episode": x["episode"], "step": x["step"], "obs": {"ent_type": ob["ent_type"], "ent_feat": ob["ent_feat"], "self": ob["self"][:13], "dt_ticks": ob["dt_ticks"]}}, separators=(",", ":")) + "\n")
PY
  done
  echo "$k: $ov -> $(cat $HOME/xs$k/val-sim-s*.jsonl | wc -l) steps"; k=$((k + 1))
done
