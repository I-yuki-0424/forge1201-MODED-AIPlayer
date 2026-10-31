#!/usr/bin/env bash
# Remove the disposable test copy (its world was tmpfs; nothing to keep).
source "$(dirname "$0")/lib.sh"
compose --profile test rm -sf world-test
