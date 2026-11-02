#!/usr/bin/env bash
# Training groups on the owner's PC (owner 2026-11-02: "from bot 11 on, use the PC"; SSH key ~/.ssh/id_ed25519_pc, the PC allows
# only the VPS's tailnet address). Each group: a Forge 1.20.1 server bound to 127.0.0.1 on the PC + one environment process, kept
# alive by scripts/train/pc/supervisor.js; the learner on the VPS reaches them through scripts/train/pc_relay.py (systemd user unit
# forgeaip-train-pc-relay), which mirrors their files into exchange/. Nothing on the PC listens beyond loopback.
#   scripts/train/pc.sh up --groups G [--fresh-world]     (base, bots, days, speed: exchange/.train-env from up.sh)
#   scripts/train/pc.sh down | status
# PC layout C:\forgeaip: node\ (portable Node 20, sha256-checked), forge-base\ (Forge installer output, sha1-checked), mods\,
# app\ (src + scripts/train/pc + production node_modules), servers\g<k>\ (one per group), exchange\, logs\, rcon.txt (random).
source "$(dirname "$0")/lib.sh"
HOST=${FORGEAIP_PC:-sigure@100.113.219.35}
KEY=${FORGEAIP_PC_KEY:-$HOME/.ssh/id_ed25519_pc}
SSH=(ssh -T -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 -i "$KEY" "$HOST")
SHARD0=5                       # VPS groups are shards 0..4 (bots 1-10); the PC's start at 5 (bot 11 on)
NODE_VER=v20.19.5 NODE_SHA=c48159529572a5a947eef2d55d6485dfdc4ce8e67216402e2f6de52ad5d95695
FORGE=1.20.1-47.4.10 FORGE_SHA1=66bfea9963bfa60d88bab6b2750e74a958392715
scp_to() { scp -q -o BatchMode=yes -o IdentitiesOnly=yes -i "$KEY" "$@"; }
# A PowerShell script from stdin, run as a file on the PC (PowerShell reading commands from stdin runs line by line and breaks
# multi-line blocks); its exit code is ours.
ps() {
  local f; f=$(mktemp --suffix=.ps1)
  { echo "\$ProgressPreference = 'SilentlyContinue'"; cat; } > "$f"
  "${SSH[@]}" 'if not exist C:\forgeaip\dl mkdir C:\forgeaip\dl' >/dev/null
  scp_to "$f" "$HOST:C:/forgeaip/dl/step.ps1"; rm -f "$f"
  "${SSH[@]}" 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\forgeaip\dl\step.ps1' | tr -d '\r'
  return "${PIPESTATUS[0]}"
}
cmd=${1:-status}; shift || true
groups=0 fresh=0
while [ $# -gt 0 ]; do case $1 in --groups) groups=$2; shift 2;; --fresh-world) fresh=1; shift;; *) echo "unknown option $1" >&2; exit 2;; esac; done

stop_pc() {
  ps <<'EOF'
$h = 'C:\forgeaip'
if (Test-Path "$h\supervisor.pid") {
  New-Item -ItemType File -Force "$h\STOP" | Out-Null
  for ($i = 0; $i -lt 180 -and (Test-Path "$h\supervisor.pid"); $i++) { Start-Sleep -Milliseconds 500 }
  if (Test-Path "$h\supervisor.pid") { taskkill /T /F /PID (Get-Content "$h\supervisor.pid") | Out-Null; Remove-Item -Force "$h\supervisor.pid" }
}
Remove-Item -Force -ErrorAction SilentlyContinue "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\forgeaip-train.vbs"
'pc: training stopped'
EOF
}

case $cmd in
down)
  systemctl --user disable --now forgeaip-train-pc-relay.service 2>/dev/null || true
  stop_pc
  exit 0;;
status)
  systemctl --user --no-pager status forgeaip-train-pc-relay.service 2>/dev/null | sed -n 1,5p || true
  ps <<'EOF'
$h = 'C:\forgeaip'
if (Test-Path "$h\status.json") { Get-Content "$h\status.json" } else { 'pc: no supervisor status' }
Get-Content -Tail 5 "$h\logs\supervisor.log" -ErrorAction SilentlyContinue
EOF
  exit 0;;
up) ;;
*) echo "usage: $0 up --groups G [--fresh-world] | down | status" >&2; exit 2;;
esac

