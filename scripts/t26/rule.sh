#!/usr/bin/env bash
# scripts/t26/rule.sh N rule value   set a game rule on test world N in the spelling the server knows: rules are snake_case on 26.x (keep_inventory) and camelCase up to 1.21.x
# (keepInventory); either spelling may be given. Prints the server's answer; exit 1 when neither spelling is accepted.
set -euo pipefail
N=${1:?world}; RULE=${2:?rule}; VAL=${3:?value}
[[ $RULE =~ ^[A-Za-z_]{1,48}$ ]] || { echo "bad rule name" >&2; exit 2; }
if [[ $RULE == *_* ]]; then OTHER=$(sed -E 's/_([a-z])/\U\1/g' <<< "$RULE"); else OTHER=$(sed -E 's/([A-Z])/_\L\1/g' <<< "$RULE"); fi
for r in "$RULE" "$OTHER"; do
  out=$("$(dirname "${BASH_SOURCE[0]}")/rcon.sh" "$N" gamerule "$r" "$VAL")
  if ! grep -qiE "^(Unknown|Incorrect|Expected)|<--\[HERE\]" <<< "$out"; then echo "$out"; exit 0; fi
done
echo "neither $RULE nor $OTHER is a game rule here: $out" >&2; exit 1
