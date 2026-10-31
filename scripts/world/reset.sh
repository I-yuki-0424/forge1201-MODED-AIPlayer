#!/usr/bin/env bash
# Replace the build world with a newly generated one. The current world is snapshotted first (label auto-before-reset),
# so restore.sh can bring it back. The LLM bot, if it was running, is started again in the new world.
#   scripts/world/reset.sh                       random seed, natural terrain
#   scripts/world/reset.sh --seed 42 --type flat
source "$(dirname "$0")/lib.sh"
seed=$(od -An -N6 -tu8 /dev/urandom | tr -d ' '); type=normal
while [ $# -gt 0 ]; do
  case $1 in
    --seed) seed=${2:?}; shift 2 ;;
    --type) type=${2:?}; shift 2 ;;
    *) echo "usage: reset.sh [--seed N] [--type normal|flat|large_biomes|amplified]" >&2; exit 2 ;;
  esac
done
[[ $seed =~ ^-?[0-9]{1,19}$ ]] || { echo "seed: an integer" >&2; exit 2; }
[[ $type =~ ^(normal|flat|large_biomes|amplified)$ ]] || { echo "type: normal, flat, large_biomes or amplified" >&2; exit 2; }
bot=false; running forgeaip-llm-bot && bot=true
if running "$WORLD"; then "$(dirname "$0")/snapshot.sh" auto-before-reset; fi
compose --profile bot stop llm-bot >/dev/null 2>&1 || true
compose stop world
# Seed and type only take effect when a world is generated; keep them in .env so the next start describes this world.
env=$COMPOSE_DIR/.env
sed -i '/^WORLD_SEED=/d; /^WORLD_LEVEL_TYPE=/d' "$env"
printf 'WORLD_SEED=%s\nWORLD_LEVEL_TYPE=%s\n' "$seed" "$type" >> "$env"
image=$(docker inspect -f '{{.Config.Image}}' "$WORLD")
docker run --rm --entrypoint /bin/sh -v forgeaip-world_data:/data "$image" -c 'rm -rf /data/world'
rm -f "$REPO"/exchange/pregen-*.json          # the LV2 benchmark's pre-generated region belonged to the old world
compose up -d --force-recreate world >/dev/null     # recreated: the container's environment carries the new seed
"$(dirname "$0")/up.sh"
echo "new world: seed $seed, type $type"
if $bot; then "$(dirname "$0")/bot-up.sh"; fi
