# Shared prelude of scripts/train/*.sh (sourced): the world helpers plus the training containers.
source "$(dirname "${BASH_SOURCE[0]}")/../world/lib.sh"
TRAIN=forgeaip-train
TRAIN_STATE=$REPO/exchange/.train-state     # what up.sh stopped, so down.sh can bring it back
mkdir -p "$REPO/exchange"
trcon() { RCON_CONTAINER=$TRAIN rcon "$@"; }
