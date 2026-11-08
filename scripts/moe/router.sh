#!/usr/bin/env bash
# Train and evaluate the XGBoost and LightGBM routers on states sampled from the catalogue: $MOE_ROOT/runs/router/{router.xgb,router.lgb,router.json}
source "$(dirname "$0")/lib.sh"
py 1 3g router --out /m/runs/router "$@"
