# The Python base of the moe tools: python:3.12-slim plus OpenMP (xgboost, lightgbm). The packages themselves live in the moe-venv volume.
FROM python:3.12-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
