#!/usr/bin/env bash
# Run python for rl3 on the VPS (CPU, no network): the moe-py image with the moe-venv volume (jax, optax, numpy). Usage: scripts/rl3-py.sh -m rl3.cli ...
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
mkdir -p "${RL3_OUT:-/mnt/data/forgeaip/rl3}"
exec docker run --rm --network none --read-only --tmpfs /tmp --cap-drop ALL --cpus "${RL3_CPUS:-4}" --memory "${RL3_MEM:-6g}" -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONPATH=/w -e JAX_PLATFORMS=cpu \
  -v moe-venv:/venv:ro -v "$REPO":/w:ro -v "${RL3_OUT:-/mnt/data/forgeaip/rl3}":/out -w /w moe-py:1 /venv/bin/python "$@"
