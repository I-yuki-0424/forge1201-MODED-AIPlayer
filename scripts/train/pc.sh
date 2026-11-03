#!/usr/bin/env bash
# Training on the owner's PC (owner 2026-11-02: "from bot 11 on, use the PC ... train with abundant resources"; SSH key
# ~/.ssh/id_ed25519_pc, the PC allows only the VPS's tailnet address). Each PC group: a Forge 1.20.1 server bound to 127.0.0.1
# + one environment process; plus the learner for every group (DPOD botsystem_goal_ppo.py in a venv with the VPS's pinned jax).
# scripts/train/pc/supervisor.js keeps them alive; scripts/train/relay.py (systemd user unit forgeaip-train-pc-relay) mirrors
# between the two exchange/ directories what the other side reads. Nothing on the PC listens beyond loopback.
#   scripts/train/pc.sh up --groups G [--fresh-world]     (base, bots, days, speed: exchange/.train-env from up.sh)
#   scripts/train/pc.sh down | status | pause | resume | gpu-setup
#   scripts/train/pc.sh wsl-install | wsl-up [--base B --shards S --max-steps N --learner-args "..."] | wsl-down | wsl-status   (sim shards + GPU learner, all in WSL2; pc/wsl-sim.sh)
#   pause/resume: create/remove C:\forgeaip\PAUSE (the supervisor stops everything gracefully / starts it again). The supervisor also
#     pauses by itself 12:00-18:00 JST every day (owner 2026-11-02); scripts/train/window.sh does the same for the VPS side.
#   gpu-setup: CUDA jax for the learner in WSL2 (the only supported GPU route for jax on Windows); needs WSL installed first by the
#     owner (elevated PowerShell: wsl --install -d Ubuntu-22.04, then reboot), prints that if it is missing.
# PC layout C:\forgeaip: node\ (portable Node 20, sha256-checked), forge-base\ (Forge installer output, sha1-checked), mods\,
# app\ (src + scripts/train/pc + relay.py + production node_modules), dpod\ (the learner's files), venv\ (Python 3.14, jax pinned),
# servers\g<k>\ (one per group), exchange\, logs\, rcon.txt (random).
DPOD=${DPOD_DIR:-$(cd "$(dirname "$0")/../../../Decision-Process-order-driven" && pwd)}
PYPKG='jax==0.12.0.1 jaxlib==0.12.0.1 optax==0.2.8 numpy==2.5.4 ml_dtypes==0.6.0'   # = the VPS learner's venv (rl-jaxvenv)
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
# A bash script on the PC, run inside WSL2 Ubuntu-22.04 (the GPU and the Linux simulator live there): wsl_run <local file> [args...]
wsl_run() {
  local f=$1; shift
  scp_to "$f" "$HOST:C:/forgeaip/dl/_wsh.sh"
  "${SSH[@]}" "powershell -NoProfile -Command \"\$ErrorActionPreference='Continue'; wsl.exe -d Ubuntu-22.04 -- bash /mnt/c/forgeaip/dl/_wsh.sh $* 2>&1 | ForEach-Object { \\\"\$_\\\" }\"" | tr -d '\r'
}

cmd=${1:-status}; shift || true
WSLARGS=(); if [[ $cmd == wsl-* ]]; then WSLARGS=("$@"); set --; fi   # wsl-* take their own options
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
pause) ps <<'EOF'
New-Item -ItemType File -Force 'C:\forgeaip\PAUSE' | Out-Null
'pc: PAUSE set'
EOF
  exit 0;;
resume) ps <<'EOF'
Remove-Item -Force -ErrorAction SilentlyContinue 'C:\forgeaip\PAUSE'
'pc: PAUSE removed'
EOF
  exit 0;;
