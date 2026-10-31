#!/usr/bin/env bash
# Give a player operator rights in the build world (commands such as /fill, /tp, /gamemode). Run from `ssh vps`.
source "$(dirname "$0")/lib.sh"
name=${1:?usage: op.sh <minecraft name>}
[[ $name =~ ^[A-Za-z0-9_]{3,16}$ ]] || { echo "not a Minecraft name: $name" >&2; exit 2; }
rcon "op $name"
