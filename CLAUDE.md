# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
Parent rules (all repos on this VPS): `/home/coder/projects/CLAUDE.md`. Where this file is more specific, follow this file.

## Boot Protocol

At the start of every session read **all files in `docs/core/`**: `MASTER_GUIDANCE.xml` (rules),
`GOAL.md` (purpose and the link to Decision-Process-order-driven), `STATE.yaml` (live state: quote it, never invent
values). Then search the knowledge-DB (`search_knowledge`, `path_prefix: repos/forge1201-MODED-AIPlayer/`) and
run `schedule_check`. If `active_tasks` is empty, pick from `docs/proposed/`. Documentation map: `docs/README.md`.

## Commands

There is **no Node.js on the VPS**. Run Node through the rootless docker (as `coder`, plain `docker`):

```bash
# All tests (7 files, must pass before STATE.yaml claims a green state). Node 20 or 22.11; NOT 22.23.4 (docs/LESSONS.md L2).
docker run --rm --network none -v "$PWD":/w -w /w node:20-slim npm test
# One file
docker run --rm --network none -v "$PWD":/w -w /w node:20-slim node tests/test_fml3_handshake_logic_pure.js
# Restore dependencies (node_modules is not tracked) / audit
docker run --rm -v "$PWD":/w -w /w node:20-slim npm ci
docker run --rm -v "$PWD":/w -w /w node:20-slim npm audit --omit=dev
```

RL environment on the VPS (docs/implemented/RL-INTERFACE-v1.md): `scripts/rl/up.sh` starts a Forge 1.20.1 server
(rootless docker, 127.0.0.1 only, tmpfs world), `python3 scripts/rl/verify_game_side.py` runs 20 game-side checks against it
(needs the DPOD checkout next to this repo), `scripts/rl/down.sh` removes it. The server is a long-running job: register it
on the schedule first (MASTER_GUIDANCE `<schedule>`).

On the owner's PC (Windows/WSL2): `npm ci`, `npm test`, `npm run test:e2e`, `node index.js` (or `run.bat` / `./run.sh`).
Running the bot needs a Forge 1.20.1 server and an Ollama-compatible endpoint, which exist only on the owner's PC.

## Environment

Copy `.env` values (file is git-ignored; never print or commit it):
- `OLLAMA_URL` full endpoint (e.g. `http://172.24.96.1:11434/api/generate`). In WSL2 `localhost` is the Linux VM, use the Windows gateway IP.
- `OLLAMA_MODEL` default `gpt-oss:20b-cloud`; `OLLAMA_API_KEY` bearer token; `OLLAMA_AUTH_SCHEME` default `Bearer` (empty = send key bare).
- Others: `docs/references/variable_map.md`.

## Repository layout

```
index.js            entry: AgentManager + WebUI (the debug WebSocket :3001 is started by each bot_actuator child)
src/rl/             RL environment (env, controls, observation, goal, DPOD file-API runner); src/transport/ = login/FML3 factory shared with the actuator
src/                runtime (agent_manager, bot_actuator + actuator/*, forge_handshake_state_machine, dynamic_registry_injector, middleware, llm_client, web_ui_server)
tests/              the 7 files run by `npm test` (+ mocks, run_tests.js, smoke.js)
public/             WebUI (static)
aux_mod/            optional Forge 1.20.1 companion mod (Java/Gradle; exports the block registry, in-game launcher/HUD)
docker/             compose for a CUDA dev box and for the full stack (docker/forge-server)
data/               system_presets.json + junk_list.json (tracked); data/sample/configs (mod dictionary); everything else here is runtime state and ignored
scripts/            tooling; scripts/adhoc = old probes, not tests
docs/               core/ (rules, goal, state), ARCHITECTURE, LESSONS, guides, references, proposed, implemented, archive
```

## Architecture

The system connects a Mineflayer bot to a Minecraft 1.20.1 Forge server, bridging the incompatible FML3 protocol, and drives the bot using an LLM via a parent-process orchestrator. Full spec: `docs/ARCHITECTURE.md` (the code wins on conflict).

