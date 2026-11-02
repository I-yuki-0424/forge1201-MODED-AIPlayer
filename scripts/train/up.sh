#!/usr/bin/env bash
# Start RL training (docs/proposed/RL-TRAINING-v2.md): the training world replaces the build world on 127.0.0.1:25567
# (the owner's tailnet route 100.115.238.9:25565 then shows it), then the environment (N bots) and the policy/learner.
#   scripts/train/up.sh [--bots N] [--learn 0|1] [--base NAME] [--owner MCNAME] [--speed K] [--population M] [--shards S]
#   --learn 0 = the policy acts but never updates (smoke/test run); 1 = training. Defaults: 8 bots, learn 1, base "train",
#   speed 1. --speed K runs the whole game clock K times faster (tools/tickrate on the server, GAME_SPEED for the bots); the
#   server reaches it only while its tick work fits in 50/K ms (scripts/train/status.sh shows the measured rate).
#   --shards S (1..4): S servers, each with its own environment process and --bots bots (bots x speed per server is bounded by
#   its one tick thread; more servers is how the bot count grows). Shards 1+ get a copy of shard 0's world and no host port.
#   --population M: M learners in population-based training (DPOD botsystem_skill_ppo.py; bot i acts for member i % M).
#   --policy skill|goal: the DPOD learner. skill = SkillTruck (botsystem_skill_ppo.py, env v1.x observations are a subset of
#   v2.0); goal (default) = GoalWM (botsystem_goal_ppo.py: goal-conditioned, world model, hindsight reach; DPOD TASK-20261101-031).
#   --init FILE: goal only, offline-pretrained parameters under exchange/ (e.g. pretrain/goalwm_pretrain.pkl), used when the
#   base has no checkpoint yet.
#   --sites FILE: fixed start sites (repo-relative JSON, e.g. config/train-sites.json): bot k of every shard starts every episode
#   at sites[k], so bot k of shard 0 and of shard 1 are a pair (same seed, same start, different worlds). Pre-generates the
#   sites instead of the region around spawn.
#   --fresh-world: a new training world from the same seed in every shard (the old shard-0 world is archived to $SNAPS
#   first). Shards 1+ are copied from shard 0 before any bot joins, so all shards start identical.
# Restart-safe: every container has restart: unless-stopped, the learner resumes from exchange/<base>/train/checkpoint.pkl,
# and while the learner runs, forgeaip-train-hold.timer renews a maint-hold lease so rootwatch does not reboot the VPS.
source "$(dirname "$0")/lib.sh"
bots=8 learn=1 base=train owner=Seia_Y speed=1 population=1 shards=1 policy=goal init= sites= fresh=0
while [ $# -gt 0 ]; do case $1 in
  --bots) bots=$2; shift 2;; --learn) learn=$2; shift 2;; --base) base=$2; shift 2;; --owner) owner=$2; shift 2;;
  --speed) speed=$2; shift 2;; --population) population=$2; shift 2;; --shards) shards=$2; shift 2;;
  --policy) policy=$2; shift 2;; --init) init=$2; shift 2;; --sites) sites=$2; shift 2;; --fresh-world) fresh=1; shift;;
  *) echo "unknown option $1" >&2; exit 2;; esac; done
