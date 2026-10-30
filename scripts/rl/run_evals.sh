#!/usr/bin/env bash
# Final evaluation of a finished training run on fresh bots with seeds disjoint from training (9000+ vs 1000+).
#   scripts/rl/run_evals.sh run1            needs exchange/run1/train/final.pkl; writes exchange/run1/eval/<policy>/eval_<policy>.json
# Policies: learned (sampled), learned_greedy, random (uniform over the 270 actions), scripted (positive control, reads only
# declared observation fields). 64 episodes each (8 bots x 8). The collect scenario has only 8 initial headings, so "disjoint
# seeds" does not make the scenarios different from training: no generalisation claim.
set -euo pipefail
cd "$(dirname "$0")/../.."
DPOD="${DPOD_DIR:-$PWD/../Decision-Process-order-driven}"
for pol in learned learned_greedy random scripted; do
  rid="ev-$1-$pol"
  scripts/rl/envs.sh start "$rid" 8 9000 100000 >/dev/null 2>&1
  sleep 6
  docker run --rm --name rl-eval --cpus 2 --memory 2g -e PYTHONDONTWRITEBYTECODE=1 -v rl-jaxvenv:/venv:ro -v "$DPOD":/dpod:ro -v "$PWD/exchange":/x \
    python:3.12-slim /venv/bin/python /dpod/scripts/botsystem_ppo.py --mode eval --policy "$pol" --ckpt "/x/$1/train/final.pkl" --root /x --run "$rid" \
    --n-envs 8 --episodes 64 --out "/x/$1/eval/$pol" --idle-timeout 180 | tail -1
  scripts/rl/envs.sh stop "$rid"
done