[[ $groups =~ ^[1-9]$ ]] || { echo "--groups 1..9" >&2; exit 2; }
[ -s "$TRAIN_ENV" ] || { echo "no $TRAIN_ENV: start the VPS side with scripts/train/up.sh first" >&2; exit 1; }
set -a; source "$TRAIN_ENV"; set +a
seed=${TRAIN_SEED:-20261101}
cands=$("$REPO/scripts/train/candidates.sh" "$seed")
[[ $TRAIN_SPEED =~ ^[0-9.]+$ && $TRAIN_DAYS =~ ^[0-9]+$ && $TRAIN_BOTS =~ ^[0-9]+$ && $TRAIN_BASE =~ ^[a-z0-9_-]+$ ]] || { echo "bad $TRAIN_ENV" >&2; exit 1; }
owner_uuid=$(python3 -I -c 'import hashlib,uuid; print(uuid.UUID(bytes=hashlib.md5(b"OfflinePlayer:Seia_Y").digest(), version=3))')

# 1. Tools on the PC (once): portable Node 20, Forge server files; the RCON password is made there and never leaves it.
ps <<EOF
\$ErrorActionPreference = 'Stop'
\$h = 'C:\forgeaip'
foreach (\$d in 'app','exchange','servers','logs','dl','mods') { New-Item -ItemType Directory -Force "\$h\\\$d" | Out-Null }
if (-not (Test-Path "\$h\node\node.exe")) {
  Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-win-x64.zip" -OutFile "\$h\dl\node.zip"
  if ((Get-FileHash -Algorithm SHA256 "\$h\dl\node.zip").Hash -ne '$NODE_SHA') { throw 'node zip: sha256 mismatch' }
  Expand-Archive -Force "\$h\dl\node.zip" "\$h\dl\node"
  Move-Item "\$h\dl\node\node-$NODE_VER-win-x64" "\$h\node"
}
if (-not (Test-Path "\$h\forge-base\libraries\net\minecraftforge\forge\\$FORGE\win_args.txt")) {
  Invoke-WebRequest -UseBasicParsing "https://maven.minecraftforge.net/net/minecraftforge/forge/$FORGE/forge-$FORGE-installer.jar" -OutFile "\$h\dl\forge-installer.jar"
  if ((Get-FileHash -Algorithm SHA1 "\$h\dl\forge-installer.jar").Hash -ne '$FORGE_SHA1') { throw 'forge installer: sha1 mismatch' }
  New-Item -ItemType Directory -Force "\$h\forge-base" | Out-Null
  Push-Location "\$h\forge-base"; & java -jar "\$h\dl\forge-installer.jar" --installServer "\$h\forge-base" *> "\$h\logs\forge-install.log"; Pop-Location
  if (-not (Test-Path "\$h\forge-base\libraries\net\minecraftforge\forge\\$FORGE\win_args.txt")) { throw 'forge install failed: logs\forge-install.log' }
}
if (-not (Test-Path "\$h\rcon.txt")) { -join ((48..57) + (97..102) | Get-Random -Count 32 | % { [char]\$_ }) | Set-Content -NoNewline "\$h\rcon.txt" }
'pc: tools ready'
EOF