[[ $bots =~ ^[0-9]+$ && $bots -ge 1 && $bots -le 16 ]] || { echo "--bots 1..16" >&2; exit 2; }
[[ $learn =~ ^[01]$ ]] || { echo "--learn 0|1" >&2; exit 2; }
[[ $base =~ ^[a-z0-9_-]{1,40}$ ]] || { echo "--base: [a-z0-9_-]" >&2; exit 2; }
[[ $owner =~ ^[A-Za-z0-9_]{3,16}$ ]] || { echo "--owner: a Minecraft name" >&2; exit 2; }
[[ $speed =~ ^([1-9]|10)(\.[0-9]{1,2})?$ ]] && python3 -c "import sys; sys.exit(not 1 <= float('$speed') <= 10)" || { echo "--speed 1..10" >&2; exit 2; }
[[ $population =~ ^[1-8]$ && $population -le $bots ]] || { echo "--population 1..8, at most --bots" >&2; exit 2; }
[[ $shards =~ ^[1-4]$ ]] || { echo "--shards 1..4" >&2; exit 2; }
case $policy in skill) TRAIN_POLICY=botsystem_skill_ppo.py;; goal) TRAIN_POLICY=botsystem_goal_ppo.py;; *) echo "--policy skill|goal" >&2; exit 2;; esac
[ "$policy" = goal ] && [ "$population" != 1 ] && { echo "--policy goal: --population 1 only" >&2; exit 2; }
if [ -n "$init" ]; then
  [ "$policy" = goal ] || { echo "--init: --policy goal only" >&2; exit 2; }
  [[ $init =~ ^[A-Za-z0-9_./-]{1,120}$ && $init != *..* ]] && [ -f "$REPO/exchange/$init" ] || { echo "--init: a file under exchange/" >&2; exit 2; }
