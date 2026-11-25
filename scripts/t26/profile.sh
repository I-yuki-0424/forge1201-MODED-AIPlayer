# scripts/t26/profile.sh   sourced by every test-world script: the ONE place that decides the game version (TASK-20261125-074, owner: "the system must not depend on one version").
# The profile is docker/tw/<name>.json (Minecraft version, loader, the bots' protocol version, server image, name tag, port base, the server mods pinned by sha512);
# docker/tw/PROFILE names the current one, TW_PROFILE=<name> picks another for one command (TW_PROFILE=fabric-26.1.2 scripts/t26/up.sh N starts a frozen 26.x world again).
# Nothing else in the scripts or the code names a version. Exports:
#   TW_PROFILE TW_MC TW_BOT TW_IMAGE TW_TAG TW_PORT_BASE TW_LOCK TW_MODS   and   tw_names N  (sets TW_SERVER TW_DEV TW_NET TW_VOL TW_PORT TW_PROJECT for world N)
TW_REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TW_HOME=/mnt/data/forgeaip-play/t26                       # the RCON secret (.env, mode 600) and the results (out/) of every profile
TW_PROFILE=${TW_PROFILE:-$(tr -d ' \n' < "$TW_REPO/docker/tw/PROFILE")}
[[ $TW_PROFILE =~ ^[a-z0-9.-]+$ ]] && [ -f "$TW_REPO/docker/tw/$TW_PROFILE.json" ] || { echo "no test-world profile docker/tw/$TW_PROFILE.json" >&2; exit 2; }
TW_LOCK=$TW_REPO/docker/tw/$TW_PROFILE.json
eval "$(python3 -I - "$TW_LOCK" <<'PY'
import json, re, shlex, sys
p = json.load(open(sys.argv[1]))
v = {"TW_MC": p["minecraft"], "TW_BOT": p["bot"], "TW_IMAGE": p["image"], "TW_TAG": p["tag"], "TW_PORT_BASE": str(int(p["portBase"]))}
assert re.fullmatch(r"[a-z0-9]{1,8}", v["TW_TAG"]) and re.fullmatch(r"[0-9a-z.\-]{1,16}", v["TW_BOT"]) and re.fullmatch(r"itzg/minecraft-server@sha256:[0-9a-f]{64}", v["TW_IMAGE"])
print("\n".join(f"{k}={shlex.quote(x)}" for k, x in v.items()))
PY
)" || { echo "bad profile $TW_LOCK" >&2; exit 2; }
TW_MODS=/mnt/data/forgeaip-play/tw/$TW_TAG/mods
NODE_IMG=node@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
export TW_REPO TW_HOME TW_PROFILE TW_LOCK TW_MC TW_BOT TW_IMAGE TW_TAG TW_PORT_BASE TW_MODS NODE_IMG
export XDG_RUNTIME_DIR=/run/user/1000 DOCKER_HOST=${DOCKER_HOST:-unix:///run/user/1000/docker.sock}

# the names of world N under this profile (fabric-26.1.2 gives the old T26 names: forgeaip-t26-N, volume forgeaip-t26-N_data, port 25590+N)
tw_names() {
  [[ $1 =~ ^[1-9]$ ]] || { echo "world number 1..9, not $1" >&2; exit 2; }
  TW_N=$1; TW_PROJECT=forgeaip-$TW_TAG-$1; TW_SERVER=$TW_PROJECT; TW_DEV=forgeaip-$TW_TAG-dev-$1; TW_NET=${TW_PROJECT}_net; TW_VOL=${TW_PROJECT}_data; TW_PORT=$((TW_PORT_BASE + $1))
  export TW_N TW_PROJECT TW_SERVER TW_DEV TW_NET TW_VOL TW_PORT
}

# environment of every harness container (run.sh, dev.sh): the bots speak the profile's protocol; TEMP_BLOCK=pumpkin: on the test worlds every temporary block is a pumpkin (owner Small 4)
tw_bot_env() { TW_ENV=(-e MC_HOST=mc -e RCON_HOST=mc -e "RCON_PASSWORD=$RCON_PASSWORD" -e MC_PLATFORM=fabric -e "MC_VERSION=$TW_BOT" -e BOT_REGISTRY=vanilla -e "T26_WORLD=$TW_N" -e "TW_PROFILE=$TW_PROFILE" -e "TEMP_BLOCK=${TEMP_BLOCK:-pumpkin}"); }
