#!/usr/bin/env bash
# Stop the RL server and remove its containers and volumes (the world is tmpfs; the Forge install cache goes too).
set -euo pipefail
cd "$(dirname "$0")/../../docker/rl-server"
docker compose --profile env down -v
