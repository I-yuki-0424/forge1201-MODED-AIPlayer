#!/usr/bin/env bash
# Unit tests of the moe package (no simulator): docker, moe-venv, no network.
source "$(dirname "$0")/lib.sh"
docker run --rm --network none --read-only --tmpfs /tmp --cap-drop ALL --cpus 2 --memory 3g -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONPATH=/w -e JAX_PLATFORMS=cpu \
  -v moe-venv:/venv:ro -v "$REPO":/w:ro -w /w moe-py:1 /venv/bin/python -m unittest discover -s moe/tests -t . "$@"
