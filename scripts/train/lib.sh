# Shared prelude of scripts/train/*.sh (sourced): the world helpers plus the training containers.
source "$(dirname "${BASH_SOURCE[0]}")/../world/lib.sh"
TRAIN=forgeaip-train
TRAIN_STATE=$REPO/exchange/.train-state     # what up.sh stopped, so down.sh can bring it back
TRAIN_ENV=$REPO/exchange/.train-env         # the running training's settings (written by up.sh, read by restart.sh)
mkdir -p "$REPO/exchange"
trcon() { RCON_CONTAINER=$TRAIN rcon "$@"; }