fi
TRAIN_POLICY_INIT=${init:+/x/$init}
if [ -n "$sites" ]; then
  [[ $sites =~ ^[A-Za-z0-9_./-]{1,120}$ && $sites != *..* && $sites != /* ]] && [ -f "$REPO/$sites" ] || { echo "--sites: a repo-relative file" >&2; exit 2; }
  n=$(python3 -I -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["sites"]))' "$REPO/$sites")
  [ "$n" -ge "$bots" ] || { echo "--sites: $n sites for $bots bots" >&2; exit 2; }
fi
export TRAIN_SITES=$sites
"$REPO/tools/tickrate/build.sh" >/dev/null
[ -f "$COMPOSE_DIR/.env" ] || { umask 077; echo "RCON_PASSWORD=$(openssl rand -hex 16)" > "$COMPOSE_DIR/.env"; }
python3 -I "$REPO/modpack/pack.py" server "$MODS"

# The build world and its LLM bot step aside (snapshot first); down.sh restores exactly what was running.
# The state file is kept across repeated up.sh runs (smoke run, then training): a second run finds the world already stopped
# and must not forget that the first one stopped it. down.sh removes the file.
touch "$TRAIN_STATE"
if running "$WORLD"; then scripts_world=$REPO/scripts/world; "$scripts_world/snapshot.sh" before-train; grep -qx world "$TRAIN_STATE" || echo world >> "$TRAIN_STATE"; fi
running forgeaip-llm-bot && { grep -qx llm-bot "$TRAIN_STATE" || echo llm-bot >> "$TRAIN_STATE"; }
compose --profile bot stop llm-bot >/dev/null 2>&1 || true
compose stop world >/dev/null 2>&1 || true

export TRAIN_BASE=$base TRAIN_BOTS=$bots TRAIN_LEARN=$learn TRAIN_SPEED=$speed TRAIN_POPULATION=$population TRAIN_POLICY TRAIN_POLICY_INIT
# Several servers on one box: 2G heap each (the JVM touches its whole heap at start, Aikar flags), else 3G.
if [ "$shards" -gt 1 ]; then export TRAIN_MEMORY=2G TRAIN_MEM_LIMIT=2800m; else export TRAIN_MEMORY=3G TRAIN_MEM_LIMIT=4g; fi
# The settings of this run, for scripts/train/restart.sh: a bare `compose up` would recreate a container with the defaults
# (base "train"; 2026-11-02 the learner followed run 1 that way).
env | grep -E '^TRAIN_(BASE|BOTS|LEARN|SPEED|POPULATION|POLICY|POLICY_INIT|SITES|MEMORY|MEM_LIMIT)=' > "$TRAIN_ENV"
# Operator by the offline-mode UUID the owner actually logs in with. `op <name>` on a server that has not seen the player
# resolves the name at Mojang and stores the online UUID, which never matches here (online-mode=false): no OP for the owner.
uuid=$(python3 -I -c 'import hashlib,sys,uuid; print(uuid.UUID(bytes=hashlib.md5(b"OfflinePlayer:"+sys.argv[1].encode()).digest(), version=3))' "$owner")
printf '[{"uuid":"%s","name":"%s","level":4,"bypassesPlayerLimit":false}]\n' "$uuid" "$owner" |
  compose --profile train run --rm --no-deps -T -u 1000:1000 --entrypoint sh train -c 'cat > /data/ops.json'
if [ "$fresh" = 1 ]; then
  # Nothing may hold the worlds while they are replaced; the archive keeps the old one restorable by hand.
  compose --profile train --profile shard1 --profile shard2 --profile shard3 stop -t 60 train-policy train-env train-env-s1 train-env-s2 train-env-s3 train train-s1 train-s2 train-s3 >/dev/null 2>&1 || true
  arch=train-world-$(date +%Y%m%d-%H%M%S).tar.gz
  docker run --rm -v forgeaip-world_train-data:/s:ro -v "$SNAPS":/o alpine:3.20 sh -c "[ ! -d /s/world ] || tar -czf /o/$arch -C /s world"
  for v in train-data train-data-s1 train-data-s2 train-data-s3; do
    docker run --rm -v "forgeaip-world_$v":/d alpine:3.20 sh -c 'rm -rf /d/world' 2>/dev/null || true
  done
  seed=$(compose config --format json 2>/dev/null | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["services"]["train"]["environment"]["SEED"])' 2>/dev/null || echo "${TRAIN_SEED:-20261101}")
  rm -f "$REPO/exchange/pregen-$seed.json" "$REPO/exchange/pregen-$seed"-sites*.json
  echo "training worlds removed (old shard-0 world in $SNAPS/$arch); seed $seed is generated anew"
fi
compose --profile train up -d train
wait_healthy "$TRAIN"
# Generate what the bots use once per world (docs/LESSONS.md L10): the start sites, or the region they are spread over.
compose --profile bench run --rm -T -e MC_HOST=train -e RCON_HOST=train --entrypoint node bench scripts/skills/bench_lv2.js --pregen 1 ${sites:+--sites "$sites"}
# Shards 1..S-1: a copy of shard 0's world (consistent: saving paused and flushed meanwhile), made before any bot joins, so a
# pair (bot k of every shard) starts in identical worlds; then each shard's server and environment.
for i in $(seq 1 $((shards - 1))); do
  vol=forgeaip-world_train-data-s$i
  if ! docker run --rm -v "$vol":/d alpine:3.20 test -f /d/world/level.dat 2>/dev/null; then
    trcon save-off >/dev/null; trcon "save-all flush" >/dev/null; sleep 3
    docker run --rm -v forgeaip-world_train-data:/s:ro -v "$vol":/d alpine:3.20 sh -c 'rm -rf /d/world && cp -a /s/world /d/world && chown -R 1000:1000 /d'
    trcon save-on >/dev/null
  fi
  compose --profile "shard$i" up -d "train-s$i"
done
compose --profile train up -d train-env train-policy
for i in $(seq 1 $((shards - 1))); do wait_healthy "forgeaip-train-s$i"; compose --profile "shard$i" up -d "train-env-s$i"; done
# The watcher's page (tools/train-dash): build when missing or older than its sources, serve on loopback, route the tailnet
# to it the way the game is routed (tailscale serve, tailnet only; nothing listens on the public address).
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
echo "training up: base=$base policy=$policy${init:+ init=$init}${sites:+ sites=$sites} shards=$shards bots=$bots per shard learn=$learn speed=$speed population=$population; world $(trcon list); $(trcon tickrate)"
echo "watch: join 100.115.238.9:25565 (op: /gamemode spectator, /spectate Train1); page: http://100.115.238.9:3021/; logs: scripts/train/status.sh"
