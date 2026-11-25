#!/usr/bin/env bash
# scripts/t26/rcon.sh N command...   one server command on test world N of the current profile (colour codes stripped)
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/profile.sh"
tw_names "${1:?number}"; shift
docker exec "$TW_SERVER" rcon-cli -- "$@" | sed 's/\x1b\[[0-9;]*m//g'
