# Install the forgeaip-create client mods (forgeaip-create.lock.json: Create + optimisation) into a Minecraft mods folder,
# every jar checked against the sha512 in the lock. Jars that are not in the set are moved aside (never deleted).
# Usage (PowerShell, no elevation):  .\modpack\install-client.ps1 [-ModsDir <folder>]   default: %APPDATA%\.minecraft\mods
# Forge 1.20.1-47.4.10 must be installed in the launcher (the script prints the installer link).
param(
    [string]$ModsDir = (Join-Path $env:APPDATA '.minecraft\mods'),
    [string]$Lock = (Join-Path $PSScriptRoot 'forgeaip-create.lock.json')
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$set = Get-Content -Raw $Lock | ConvertFrom-Json
$want = @($set.mods | Where-Object { $_.side -in 'both', 'client' })
New-Item -ItemType Directory -Force $ModsDir | Out-Null

$other = @(Get-ChildItem $ModsDir -Filter *.jar | Where-Object { $_.Name -notin $want.file })
if ($other.Count) {
    $aside = Join-Path (Split-Path $ModsDir) ('mods-before-forgeaip-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory $aside | Out-Null
    $other | Move-Item -Destination $aside
    "moved $($other.Count) other jar(s) to $aside"
}

foreach ($m in $want) {
    $path = Join-Path $ModsDir $m.file
    if ((Test-Path $path) -and (Get-FileHash $path -Algorithm SHA512).Hash -eq $m.sha512) { "kept    $($m.file)"; continue }
    $part = "$path.part"
    Invoke-WebRequest -Uri $m.url -OutFile $part -UserAgent 'forgeaip/1.0' -UseBasicParsing
    if ((Get-FileHash $part -Algorithm SHA512).Hash -ne $m.sha512) { Remove-Item $part; throw "$($m.file): sha512 does not match the lock" }
    Move-Item -Force $part $path
    "fetched $($m.file)"
}
"Needs Forge $($set.forge) for Minecraft $($set.minecraft): https://maven.minecraftforge.net/net/minecraftforge/forge/$($set.minecraft)-$($set.forge)/forge-$($set.minecraft)-$($set.forge)-installer.jar"
