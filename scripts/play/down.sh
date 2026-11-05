#!/usr/bin/env bash
# Stop the play world (the world data stays in the volume forgeaip-play_data; --purge deletes it too).
source "$(dirname "$0")/lib.sh"
if [ "${1:-}" = --purge ]; then compose down -v; else compose down; fi