# 2. The application (environment code, the supervisor and relay) and its production dependencies; mods; site candidates.
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
tar -C "$REPO" -cf "$tmp/app.tar" package.json package-lock.json src modpack/forgeaip-create.registry.json modpack/forgeaip-create.advancements.json scripts/train/pc
scp_to "$tmp/app.tar" "$MODS"/*.jar "$REPO/tools/tickrate/build/libs/forgeaip-tickrate-1.0.0.jar" "$HOST:C:/forgeaip/dl/"
scp_to "$cands" "$HOST:C:/forgeaip/exchange/"
ps <<EOF
\$ErrorActionPreference = 'Stop'
\$h = 'C:\forgeaip'
\$env:Path = "\$h\node;" + \$env:Path
Remove-Item -Recurse -Force "\$h\app\src", "\$h\app\scripts" -ErrorAction SilentlyContinue
tar -xf "\$h\dl\app.tar" -C "\$h\app"
\$lock = (Get-FileHash "\$h\app\package-lock.json").Hash
if (-not (Test-Path "\$h\app\node_modules") -or ((Get-Content "\$h\app\.lockhash" -ErrorAction SilentlyContinue) -ne \$lock)) {
  Push-Location "\$h\app"; & "\$h\node\npm.cmd" ci --omit=dev --no-audit --no-fund *> "\$h\logs\npm.log"; \$rc = \$LASTEXITCODE; Pop-Location
  if (\$rc -ne 0) { throw 'npm ci failed: logs\npm.log' }
  Set-Content -NoNewline "\$h\app\.lockhash" \$lock
}
Remove-Item "\$h\mods\*.jar" -ErrorAction SilentlyContinue
Move-Item -Force "\$h\dl\*.jar" "\$h\mods\"
'pc: app and mods synced'
EOF

# 3. One server directory per group (127.0.0.1:25600+k, RCON 25700+k), stop what runs, optionally new worlds, start the supervisor.
stop_pc >/dev/null
ps <<EOF
\$ErrorActionPreference = 'Stop'
\$h = 'C:\forgeaip'
\$pass = Get-Content -Raw "\$h\rcon.txt"
for (\$k = 0; \$k -lt $groups; \$k++) {
  \$d = "\$h\servers\g\$k"
  if (-not (Test-Path "\$d\libraries")) { robocopy "\$h\forge-base" \$d /E /NFL /NDL /NJH /NJS /NP | Out-Null }
  New-Item -ItemType Directory -Force "\$d\mods" | Out-Null
  Remove-Item "\$d\mods\*.jar" -ErrorAction SilentlyContinue
  Copy-Item "\$h\mods\*.jar" "\$d\mods\"
  if ($fresh -eq 1) { Remove-Item -Recurse -Force "\$d\world" -ErrorAction SilentlyContinue; Remove-Item -Force "\$h\exchange\sites\pc-s\$($SHARD0 + \$k).json" -ErrorAction SilentlyContinue }
  @(
    'server-ip=127.0.0.1', "server-port=\$(25600 + \$k)", 'enable-rcon=true', "rcon.port=\$(25700 + \$k)", "rcon.password=\$pass",
    'online-mode=false', 'enforce-secure-profile=false', 'level-seed=$seed', 'level-type=minecraft\:normal', 'generate-structures=true',
    'gamemode=survival', 'difficulty=normal', 'spawn-animals=true', 'spawn-monsters=true', 'spawn-npcs=true', 'allow-nether=true',
    'simulation-distance=5', 'view-distance=6', 'max-tick-time=-1', 'spawn-protection=0', 'allow-flight=true', 'max-players=8',
    'enable-query=false', 'motd=forgeaip RL training (PC group ' + \$k + ')'
  ) | Set-Content -Encoding ascii "\$d\server.properties"
  'eula=true' | Set-Content -Encoding ascii "\$d\eula.txt"
  '[{"uuid":"$owner_uuid","name":"Seia_Y","level":4,"bypassesPlayerLimit":false}]' | Set-Content -Encoding ascii "\$d\ops.json"
  '-Xms2G -Xmx2G -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20' | Set-Content -Encoding ascii "\$d\user_jvm_args.txt"
  "@user_jvm_args.txt @libraries/net/minecraftforge/forge/$FORGE/win_args.txt" | Set-Content -Encoding ascii "\$d\args.txt"
}
@{ base = '$TRAIN_BASE'; groups = $groups; shard0 = $SHARD0; bots = $TRAIN_BOTS; days = $TRAIN_DAYS; speed = $TRAIN_SPEED; candidates = 'sites-$seed.json' } | ConvertTo-Json | Set-Content -Encoding ascii "\$h\config.json"
Remove-Item -Force "\$h\STOP" -ErrorAction SilentlyContinue
\$cl = '"' + "\$h\node\node.exe" + '" "' + "\$h\app\scripts\train\pc\supervisor.js" + '" "' + \$h + '"'
\$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = \$cl; CurrentDirectory = \$h }
if (\$r.ReturnValue -ne 0) { throw "supervisor start failed: \$(\$r.ReturnValue)" }
# Back after a reboot of the PC: a hidden start at logon (the owner's own startup folder; scripts/train/pc.sh down removes it).
'CreateObject("WScript.Shell").Run """' + "\$h\node\node.exe" + '"" ""' + "\$h\app\scripts\train\pc\supervisor.js" + '"" ""' + \$h + '""", 0, False' |
  Set-Content -Encoding ascii "\$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\forgeaip-train.vbs"
"pc: supervisor pid \$(\$r.ProcessId), $groups groups"
EOF

# 4. The relay on this side (restarts by itself; a mirror of the PC's runs in exchange/).
printf 'PC_BASE=%s\nPC_SHARD0=%s\n' "$TRAIN_BASE" "$SHARD0" > "$REPO/exchange/.train-pc-env"
systemctl --user link "$REPO/scripts/train/systemd/forgeaip-train-pc-relay.service" >/dev/null 2>&1 || true
systemctl --user daemon-reload
systemctl --user enable forgeaip-train-pc-relay.service >/dev/null 2>&1
systemctl --user restart forgeaip-train-pc-relay.service
echo "pc: $groups groups (shards $SHARD0..$((SHARD0 + groups - 1)), bots $((SHARD0 * TRAIN_BOTS + 1))..$(((SHARD0 + groups) * TRAIN_BOTS)) counted from 1), relay running"
