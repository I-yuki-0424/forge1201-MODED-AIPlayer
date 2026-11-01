#!/usr/bin/env bash
# Index the training executions in exchange/ into DPOD's local MLflow store (experiment side-botsystem; DPOD
# scripts/mlflow_ingest_botsystem.py), then, with --ui, serve the MLflow UI on 127.0.0.1:5005 ONLY.
#   scripts/train/mlflow.sh [--ui | --ui-stop]
# The UI has no authentication and MLflow's tracking server has a long advisory history, so it is never published beyond
# loopback (not even the tailnet). From the PC: ssh -L 5005:127.0.0.1:5005 <vps>, then http://127.0.0.1:5005.
# mlflow 3.17.2 (0 OSV advisories on 2026-11-01) lives in the docker volume dpod-mlflow; JAX comes from rl-jaxvenv.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
DPOD=${DPOD_DIR:-$REPO/../Decision-Process-order-driven}
IMG=python:3.12-slim
run() { docker run --rm -v dpod-mlflow:/venv:ro -v rl-jaxvenv:/jax:ro -v "$DPOD":/dpod -v "$REPO/exchange":/x:ro -w /dpod \
  -e PYTHONPATH=/jax/lib/python3.12/site-packages "$@"; }
case "${1:-}" in
  --ui-stop) docker rm -f forgeaip-mlflow-ui >/dev/null 2>&1 || true; echo "mlflow ui stopped"; exit 0;;
esac
run "$IMG" /venv/bin/python scripts/mlflow_ingest_botsystem.py /x --store mlflow_local
if [ "${1:-}" = --ui ]; then
  docker rm -f forgeaip-mlflow-ui >/dev/null 2>&1 || true
  docker run -d --name forgeaip-mlflow-ui --restart no --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
    --memory 1g --cpus 0.5 -p 127.0.0.1:5005:5005 -v dpod-mlflow:/venv:ro -v "$DPOD/mlflow_local":/store "$IMG" \
    /venv/bin/mlflow ui --backend-store-uri sqlite:////store/mlflow.db --host 0.0.0.0 --port 5005 --workers 1 >/dev/null
  echo "mlflow ui on http://127.0.0.1:5005 (loopback only; ssh -L 5005:127.0.0.1:5005 from the PC)"
fi
