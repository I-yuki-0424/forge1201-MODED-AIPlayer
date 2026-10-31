#!/usr/bin/env bash
# Stop the build world (the world is kept: it lives in the volume). Takes an automatic snapshot first.
source "$(dirname "$0")/lib.sh"
if running "$WORLD"; then "$(dirname "$0")/snapshot.sh" auto-stop; fi
compose stop world
