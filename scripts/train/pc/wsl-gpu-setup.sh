#!/usr/bin/env bash
# Run INSIDE the WSL2 distro (Ubuntu 22.04) by `scripts/train/pc.sh gpu-setup`: a Python 3.12 venv with CUDA jax for the learner.
# jax has no native-Windows CUDA wheels; WSL2 + the Windows NVIDIA driver is its supported GPU route. UNTESTED when written
# (the PC had no WSL on 2026-11-02): it stops at the first failure and prints why. Versions = the VPS learner's venv (rl-jaxvenv).
set -euo pipefail
JAX=0.12.0.1
command -v nvidia-smi >/dev/null || { echo "nvidia-smi missing in WSL: install the Windows NVIDIA driver (WSL CUDA support) and restart WSL" >&2; exit 3; }
nvidia-smi -L
if ! command -v uv >/dev/null && [ ! -x "$HOME/.local/bin/uv" ]; then
  curl -LsSf https://astral.sh/uv/0.9.0/install.sh | sh        # standalone installer, version pinned in the URL
fi
export PATH="$HOME/.local/bin:$PATH"
uv venv --python 3.12 "$HOME/gpuvenv"
uv pip install --python "$HOME/gpuvenv/bin/python" "jax[cuda12]==$JAX" optax==0.2.8 numpy==2.5.4 ml_dtypes==0.6.0
"$HOME/gpuvenv/bin/python" - <<'PY'
import jax
d = jax.devices()
print("devices:", d)
assert any(x.platform in ("gpu", "cuda") for x in d), "jax sees no GPU"
PY
echo "PYTHON=$HOME/gpuvenv/bin/python"