wsl-install)   # everything the WSL training needs, from this checkout (tiles 833 MB the first time)
  ssh_dir='if not exist C:\forgeaip\dl\sim-tiles mkdir C:\forgeaip\dl\sim-tiles'; "${SSH[@]}" "$ssh_dir" >/dev/null
  [ -x "$REPO/tools/sim/target/bookworm/release/forgeaip-sim" ] || "$REPO/tools/sim/build.sh"
  T=$(mktemp -d); (cd "$DPOD" && tar czf "$T/dpod.tgz" --exclude=__pycache__ scripts/botsystem_*.py integrations src)
  scp_to "$REPO/tools/sim/target/bookworm/release/forgeaip-sim" "$REPO/src/rl/reward-v6.json" "$REPO/src/rl/progress-list.json" "$T/dpod.tgz" "$REPO/scripts/train/pc/wsl-sim.sh" "$REPO/scripts/train/profile_learner.py" "$HOST:C:/forgeaip/dl/"
  have=$("${SSH[@]}" 'dir /b C:\forgeaip\dl\sim-tiles' | wc -l); want=$(ls /mnt/data/forgeaip/sim-tiles/*.tile | wc -l)
  [ "$have" -ge "$want" ] || scp_to /mnt/data/forgeaip/sim-tiles/*.tile "$HOST:C:/forgeaip/dl/sim-tiles/"
  cat > "$T/install.sh" <<'EOS'
set -e
D=/mnt/c/forgeaip/dl
mkdir -p ~/sim/tiles ~/sim/r ~/x/logs ~/dpod
cp "$D/forgeaip-sim" ~/sim/ && chmod +x ~/sim/forgeaip-sim
cp "$D/reward-v6.json" "$D/progress-list.json" ~/sim/r/
[ "$(ls ~/sim/tiles | wc -l)" -ge "$(ls $D/sim-tiles | wc -l)" ] || cp "$D"/sim-tiles/*.tile ~/sim/tiles/
rm -rf ~/dpod/scripts ~/dpod/integrations ~/dpod/src; (cd ~/dpod && tar xzf "$D/dpod.tgz")
cp "$D/wsl-sim.sh" ~/sim/wsl-sim.sh && chmod +x ~/sim/wsl-sim.sh; cp "$D/profile_learner.py" ~/
echo "installed: $(ls ~/sim/tiles | wc -l) tiles"
EOS
  wsl_run "$T/install.sh"; rm -rf "$T"; exit 0;;
wsl-up|wsl-down|wsl-status)
  f=$(mktemp); { printf 'exec ~/sim/wsl-sim.sh %s' "${cmd#wsl-}"; for a in "${WSLARGS[@]}"; do printf ' %q' "$a"; done; echo; } > "$f"
  # a hidden `sleep infinity` keeps the WSL2 VM from idling out while processes run in it
  if [ "$cmd" = wsl-up ]; then ps <<'EOF'
if (-not (Get-Process -Name wsl -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*sleep infinity*' })) {
  Start-Process -WindowStyle Hidden -FilePath wsl.exe -ArgumentList '-d','Ubuntu-22.04','--','sleep','infinity'
}
EOF
  fi
  wsl_run "$f"; rm -f "$f"; exit 0;;
gpu-setup)
  out=$(ps <<'EOF'
$d = ((& wsl.exe -l -q 2>$null) -join '') -replace "`0", ''
if ($LASTEXITCODE -ne 0 -or -not ($d -match 'Ubuntu-22.04')) { 'NOWSL'; exit 3 }
'WSL_OK'
EOF
  ) || true
  if ! grep -q WSL_OK <<<"$out"; then
    cat >&2 <<'MSG'
pc gpu-setup: WSL2 with Ubuntu-22.04 is not installed on the PC. jax has no native-Windows CUDA wheels, so the GPU learner needs it.
Owner, once, in PowerShell started as Administrator:   wsl.exe --install -d Ubuntu-22.04      (then reboot; finish the Ubuntu first-run user setup)
Also needed: the current Windows NVIDIA driver (WSL CUDA support is part of the normal Game Ready/Studio driver).
Then run again:   scripts/train/pc.sh gpu-setup
MSG
    exit 3
  fi
  scp_to "$REPO/scripts/train/pc/wsl-gpu-setup.sh" "$HOST:C:/forgeaip/dl/wsl-gpu-setup.sh"
  ps <<'EOF'
$ErrorActionPreference = 'Stop'
$h = 'C:\forgeaip'
# native stderr ("downloading uv") is an ErrorRecord in PowerShell and would stop the script under 'Stop'
$ErrorActionPreference = 'Continue'
$o = (& wsl.exe -d Ubuntu-22.04 -- bash /mnt/c/forgeaip/dl/wsl-gpu-setup.sh 2>&1 | ForEach-Object { "$_" } | Out-String)
$ErrorActionPreference = 'Stop'
$o
$m = [regex]::Match($o, 'PYTHON=(\S+)')
if (-not $m.Success) { throw 'gpu-setup failed (see output above)' }
@{ distro = 'Ubuntu-22.04'; python = $m.Groups[1].Value } | ConvertTo-Json | Set-Content -Encoding ascii "$h\gpu.json"
'pc: learner will use the GPU from its next start (gpu.json written)'
EOF
  exit 0;;
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
*) echo "usage: $0 up --groups G [--fresh-world] | down | status | pause | resume | gpu-setup" >&2; exit 2;;
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
  cmd /c "cd /d \$h\forge-base && java -jar \$h\dl\forge-installer.jar --installServer \$h\forge-base > \$h\logs\forge-install.log 2>&1"
  if (-not (Test-Path "\$h\forge-base\libraries\net\minecraftforge\forge\\$FORGE\win_args.txt")) { throw 'forge install failed: logs\forge-install.log' }
}
if ((Get-Content "\$h\venv\pinned.txt" -ErrorAction SilentlyContinue) -ne '$PYPKG') {
  if (-not (Test-Path "\$h\venv\Scripts\python.exe")) { & py -3.14 -m venv "\$h\venv" }
  cmd /c "\$h\venv\Scripts\python.exe -m pip install --disable-pip-version-check -q $PYPKG > \$h\logs\pip.log 2>&1"
  if (\$LASTEXITCODE -ne 0) { throw 'pip install failed: logs\pip.log' }
  Set-Content -NoNewline "\$h\venv\pinned.txt" '$PYPKG'
}
if (-not (Test-Path "\$h\rcon.txt")) { -join ((48..57) + (97..102) | Get-Random -Count 32 | % { [char]\$_ }) | Set-Content -NoNewline "\$h\rcon.txt" }
'pc: tools ready'
EOF

# 2. The application (environment code, the supervisor and relay) and its production dependencies; mods; site candidates.
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
tar -C "$REPO" -cf "$tmp/app.tar" package.json package-lock.json src modpack/forgeaip-create.registry.json modpack/forgeaip-create.advancements.json scripts/train/pc scripts/train/relay.py
tar -C "$DPOD" -cf "$tmp/dpod.tar" scripts/botsystem_goal_ppo.py scripts/botsystem_goal_wm.py scripts/botsystem_skill_ppo.py scripts/botsystem_skill_truck.py scripts/botsystem_teacher.py \
  integrations/__init__.py integrations/botsystem src/__init__.py src/model/epa_policies.py
scp_to "$tmp/app.tar" "$tmp/dpod.tar" "$MODS"/*.jar "$REPO/tools/tickrate/build/libs/forgeaip-tickrate-1.0.0.jar" "$HOST:C:/forgeaip/dl/"
scp_to "$cands" "$HOST:C:/forgeaip/exchange/"
ps <<EOF
\$ErrorActionPreference = 'Stop'
\$h = 'C:\forgeaip'
\$env:Path = "\$h\node;" + \$env:Path
Remove-Item -Recurse -Force "\$h\app\src", "\$h\app\scripts" -ErrorAction SilentlyContinue
tar -xf "\$h\dl\app.tar" -C "\$h\app"
Remove-Item -Recurse -Force "\$h\dpod" -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force "\$h\dpod" | Out-Null
tar -xf "\$h\dl\dpod.tar" -C "\$h\dpod"
\$lock = (Get-FileHash "\$h\app\package-lock.json").Hash
if (-not (Test-Path "\$h\app\node_modules") -or ((Get-Content "\$h\app\.lockhash" -ErrorAction SilentlyContinue) -ne \$lock)) {
  # through cmd: PowerShell 5 turns a native command's stderr (npm's warnings) into terminating errors under 'Stop'
  cmd /c "cd /d \$h\app && \$h\node\npm.cmd ci --omit=dev --no-audit --no-fund > \$h\logs\npm.log 2>&1"; \$rc = \$LASTEXITCODE
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
@{ base = '$TRAIN_BASE'; groups = $groups; shard0 = $SHARD0; bots = $TRAIN_BOTS; days = $TRAIN_DAYS; speed = $TRAIN_SPEED; candidates = 'sites-$seed.json'; learner = \$true; learn = $TRAIN_LEARN; quiet = @{ from = 12; to = 18 } } | ConvertTo-Json | Set-Content -Encoding ascii "\$h\config.json"
Remove-Item -Force "\$h\STOP" -ErrorAction SilentlyContinue
\$cl = '"' + "\$h\node\node.exe" + '" "' + "\$h\app\scripts\train\pc\supervisor.js" + '" "' + \$h + '"'
\$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = \$cl; CurrentDirectory = \$h }
if (\$r.ReturnValue -ne 0) { throw "supervisor start failed: \$(\$r.ReturnValue)" }
# Back after a reboot of the PC: a hidden start at logon (the owner's own startup folder; scripts/train/pc.sh down removes it).
'CreateObject("WScript.Shell").Run """' + "\$h\node\node.exe" + '"" ""' + "\$h\app\scripts\train\pc\supervisor.js" + '"" ""' + \$h + '""", 0, False' |
  Set-Content -Encoding ascii "\$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\forgeaip-train.vbs"
"pc: supervisor pid \$(\$r.ProcessId), $groups groups"
EOF

# 4. The relay on this side (restarts by itself). The VPS learner container steps aside: the PC's learner serves every group.
compose --profile train stop -t 60 train-policy >/dev/null 2>&1 || true
printf 'PC_BASE=%s\nPC_SHARD0=%s\nPC_HOST=%s\nPC_KEY=%s\n' "$TRAIN_BASE" "$SHARD0" "$HOST" "$KEY" > "$REPO/exchange/.train-pc-env"
systemctl --user link "$REPO/scripts/train/systemd/forgeaip-train-pc-relay.service" >/dev/null 2>&1 || true
systemctl --user daemon-reload
systemctl --user enable forgeaip-train-pc-relay.service >/dev/null 2>&1
systemctl --user restart forgeaip-train-pc-relay.service
echo "pc: $groups groups (shards $SHARD0..$((SHARD0 + groups - 1)), bots $((SHARD0 * TRAIN_BOTS + 1))..$(((SHARD0 + groups) * TRAIN_BOTS)) counted from 1), relay running"
