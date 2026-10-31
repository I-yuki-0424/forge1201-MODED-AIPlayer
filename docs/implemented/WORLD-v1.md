# Build world v1: a persistent modded world the owner builds in, reusable as test scenarios

`TASK-20261031-019` (2026-10-31). A Forge 1.20.1 server on the VPS that the owner joins from the PC to build test sites
for the bot (ladders, water, mod blocks, animals), with snapshots so a built state can be reused: bots and benchmarks run
on disposable copies, never on the build. The LLM-driven bot (`TASK-20261031-017`, `-018`) runs in the same world.

## Connect

| What | Value |
| :-- | :-- |
| Minecraft server address | `100.115.238.9` (port 25565, the default). `vps-160.tailfc1fac.ts.net` also works where MagicDNS resolves |
| Who can reach it | devices on the owner's tailnet only (PC, phone): `tailscale serve --tcp 25565 tcp://localhost:25567`, the same mechanism as SSH. Not public: the server listens on `127.0.0.1:25567`, the tailnet listener is bound to `tailscale0`; `nmap -sC` of the public IP from the host: 25565-25568 closed |
| Client | Forge 1.20.1-47.4.10 with the client set of [MODPACK-v1.md](MODPACK-v1.md). Tailscale must be connected on the PC; WARP and Tailscale both use 100.64.0.0/10 (handbook 02 §4) |
| Game mode | creative by default for players; `scripts/world/op.sh <name>` gives operator rights for commands |
| Bots | offline-mode logins (no Microsoft accounts); the bot `AI_Bot_01` is set to survival |

Offline mode means a client on the tailnet can join under any name. That is the same trust boundary as SSH to this host;
nothing outside the tailnet reaches the port.

## Mods

Since TASK-20261031-020 the world runs the minimal set of [MODPACK-v1.md](MODPACK-v1.md): vanilla + Create +
optimisation, pinned in `modpack/forgeaip-create.lock.json`. `up.sh` / `restart.sh` sync the server jars from the lock,
so there is nothing to copy; the client side (a `.mrpack` or `modpack/install-client.ps1`) is described there.
Memory: the world runs with a 3 GB heap in a 4 GB container; do not run it next to the RL server
(`scripts/rl/down.sh`) on this 12 GB host.

## Reuse a built state

| Command (on the VPS; from the PC prefix with `ssh vps`) | Does |
| :-- | :-- |
| `scripts/world/snapshot.sh <label>` | consistent snapshot (saving paused, flushed, archived, resumed) to `/mnt/data/forgeaip/snapshots/<label>-<UTC>.tar.gz` + `.json` manifest (mod files with sha256). Named snapshots are kept |
| `scripts/world/snapshot.sh --list` | list snapshots |
| automatic | hourly (`forgeaip-world-snapshot.timer`, user unit of coder) and before every stop, restart or restore; the newest 24 `auto*` are kept |
| `scripts/world/restore.sh <label \| file \| latest>` | roll the build world back (snapshots the current state first) |
| `scripts/world/test-up.sh <label \| file \| latest>` | disposable copy on `127.0.0.1:25568`, world in tmpfs: nothing a bot does there reaches the build world. `test-down.sh` removes it |

Verified 2026-10-31: a block placed in the build world was present in a test copy of its snapshot; a block placed in the
copy was absent from the build world. The scripts work when run as root (`ssh vps`): they re-run themselves as coder,
whose rootless Docker owns the containers.

## The LLM bot in the world

`scripts/world/bot-up.sh` / `bot-down.sh` start and stop `forgeaip-llm-bot` (`node index.js` with `BOT_RUNTIME=skills`).
Players give instructions in chat with a leading `-` (`-collect 8 logs`, `-来て`), `-!` for a status question that does
not interrupt. WebUI: `127.0.0.1:3020` on the VPS (unauthenticated, loopback only; host 3000 is the honeypot Grafana).

LLM credentials come from the vault record **`ollama/forgeaip`**, which only the owner can save (vault page behind Access
and the security key; the vault has no machine write path by design):

1. Open https://vault.i-yuki.com, add a record with id `ollama/forgeaip`, kind token.
2. Value: the Ollama API key. Named values: `url` = the endpoint, `model` = the model (optional, default `gpt-oss:20b-cloud`).
   For Ollama's hosted API the endpoint is `https://ollama.com/api/generate` with a model name without the `-cloud`
   suffix (e.g. `gpt-oss:20b`); verified 2026-10-31 with the saved record (one call, 1.1 s).
3. Nothing else: the bot re-reads the vault every 10 minutes until it finds the record (log line `[Vault] LLM credentials now from the vault`).

The bot reads with its own Access service token (`forgeaip-llm-reads-vault`, valid one year, in the git-ignored
`config/vault-llm.conf`), granted that one record only (`CLIENT_READ` in MCP-credential-broker `vault/wrangler.jsonc`).
Rotate it with `python3 scripts/vault-client.py forgeaip-llm <conf>` through the broker (MCP-credential-broker).

## Files

`docker/world-server/compose.yaml` (services `world`, `world-test` [profile test], `llm-bot` [bot], `intent-check`
[check]); `scripts/world/*.sh`, `scripts/world/systemd/*`; volume `forgeaip-world_data` (server, world, Forge install);
`/mnt/data/forgeaip/mods` (synced from the lock), `/mnt/data/forgeaip/snapshots`, `/mnt/data/forgeaip/forgeaip-create.mrpack`.
