#!/usr/bin/env bash
# scripts/ci/regress.sh [REF=origin/main] [TESTS="move_a tags ..."] [LABEL=word] [RANDOM_TEST=name|none]   the live regression suite (TASK-20261125-080, docs/implemented/CI-v1.md).
# One run at a time (flock), on test world 9 ONLY, of a clean checkout of REF (its own clone, /mnt/data/forgeaip-play/ci/repo, never the main checkout): every test of
# scripts/ci/plan.txt on a NEW world of its fixed seed at the profile's speed for that test, then one of them again on a random seed; graded by the tests themselves (server-side),
# recorded by history.js (one JSON per run, history.jsonl, the change against the previous run of the same test and seed, both ways). Never in 03:00-06:00 JST: a test that cannot end
# before 03:00 is skipped and recorded as skipped. Results: /mnt/data/forgeaip-play/t26/out/ci/ (runs/<id>.json, history.jsonl, report-latest.txt; logs in out/ci-<id>/).
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CI_HOME=${CI_HOME:-/mnt/data/forgeaip-play/t26/out/ci}; SRC=${CI_SRC:-/mnt/data/forgeaip-play/ci/repo}; URL=https://github.com/I-yuki-0424/forge1201-MODED-AIPlayer.git
SLOT=9; REF=${REF:-origin/main}; LABEL=${LABEL:-}
mkdir -p "$CI_HOME/runs"
exec 9>"$CI_HOME/lock"; flock -n 9 || { echo "a CI run is already going" >&2; exit 75; }
hour() { TZ=Asia/Tokyo date +%H | sed 's/^0//'; }
mins_to_3() { local h m; h=$(TZ=Asia/Tokyo date +%-H); m=$(TZ=Asia/Tokyo date +%-M); local now=$((h * 60 + m)); echo $(( (180 - now + 1440) % 1440 )); }
h=$(hour); if [ "$h" -ge 3 ] && [ "$h" -lt 6 ]; then echo "03:00-06:00 JST: no CI run" >&2; exit 3; fi
[[ $REF =~ ^[A-Za-z0-9._/-]{1,80}$ ]] || { echo "bad REF" >&2; exit 2; }
[[ $LABEL =~ ^[a-z0-9-]{0,24}$ ]] || { echo "bad LABEL" >&2; exit 2; }

# the clone of the commit under test (GitHub, public: no credentials; LFS archives are not needed by any test)
export GIT_LFS_SKIP_SMUDGE=1
[ -d "$SRC/.git" ] || git clone -q --no-checkout "$URL" "$SRC" || exit 1
git -C "$SRC" fetch -q --prune origin '+refs/heads/*:refs/remotes/origin/*' || exit 1
git -C "$SRC" checkout -q --detach --force "$REF" && git -C "$SRC" clean -qfdx -e node_modules || exit 1
mkdir -p "$SRC/node_modules"                                                          # the mount point for the main checkout's modules (run.sh)
SHA=$(git -C "$SRC" rev-parse HEAD); SHORT=${SHA:0:8}
ID=$(TZ=Asia/Tokyo date +%m%d-%H%M)-$SHORT${LABEL:+-$LABEL}; OUT=/mnt/data/forgeaip-play/t26/out/ci-$ID; mkdir -p "$OUT"
. "$SRC/scripts/t26/profile.sh"
PLAN=$SRC/scripts/ci/plan.txt; [ -f "$PLAN" ] || PLAN=$HERE/scripts/ci/plan.txt              # an old commit without the plan is run with this one's
START=$(date +%s)
{ echo "id=$ID"; echo "sha=$SHA"; echo "ref=$REF"; echo "label=$LABEL"; echo "profile=$TW_PROFILE"; echo "started=$START"; git -C "$SRC" log -1 --format='subject=%s%ncommitted=%ct' HEAD; } > "$OUT/run.env"
echo "CI run $ID: $REF = $SHORT ($(git -C "$SRC" log -1 --format=%s HEAD | cut -c1-100))"

kill_runs() { for c in $(docker ps --format '{{.Names}}' | grep "^live-$TW_TAG-$SLOT-"); do docker kill "$c" >/dev/null 2>&1; done; }
one() {   # one <name> <script> <seed> <cap minutes> <kind> [args...]
  local name=$1 script=$2 seed=$3 cap=$4 kind=$5; shift 5
  local left; left=$(mins_to_3)
  if [ "$left" -lt $((cap + 4)) ]; then echo "$name $kind $seed skipped (would run into 03:00 JST)"; echo "skip $name $kind $seed reboot-window" >> "$OUT/tests.txt"; return; fi
  local sp; sp=$(tw_speed "$name"); local t0; t0=$(date +%s)
  if ! SPEED=$sp "$SRC/scripts/t26/up.sh" "$SLOT" --new $([ "$seed" = random ] || echo --seed "$seed") > "$OUT/up-$name-$kind.log" 2>&1; then
    echo "$name $kind: world did not come up"; echo "noworld $name $kind $seed $(( $(date +%s) - t0 ))" >> "$OUT/tests.txt"; return
  fi
  local s; s=$("$SRC/scripts/t26/rcon.sh" "$SLOT" seed | grep -o -- '-\?[0-9]\{4,\}' | head -1)
  timeout --kill-after=30 "$((cap * 60))" env REPO="$SRC" "$SRC/scripts/t26/run.sh" "$SLOT" "$script" RUN="ci-$ID-$kind" "$@" > "$OUT/$name-$kind.log" 2>&1; local rc=$?
  kill_runs
  echo "ran $name $kind ${s:-$seed} $(( $(date +%s) - t0 )) $rc $sp" >> "$OUT/tests.txt"
  echo "$name $kind seed ${s:-$seed} x$sp: exit $rc, $(( ($(date +%s) - t0) / 60 )) min: $(grep -h "trials passed" "$OUT/$name-$kind.log" | tail -1 | cut -c1-120)"
}
mapfile -t LINES < <(grep -v '^\s*#' "$PLAN" | grep -v '^\s*$')
NAMES=(); for l in "${LINES[@]}"; do read -r n _ <<< "$l"; NAMES+=("$n"); done
for l in "${LINES[@]}"; do
  read -r n sc seed cap args <<< "$l"
  [ -n "${TESTS:-}" ] && [[ " $TESTS " != *" $n "* ]] && continue
  # shellcheck disable=SC2086
  one "$n" "$sc" "$seed" "$cap" fixed $args
done
# the random-seed repeat: the test in turn (the number of recorded runs picks it), or RANDOM_TEST
R=${RANDOM_TEST:-}; if [ -z "$R" ]; then k=$(cat "$CI_HOME/history.jsonl" 2>/dev/null | wc -l); R=${NAMES[$((k % ${#NAMES[@]}))]}; fi
if [ "$R" != none ] && { [ -z "${TESTS:-}" ] || [[ " $TESTS " == *" $R "* ]]; }; then
  for l in "${LINES[@]}"; do read -r n sc seed cap args <<< "$l"; [ "$n" = "$R" ] || continue
    # shellcheck disable=SC2086
    one "$n" "$sc" random "$cap" random $args; done
fi
"$SRC/scripts/t26/down.sh" "$SLOT" --purge >/dev/null 2>&1                               # the world volume goes: the host is shared and its disk was 91 % full on 2026-11-27
echo "ended=$(date +%s)" >> "$OUT/run.env"
docker run --rm --network none -v "$HERE":/app:ro -v /mnt/data/forgeaip-play/t26/out:/out -w /app "$NODE_IMG" node scripts/ci/history.js "/out/ci-$ID" /out/ci | tee "$CI_HOME/report-latest.txt"
