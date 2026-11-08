# Minecraft Forge 1.20.1 AI Player

An autonomous player for **modded Minecraft 1.20.1 (Forge 47.x)** servers, built on [Mineflayer](https://github.com/PrismarineJS/mineflayer).
Stock Mineflayer cannot join a Forge server: it fails the FML3 login handshake and cannot read the remapped block/item registry. This
repository supplies those missing parts, an action layer made only of player inputs, a pure-bot work layer, and an RL environment.

It is also the Minecraft test bed of the owner's research on [Decision-Process-order-driven (DPOD)](https://github.com/I-yuki-0424/Decision-Process-order-driven):
**control belongs to an RL policy, and the LLM only turns an instruction into a goal**, once per instruction, outside the control loop.
Purpose, direction and the link to DPOD: [`docs/core/GOAL.md`](docs/core/GOAL.md).

## What is in it

| Part | Where | What it does |
| :-- | :-- | :-- |
| Forge bridge | `src/forge_handshake_state_machine.js`, `src/transport/` | Answers the FML3 login (`login_plugin_request`, host suffix `\0FML3\0`), buffers the registry sync, shared by every bot type |
| Mod registry | `src/transport/mod_registry.js`, `modpack/*.registry.json` | Installs mod blocks and items exactly: ids from the handshake, state counts, properties and collision boxes from a registry dump |
| Action layer | `src/skills/` | 14 commands (`move_to`, `mine`, `place`, `craft`, `smelt`, `attack`, ...), each a sequence of per-tick input frames, graded by what the **server** confirms, ending in `ok` or a reason from a closed list. Spec: [`SKILLS-v1`](docs/implemented/SKILLS-v1.md) |
| Orchestrator | `index.js`, `src/agent_manager.js` | Parent process: forks one child per bot (`src/skills_bot.js`; `BOT_RUNTIME=legacy` forks the old `src/bot_actuator.js`), queues chat, calls the LLM |
| Pure bots | `src/work/`, `public/work/` | Bots that need no decisions: crews that dig pits, build structures, gather items, run scripts and routines; token-authenticated web console. Map: [`src/work/README.md`](src/work/README.md), spec: [`WORK-CONSOLE-v1`](docs/implemented/WORK-CONSOLE-v1.md) |
| RL environment | `src/rl/` | Observation, controls, goals and a file API that DPOD's `integrations/botsystem/` drives as the policy. Spec: [`RL-INTERFACE-v1`](docs/implemented/RL-INTERFACE-v1.md) |
| Mod set | `modpack/` | Vanilla + Create + optimisation mods, pinned by sha512 in `forgeaip-create.lock.json`; `pack.py` syncs a server or builds the `.mrpack`. Spec: [`MODPACK-v1`](docs/implemented/MODPACK-v1.md) |
| Servers | `docker/rl-server`, `docker/world-server`, `scripts/rl`, `scripts/world` | A disposable RL server, and the persistent build world with snapshots ([`WORLD-v1`](docs/implemented/WORLD-v1.md)) |
| Companion mods | `aux_console/`, `aux_mod/` (Java, Gradle) | `aux_console`: in-game console and web view for the work layer. `aux_mod`: an older companion mod, unused |

Legacy and rollback: `src/bot_actuator.js` (about 6.7k lines, the former LLM-planned action path) and `src/dynamic_registry_injector.js`.
They are kept only for `BOT_RUNTIME=legacy`.

## Quick start

Requirements: Node **20 LTS** (`.nvmrc`; 22.11 also works, **22.23.4 does not**: it rejects the `\0FML3\0` host marker, [`LESSONS` L2](docs/LESSONS.md)),
a Forge 1.20.1 server, and an Ollama-compatible LLM endpoint.

```bash
npm ci
cp your-values .env      # git-ignored; variables below and in docs/references/variable_map.md
node index.js            # or ./run.sh, or run.bat on Windows
npm test                 # needs no server
```

| Variable | Default | Meaning |
| :-- | :-- | :-- |
| `MC_HOST`, `MC_PORT` | `localhost`, `25565` | Forge server |
| `BOT_NAMES` / `BOT_NAME` | `AI_Bot_01` | Bot user names (comma separated) |
| `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_API_KEY` | model `gpt-oss:20b-cloud` | LLM endpoint (full URL, e.g. `http://<host>:11434/api/generate`; inside WSL2 use the Windows gateway IP, not `localhost`) |
| `OLLAMA_AUTH_SCHEME` | `Bearer` | Empty sends the key bare |
| `BOT_RUNTIME` | `skills` | `legacy` forks the old actuator |

On the owner's VPS the LLM credentials come from the vault record `ollama/forgeaip` first and `.env` is the fallback
([`WORLD-v1`](docs/implemented/WORLD-v1.md)). Full variable list and IPC schema: [`docs/references/variable_map.md`](docs/references/variable_map.md).

The bot itself needs no GPU. A local 20B-class model needs about 16 GB RAM and 8 GB VRAM; a cloud endpoint needs almost nothing.

## Tests

`npm test` runs the 35 files listed in `package.json` (mock Forge server, handshake, registry, action-layer simulation, RL environment,
work layer). None needs a Minecraft server. One file: `node tests/test_skills_pure.js`. Live checks that do need a real Forge server
(`scripts/skills/bench.js`, `scripts/work/*_live.js`, `scripts/rl/verify_game_side.py`) are described in the specs above.
On the VPS there is no Node on the host; use `docker run --rm --network none -v "$PWD":/w -w /w node:20-slim npm test` (see [`CLAUDE.md`](CLAUDE.md)).

## Security

- The bot WebUI (`:3000`, retrying `3001`, `3002`, ...) and the debug WebSocket (`:3001`) have **no login**. Keep them on loopback; the Docker stacks publish them on `127.0.0.1` only ([`LESSONS` L3](docs/LESSONS.md)).
- The work console (`src/work/web/`) is token-authenticated, with CSRF and Host/Origin checks and closed validation; keep all of them when changing it.
- `.env` is git-ignored. API keys never go into logs, docs or commits ([`LESSONS` L5](docs/LESSONS.md)).

## Debugging a bot without watching it

Do not stream a running bot into an agent session: read the files instead.

- `bot_system.log`: INFO-level log; the WebUI line shows the actual port (`[WebUI] Dashboard available at http://localhost:<port>`).
- `ai_debug_<bot>.json`: rewritten every few seconds with timestamp, health, position and queue, so a stuck bot is visible.
- Per-tick command traces and the failure taxonomy of the action layer: [`SKILLS-v1`](docs/implemented/SKILLS-v1.md).
- `node scripts/extract_debug_logs.js` scans the log for error keywords; the scenario suite is `scripts/beta_debugger.js` ([`AI_DEBUGGING`](docs/guides/AI_DEBUGGING.md)).

To record the bot's point of view, spectate it from a separate client (`/spectate <botName>`) and capture that window with OBS or ReplayMod;
the bot itself is headless.

## Documentation

Start at [`docs/README.md`](docs/README.md). Agent rules are in [`CLAUDE.md`](CLAUDE.md) and [`docs/core/MASTER_GUIDANCE.xml`](docs/core/MASTER_GUIDANCE.xml);
design is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (the code wins on conflict); incidents and the rules they produced are in [`docs/LESSONS.md`](docs/LESSONS.md).

Licence: Apache-2.0.
