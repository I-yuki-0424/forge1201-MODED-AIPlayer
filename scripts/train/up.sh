#!/usr/bin/env bash
# Start RL training (docs/proposed/RL-TRAINING-v2.md, env v3.0): the training worlds replace the build world (memory; shard 0 takes
# its port 127.0.0.1:25567, so the owner's tailnet route 100.115.238.9:25565 shows it), then one environment per world and the
# policy/learner (DPOD scripts/botsystem_goal_ppo.py).
#   scripts/train/up.sh [--shards S] [--bots N] [--days D] [--speed K] [--learn 0|1] [--base NAME] [--owner MCNAME] [--fresh-world]
#                       [--pc G]
#   --shards S (1..5, default 5): groups on this VPS, each its own server/world (same seed), clock and environment process.
#   --bots N (default 2): bots per group; a group is a pair (owner 2026-11-02: 5 groups of 2 on the VPS, each its own world).
#   --days D (default 3): in-game days per episode (episode = days, not one life; reward v5).
#   --speed K (default 2): the whole game clock K times faster (tools/tickrate on the servers, GAME_SPEED for the bots); a server
#     reaches it only while its tick work fits in 50/K ms (scripts/train/status.sh shows the measured rate).
#   --learn 0 = the policy acts but never updates (smoke run); 1 = training.
#   --fresh-world: new worlds from the same seed (old shard-0 world archived to $SNAPS) and the used-site records cleared.
#   --pc G: also start G groups on the owner's PC (scripts/train/pc.sh up; bots from 11 on) and run the learner there (8 cores,
#     48 GB: 'train with abundant resources'); scripts/train/relay.py mirrors what each side reads.
# Start sites: every episode, every bot at a new candidate of exchange/sites-<seed>.json (tools/site-finder, generated here once).
# Restart-safe: every container has restart: unless-stopped, the learner resumes from exchange/<base>/train/checkpoint.pkl, and
# while it runs forgeaip-train-hold.timer renews a maint-hold lease so rootwatch does not reboot the VPS.
source "$(dirname "$0")/lib.sh"
shards=5 bots=2 days=3 speed=2 learn=1 base=train owner=Seia_Y fresh=0 pc=0
while [ $# -gt 0 ]; do case $1 in
  --shards) shards=$2; shift 2;; --bots) bots=$2; shift 2;; --days) days=$2; shift 2;; --speed) speed=$2; shift 2;;
  --learn) learn=$2; shift 2;; --base) base=$2; shift 2;; --owner) owner=$2; shift 2;; --fresh-world) fresh=1; shift;;
  --pc) pc=$2; shift 2;;
  *) echo "unknown option $1" >&2; exit 2;; esac; done
[[ $shards =~ ^[1-5]$ ]] || { echo "--shards 1..5" >&2; exit 2; }
[[ $bots =~ ^[0-9]+$ && $bots -ge 1 && $bots -le 16 ]] || { echo "--bots 1..16" >&2; exit 2; }
[[ $days =~ ^[1-9][0-9]?$ ]] || { echo "--days 1..99" >&2; exit 2; }
[[ $learn =~ ^[01]$ ]] || { echo "--learn 0|1" >&2; exit 2; }
[[ $base =~ ^[a-z0-9_-]{1,40}$ ]] || { echo "--base: [a-z0-9_-]" >&2; exit 2; }
[[ $owner =~ ^[A-Za-z0-9_]{3,16}$ ]] || { echo "--owner: a Minecraft name" >&2; exit 2; }
[[ $speed =~ ^([1-9]|10)(\.[0-9]{1,2})?$ ]] && python3 -c "import sys; sys.exit(not 1 <= float('$speed') <= 10)" || { echo "--speed 1..10" >&2; exit 2; }
[[ $pc =~ ^[0-9]$ ]] || { echo "--pc 0..9" >&2; exit 2; }
"$REPO/tools/tickrate/build.sh" >/dev/null
[ -f "$COMPOSE_DIR/.env" ] || { umask 077; echo "RCON_PASSWORD=$(openssl rand -hex 16)" > "$COMPOSE_DIR/.env"; }
python3 -I "$REPO/modpack/pack.py" server "$MODS"
seed=$(TRAIN_SEED=${TRAIN_SEED:-20261101} compose config --format json 2>/dev/null | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["services"]["train"]["environment"]["SEED"])' 2>/dev/null || echo "${TRAIN_SEED:-20261101}")
cands=sites-$seed.json
"$REPO/scripts/train/candidates.sh" "$seed" >/dev/null

# The build world and its LLM bot step aside (snapshot first); down.sh restores exactly what was running. The state file is
# kept across repeated up.sh runs; down.sh removes it.
touch "$TRAIN_STATE"
if running "$WORLD"; then "$REPO/scripts/world/snapshot.sh" before-train; grep -qx world "$TRAIN_STATE" || echo world >> "$TRAIN_STATE"; fi
running forgeaip-llm-bot && { grep -qx llm-bot "$TRAIN_STATE" || echo llm-bot >> "$TRAIN_STATE"; }
compose --profile bot stop llm-bot >/dev/null 2>&1 || true
compose stop world >/dev/null 2>&1 || true

