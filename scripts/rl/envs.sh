#!/usr/bin/env bash
# Start / stop N environment processes (one bot, one arena each) against the RL server.
#   scripts/rl/envs.sh start <run> <n> <seed> <episodes>     run ids <run>-e0 .. <run>-e<n-1>, spec min_pitch, collect oak_log x1
#   scripts/rl/envs.sh stop  <run>
# Arenas are 128 blocks apart on x (view distance 4 = 64 blocks), bots are RLBot<i>. Each needs the policy side
# (scripts/botsystem_ppo.py in DPOD) polling exchange/<run>-e<i>/.
set -euo pipefail
cd "$(dirname "$0")/../../docker/rl-server"
GOAL='{"v":1,"type":"collect","item":"oak_log","count":1,"max_steps":150}'
case "${1:-}" in
  start)
    run=$2; n=$3; seed=$4; episodes=$5
    for i in $(seq 0 $((n-1))); do
      docker compose --profile env run -d --rm --name "rl-env-$run-$i" -e RL_BOT_NAME="RLBot$i" -e RL_ORIGIN_X="$((i*128)).5" \
        rl-env --run-id "$run-e$i" --spec min_pitch --ticks 4 --episodes "$episodes" --goal "$GOAL" --seed "$((seed+i))" --act-timeout 900 >/dev/null
    done ;;
  stop) docker rm -f $(docker ps -aq --filter "name=rl-env-$2-") 2>/dev/null || true ;;
  *) echo "usage: $0 start <run> <n> <seed> <episodes> | stop <run>" >&2; exit 2 ;;
esac
