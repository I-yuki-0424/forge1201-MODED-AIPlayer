#!/usr/bin/env bash
# Start (or update) the play world. Jars: /mnt/data/forgeaip-play/mods (server) and client-only/ (owner's PC). Not in this repo.
source "$(dirname "$0")/lib.sh"
mkdir -p "$PLAY/mods" "$PLAY/client-only" "$PLAY/snapshots"
[ -f "$COMPOSE_DIR/.env" ] || { umask 077; echo "RCON_PASSWORD=$(openssl rand -hex 16)" > "$COMPOSE_DIR/.env"; }
python3 -I "$REPO/scripts/play/check-mods.py" "$PLAY" || { echo "fix the PROBLEM lines above (or --force to start anyway)" >&2; [ "${1:-}" = --force ] || exit 1; }
compose up -d play
for _ in $(seq 1 180); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' forgeaip-play 2>/dev/null)" = healthy ] && break
  sleep 5
done
[ "$(docker inspect -f '{{.State.Health.Status}}' forgeaip-play)" = healthy ] || { docker logs --tail 60 forgeaip-play >&2; echo "play world not healthy (see the log above; a client-only jar in mods/ is the usual cause)" >&2; exit 1; }
echo "play world up on 127.0.0.1:25569 ($(rcon list))"
echo "owner, once, as root on the VPS (tailnet only, like the build world):"
echo "  /usr/bin/tailscale serve --bg --tcp 25566 tcp://localhost:25569    # then join 100.77.246.23:25566"