### Process Model

`index.js` → `AgentManager` (parent) → `bot_actuator.js` (child via `fork()`), IPC:
- Parent→Child: `EXECUTE_ACTION` (array of action objects)
- Child→Parent: `USER_CHAT`, `ERROR`, `STATUS`

`AgentManager` queues chat, enforces a 5 s LLM cooldown, and tracks in-flight LLM calls per bot (`activeLlmRequests`, keyed by botId). On a new `EXECUTE_ACTION` the actuator sets `currentCancelToken.cancelled = true`, drains the queue, then awaits `isExecuting` before assigning a new token (prevents races).

### Forge Protocol Bridge (`src/forge_handshake_state_machine.js`)

Intercepts `login_plugin_request` and acts as a transparent proxy; `fml:loginwrapper` wraps `fml:handshake`. Disc 1 → mod list reply; 3 → buffer registry sync; 4 → Ack; 6 → complete. Emits `handshake_complete` with the buffered registry payload. The trigger is the host suffix `\0FML3\0` (breaks on Node 22.23.4, BUGFIX-20261030-002).

### Modded Block Registry (`src/dynamic_registry_injector.js`)

Forge remaps state IDs, breaking Prismarine's vanilla registry. It loads `data/sample/configs/mod_blocks_dictionary.json`, parses `namespace:blockname` from handshake buffers, deep-copies vanilla templates for mod blocks, and installs a Proxy on `registry.blocksByStateId` that resolves unknown IDs by binary search to the parent block (no pathfinder crashes).

### Bot Actuator (`src/bot_actuator.js`, ~6.7k lines, plus `src/actuator/{ctx,environment,flight,tools,utils}.js`)

Initialises Mineflayer with pathfinder, collectblock, DynamicRegistryInjector and middleware.
- **Chat dedup**: 3 s window (`_chatDedup`) against Forge's double `player_chat` + `system_chat`.
- **`ensureToolFor(block)`**: skips fluid/air; crafts tools only for diggable solids.
- **`withTimeout(ms, promise)`** wraps every async action; per-block collect cap `Math.min(timeoutMs, 20000)`.
- **Pathfinder limits**: `thinkTimeout = 5000`, `tickTimeout = 5` (prevents heap exhaustion on mod terrain).
- **Actions**: come, goto, collect, give, place, craft, equip, eat, smelt, kill, sleep, brew, enchant, explore, navigate_portal, activate_end_portal, place_pattern, status, stop (more in README "Action Reference").

### LLM client, middleware

`src/llm_client.js`: Ollama / OpenAI-chat / OpenAI-completions via `extractText()`; returns `null` on any error (caller must check); API key stripped of BOM/control characters. Middleware: `event_debouncer.js` (500 ms VeinMiner debounce), `inventory_nbt_patch.js` (stackSize → INT_MAX, true count from `StorageCount`), `create_contraption_hazard.js` (Create contraption AABBs non-walkable).

## Task and docs workflow

- Task state: `docs/core/STATE.yaml`; specs in `docs/proposed/` → `docs/implemented/`; old history in `docs/archive/`.
- After every code change update `STATE.yaml` (`recent_changes`, `smoke_status` = the real last test run) .
- Commit format `TASK:<task-id> <type>: <description>`. Commit in coherent units, push each; `main` equals `origin/main` when finished.
- Docs-only tasks do not modify `src/` or `tests/`.
- Before changing a symbol run scip-neo4j `analyze_change_impact` / `get_symbol_dependencies` / `check_symbol_constraints` with `repo=https://github.com/I-yuki-0424/forge1201-MODED-AIPlayer`; use `get_index_status` to confirm the index is active, else read the code.
- Do not track `node_modules`, build output, logs, runtime `data/*.json`, JDKs. Git LFS: archives only (`docs/LESSONS.md` L1).
- Security: WebUI/debug WS are unauthenticated and must stay on loopback (L3). Dependency advisories: `TASK-20261030-004`.