# Heap per server: one alone gets 3G; five on this box (11 GB, shared with the learner and other services) get 1G each (1.25G
# drove the box into a global OOM that killed the learner, run train7 2026-11-02; two players at view distance 6 need little).
case $shards in 1) mem=3G lim=4g;; 2) mem=2G lim=2800m;; *) mem=1G lim=1600m;; esac
export TRAIN_BASE=$base TRAIN_BOTS=$bots TRAIN_LEARN=$learn TRAIN_SPEED=$speed TRAIN_DAYS=$days TRAIN_CANDIDATES=$cands \
  TRAIN_MEMORY=$mem TRAIN_MEM_LIMIT=$lim TRAIN_POLICY=botsystem_goal_ppo.py TRAIN_POLICY_INIT= TRAIN_POPULATION=1
# The settings of this run, for scripts/train/restart.sh (a bare `compose up` would recreate a container with the defaults).
env | grep -E '^TRAIN_(BASE|BOTS|LEARN|SPEED|DAYS|CANDIDATES|POLICY|POLICY_INIT|POPULATION|MEMORY|MEM_LIMIT)=' > "$TRAIN_ENV"
echo "TRAIN_SHARDS=$shards" >> "$TRAIN_ENV"
profiles=(--profile train); servers=(train); envs=(train-env)
for i in $(seq 1 $((shards - 1))); do profiles+=(--profile "shard$i"); servers+=("train-s$i"); envs+=("train-env-s$i"); done
all=(--profile train --profile shard1 --profile shard2 --profile shard3 --profile shard4)
# Operator by the offline-mode UUID the owner logs in with (`op <name>` would store the Mojang UUID; online-mode=false).
uuid=$(python3 -I -c 'import hashlib,sys,uuid; print(uuid.UUID(bytes=hashlib.md5(b"OfflinePlayer:"+sys.argv[1].encode()).digest(), version=3))' "$owner")
printf '[{"uuid":"%s","name":"%s","level":4,"bypassesPlayerLimit":false}]\n' "$uuid" "$owner" |
  compose --profile train run --rm --no-deps -T -u 1000:1000 --entrypoint sh train -c 'cat > /data/ops.json'
if [ "$fresh" = 1 ]; then
  # Nothing may hold the worlds while they are replaced; the archive keeps the old shard-0 world restorable by hand.
  compose "${all[@]}" stop -t 60 >/dev/null 2>&1 || true
  arch=train-world-$(date +%Y%m%d-%H%M%S).tar.gz
  docker run --rm -v forgeaip-world_train-data:/s:ro -v "$SNAPS":/o alpine:3.20 sh -c "[ ! -d /s/world ] || tar -czf /o/$arch -C /s world"
  for v in train-data train-data-s1 train-data-s2 train-data-s3 train-data-s4; do
    docker run --rm -v "forgeaip-world_$v":/d alpine:3.20 sh -c 'rm -rf /d/world' 2>/dev/null || true
  done
  rm -f "$REPO"/exchange/sites/vps-s*.json
  echo "training worlds removed (old shard-0 world in $SNAPS/$arch), used sites cleared; seed $seed is generated anew"
fi
compose "${profiles[@]}" up -d "${servers[@]}"
for s in "${servers[@]}"; do wait_healthy "forgeaip-$s"; done
# The learner: on this VPS (container train-policy), or with --pc on the owner's PC (scripts/train/pc.sh), serving every group.
learner=(train-policy); [ "$pc" -gt 0 ] && learner=()
compose "${profiles[@]}" up -d "${envs[@]}" "${learner[@]}"
# The watcher's page (tools/train-dash): build when missing or older than its sources, serve on loopback, route the tailnet to
# it the way the game is routed (tailscale serve, tailnet only; nothing listens on the public address).
dash=$REPO/tools/train-dash
if [ ! -x "$dash/target/bookworm/release/train-dash" ] || [ -n "$(find "$dash/src" "$dash/web" "$dash/Cargo.toml" -newer "$dash/target/bookworm/release/train-dash" 2>/dev/null)" ]; then
  docker run --rm --network none -e CARGO_TARGET_DIR=/w/target/bookworm -v "$dash":/w -w /w rust:1-bookworm cargo build --release --offline --quiet
fi
compose --profile train up -d train-dash
tailscale serve status 2>/dev/null | grep -q "localhost:3021" || tailscale serve --bg --tcp 3021 tcp://localhost:3021 >/dev/null 2>&1 || echo "tailscale serve failed: the page is on 127.0.0.1:3021 only" >&2
if [ "$learn" = 1 ]; then
  for u in service timer; do systemctl --user link "$REPO/scripts/train/systemd/forgeaip-train-hold.$u" >/dev/null 2>&1 || true; done
  systemctl --user enable --now forgeaip-train-hold.timer
fi
if [ "$pc" -gt 0 ]; then pcargs=(up --groups "$pc"); [ "$fresh" = 1 ] && pcargs+=(--fresh-world); "$REPO/scripts/train/pc.sh" "${pcargs[@]}"; fi
echo "training up: base=$base groups=$shards x $bots bots (+ $pc on the PC) days=$days speed=$speed learn=$learn seed=$seed"
echo "watch: join 100.115.238.9:25565 (op: /gamemode spectator, /spectate Train0); page: http://100.115.238.9:3021/; logs: scripts/train/status.sh $base"
