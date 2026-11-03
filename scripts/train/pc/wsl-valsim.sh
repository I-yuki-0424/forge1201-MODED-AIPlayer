#!/usr/bin/env bash
# Simulator validation on the PC (inside WSL2): N shards x 2 bots on the validation tiles with the stand-in policy (the DPOD scripted
# teacher), `mins` minutes; the output directories come back to the VPS for tools/sim/causes.py and compare.py. Same rules as
# scripts/train/validate-sim.sh sim, with the PC's 16 threads instead of the VPS's 6 vCPU shared with the real servers.
#   wsl-valsim.sh [mins=14] [shards=4]
mins=${1:-14}; shards=${2:-4}; X=$HOME/xval
BIN=~/sim/forgeaip-sim; [ -f /mnt/c/forgeaip/dl/forgeaip-sim.val ] && { cp /mnt/c/forgeaip/dl/forgeaip-sim.val ~/sim/forgeaip-sim.val; chmod +x ~/sim/forgeaip-sim.val; BIN=~/sim/forgeaip-sim.val; }   # a new binary can be tried while training runs with the old one
rm -rf "$X"; mkdir -p "$X" ~/sim/tilesval; cp -n /mnt/c/forgeaip/dl/tilesval/*.tile ~/sim/tilesval/; cp /mnt/c/forgeaip/dl/smoke_policy.py ~/sim/
for i in $(seq 0 $((shards - 1))); do
  w=$((i % 2))
  timeout $((mins * 60 + 30)) "$BIN" run --root "$X" --base valsim --shard "$i" --bots 2 --days 3 --tiles ~/sim/tilesval --world "vps-s$w" \
    --reward ~/sim/r/reward-v6.json --progress ~/sim/r/progress-list.json --seed $((77 + i)) > "$X/shard$i.log" 2>&1 < /dev/null &
done
sleep 3
for i in $(seq 0 $((shards - 1))); do
  PYTHONPATH=$HOME/dpod nohup "$HOME/gpuvenv/bin/python" -W ignore ~/sim/smoke_policy.py "$X" valsim "$i" $((mins * 60)) ~/dpod/scripts teacher "$X/val-sim-s$i.jsonl" > "$X/policy$i.log" 2>&1 < /dev/null &
done
wait
echo "done: $(cat $X/val-sim-s*.jsonl | wc -l) steps"
