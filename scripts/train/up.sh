#!/usr/bin/env bash
# Start RL training (docs/proposed/RL-TRAINING-v2.md): the training world replaces the build world on 127.0.0.1:25567
# (the owner's tailnet route 100.115.238.9:25565 then shows it), then the environment (N bots) and the policy/learner.
#   scripts/train/up.sh [--bots N] [--learn 0|1] [--base NAME] [--owner MCNAME]
#   --learn 0 = the policy acts but never updates (smoke/test run); 1 = training. Defaults: 4 bots, learn 1, base "train".
# Restart-safe: every container has restart: unless-stopped, the learner resumes from exchange/<base>/train/checkpoint.pkl,
# and while the learner runs, forgeaip-train-hold.timer renews a maint-hold lease so rootwatch does not reboot the VPS.
source "$(dirname "$0")/lib.sh"
bots=4 learn=1 base=train owner=Seia_Y
while [ $# -gt 0 ]; do case $1 in
  --bots) bots=$2; shift 2;; --learn) learn=$2; shift 2;; --base) base=$2; shift 2;; --owner) owner=$2; shift 2;;
  *) echo "unknown option $1" >&2; exit 2;; esac; done
[[ $bots =~ ^[0-9]+$ && $bots -ge 1 && $bots -le 16 ]] || { echo "--bots 1..16" >&2; exit 2; }
[[ $learn =~ ^[01]$ ]] || { echo "--learn 0|1" >&2; exit 2; }
[[ $base =~ ^[a-z0-9_-]{1,40}$ ]] || { echo "--base: [a-z0-9_-]" >&2; exit 2; }
[[ $owner =~ ^[A-Za-z0-9_]{3,16}$ ]] || { echo "--owner: a Minecraft name" >&2; exit 2; }
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

export TRAIN_BASE=$base TRAIN_BOTS=$bots TRAIN_LEARN=$learn
# Operator by the offline-mode UUID the owner actually logs in with. `op <name>` on a server that has not seen the player
# resolves the name at Mojang and stores the online UUID, which never matches here (online-mode=false): no OP for the owner.
uuid=$(python3 -I -c 'import hashlib,sys,uuid; print(uuid.UUID(bytes=hashlib.md5(b"OfflinePlayer:"+sys.argv[1].encode()).digest(), version=3))' "$owner")
printf '[{"uuid":"%s","name":"%s","level":4,"bypassesPlayerLimit":false}]\n' "$uuid" "$owner" |
  compose --profile train run --rm --no-deps -T -u 1000:1000 --entrypoint sh train -c 'cat > /data/ops.json'
compose --profile train up -d train
wait_healthy "$TRAIN"
# Generate the region the bots are spread over once per world (docs/LESSONS.md L10), then start bots and learner.
compose --profile bench run --rm -T -e MC_HOST=train -e RCON_HOST=train --entrypoint node bench scripts/skills/bench_lv2.js --pregen 1
compose --profile train up -d train-env train-policy
if [ "$learn" = 1 ]; then
  for u in service timer; do systemctl --user link "$REPO/scripts/train/systemd/forgeaip-train-hold.$u" >/dev/null 2>&1 || true; done
  systemctl --user enable --now forgeaip-train-hold.timer
fi
echo "training up: base=$base bots=$bots learn=$learn; world $(trcon list)"
echo "watch: join 100.115.238.9:25565 (op: /gamemode spectator, /tp $owner Train0); logs: scripts/train/status.sh"
