#!/usr/bin/env bash
# scripts/t26/rcon.sh N command...   one server command on T26 world N (colour codes stripped)
export XDG_RUNTIME_DIR=/run/user/1000 DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/1000/docker.sock}
N=${1:?number}; shift
docker exec forgeaip-t26-$N rcon-cli -- "$@" | sed 's/\x1b\[[0-9;]*m//g'
