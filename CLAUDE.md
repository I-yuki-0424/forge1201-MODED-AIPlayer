# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
Parent rules (all repos on this VPS): `/home/coder/projects/CLAUDE.md`. Precedence: **`docs/core/MASTER_GUIDANCE.xml` (v12) wins over
this file**, this file wins over the parent file. MASTER_GUIDANCE holds the behaviour rules (autonomy, safeguards, MCP use, engineering,
git, task tracking, response format); this file holds the commands and the map of the code, so it does not repeat the rules. Read the XML
when a task touches tokens, scheduling, tracking or git hygiene.

## Verification standard (owner 2026-11-11, binding, MASTER_GUIDANCE v12 `<verification>`)

Movement, escape and mining rates count only when measured on the REAL-WORLD TEST COPY of the play world (`scripts/real/`, docs/implemented/REAL-WORLD-VERIFICATION-v1.md):
random starts and targets in natural terrain (and the End pit), graded from the server, with a negative control. Targets: movement >= 80 %, escape >= 90 %, stuck-type pit failures <= 10 %.
The simulator (`rl3/`), `scripts/work/*_live.js` arenas and anything built with `/fill` are smoke tests, never evidence: the "28/28 live worlds" of MOVE-v3 were the simulator's own generators
and the running pit failed more than half of its units. State the world with every number.
`scripts/real/up|down|refresh` live in `/mnt/data/forgeaip-play/real/` (container `forgeaip-real`, 127.0.0.1:25572); `scripts/real/run.sh real_move.js|real_escape.js|real_pit.js`.

## Boot Protocol

1. Search the knowledge-DB (`search_knowledge` with `path_prefix` `repos/forge1201-MODED-AIPlayer/` and again `LLM-records/`) and run
   `schedule_check`. **Runtime state (tasks, hazards, `smoke_status`, change history) lives there, not in the repo.** Quote values, never
   invent them, report missing ones as missing. The schedule holds the AIPlayer task entries (006-014); a task's memory record is found by
   searching its id.
2. Do **not** read `docs/core/` in full. Read `GOAL.md` (purpose, the RL-policy/LLM split, the DPOD link) or `docs/ARCHITECTURE.md` only
   when the task touches goals or structure, and only the sections it needs (grep or ranged Read).
3. If the schedule has no active task, pick from `docs/proposed/`. Documentation map: `docs/README.md`.

`docs/core/STATE.yaml` is a frozen v10 snapshot (last entry `TASK-20261109-043`, which holds the most recent detailed results and limits
of the work console). Use it as history; do **not** update it. Keep the two single records `hazards` and `smoke_status` in the
knowledge-DB (`update_memory` in place, never duplicated); neither existed when searched on 2026-11-09, so create each once.

## Commands

There is **no Node.js on the VPS**. Run Node through the rootless docker (as `coder`, plain `docker`):

```bash
# All tests (the 41 files listed in package.json; must pass before smoke_status is recorded green). Node 20 or 22.11; NOT 22.23.4 (docs/LESSONS.md L2).
# (MASTER_GUIDANCE still says "7 files": the file list in package.json is the truth.)
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

Action layer benchmark (docs/implemented/SKILLS-v1.md), against the same server:

```bash
(cd docker/rl-server && docker compose --profile env run --rm -T --entrypoint node rl-env scripts/skills/bench.js --run-id b1 --seed 1 --reps 10 [--clutter 1] [--control noop] [--trials 12,40])
python3 scripts/skills/report.py exchange/b1 [exchange/b2 ...]    # per-command rates with Wilson 95 % intervals, failures
python3 scripts/skills/report.py exchange/b1 --trace 12            # one trial's timeline: phases, keys, position
```

Build world (docs/implemented/WORLD-v1.md): persistent modded server the owner joins over the tailnet (`100.77.246.23:25565`
-> `127.0.0.1:25567`), snapshots in `/mnt/data/forgeaip/snapshots`. Mods: vanilla + Create + optimisation only, pinned in
`modpack/forgeaip-create.lock.json` (docs/implemented/MODPACK-v1.md); `up.sh` syncs them to `/mnt/data/forgeaip/mods`:

```bash
scripts/world/up.sh | down.sh | restart.sh            # build world (restart after copying mods)
scripts/world/snapshot.sh <label> | --list             # also hourly (user timer) and before stop/restart/restore
scripts/world/test-up.sh <label|latest> ; test-down.sh # disposable tmpfs copy on 127.0.0.1:25568 for bots/benchmarks
scripts/world/restore.sh <label|latest>                # roll the build world back
scripts/world/reset.sh [--seed N] [--type normal|flat] # new world (default random natural seed), old one snapshotted
scripts/world/bot-up.sh | bot-down.sh                  # the LLM bot (vault record ollama/forgeaip), WebUI 127.0.0.1:3020
scripts/world/registry-dump.sh                         # after any lock change: rebuild + commit modpack/forgeaip-create.registry.json
(cd docker/world-server && docker compose --profile check run --rm intent-check)   # live LLM-path check on a test copy
(cd docker/world-server && docker compose --profile bench run --rm -T --entrypoint node bench scripts/skills/bench_lv2.js --run-id l1 --seed 1101 --bots 10 --follow <player>)   # LV2: natural terrain (after --pregen 1)
```

Learned walk and pit expert (docs/implemented/MOVE-v3.md, docs/implemented/PIT-EXPERT-v1.md; `rl3/`, Python/JAX, trained on the owner's PC GPU, polite: nice 10, GPU cap 35 %, pause file `C:\forgeaip\rl3\PAUSE`):

```bash
scripts/rl3-py.sh -m unittest rl3.tests.test_sim                  # simulator rules on the VPS CPU (moe-py image, no network)
scripts/rl3/pc.sh install ; scripts/rl3/pc.sh run NAME train --out /out/NAME --envs 1024 --updates 500 [--noise 2.0 --init /out/OLD/best.npz]   # movement policy
scripts/rl3/pc.sh run NAME pit-train --out /out/NAME --envs 1024 --updates 500 ; scripts/rl3/pc.sh status | tail NAME | pull NAME | stop NAME
scripts/rl3-py.sh -m rl3.cli export --params /out/NAME/best.npz --out /out/NAME/move3.json   # then copy to models/experts/move3.json (pit: pit-export -> models/experts/pit.json)
scripts/rl3-py.sh -m rl3.cli golden | pit-golden | scenarios --out /out/scn_a.json           # contract files of the JS ports (tests/golden_*.json) and the live worlds
scripts/work/live-demo.sh move3_live.js MODE=move3|legacy N=4 [PERTURB=1 TEMP=0.4] LIVE_OUT=/out/x.json   # live harness on the demo server, ONE client at a time (parallel runs overload it)
scripts/work/live-demo.sh pit_live.js --run-id pe1 --method expert|sweep --bots 2 --w 32 --d 16 --depth 4 --root /out --base-x 4000 --base-z 4000
```

Never stop test containers by image or ancestor filter (the production console shares the node image): name them (`live-demo.sh` does) and `docker kill <name>`.

Experts and router (docs/proposed/MOE-v1.md and MOE-v2.md, diagram docs/diagrams/moe-v2-architecture.svg; `moe/`, Python, runs in the `moe-py:1` image with the `moe-venv` volume, no network; v1 files in `/mnt/data/forgeaip/moe`, v2 in `/mnt/data/forgeaip/moe2` (`MOE_ROOT`)):

```bash
scripts/moe/test.sh                          # 16 unit tests
scripts/moe/train-all.sh [--par 3]           # train + evaluate the 12 experts on simulator shards (held-out worlds vps-s3/s4), controls: baseline.sh
scripts/moe/router.sh ; scripts/moe/chain.sh chain-placed xgb net 60   # XGBoost/LightGBM router; router + experts as one policy
```

MoE v2 on the owner's PC (only with the owner's permission, schedule hold; WSL2, no docker, runs at nice 10; docs/proposed/MOE-v2.md):

```bash
scripts/moe/pc.sh probe | install | status | peek TAG | report TAG | pull TAG | stop [NAME]   # install = simulator binary + moe package + scenarios -> ~/moe in WSL
scripts/moe/pc.sh run NAME train --tag TAG [--experts a,b] [--par 8] [--only-scenario S]     # train + held-out eval + controls per expert (scripts/moe/pc/jobs.py)
scripts/moe/pc.sh run NAME assemble --into TAG --sources p1,p2 ; run NAME router --tag TAG ; run NAME chain --tag TAG --scenario chain-placed --router rules|xgb --experts net|solver [--greedy-stall]
```

Pure bots (docs/proposed/WORKERS-v1.md; `src/work/`, map in src/work/README.md, not part of the RL action space): live pit check on a disposable server. The owner's play world
is NOT in this repo: compose, scripts and jars are all in `/mnt/data/forgeaip-play/` (own folder and local git repo, see its README.md):

```bash
scripts/world/test-up.sh latest ; (cd docker/world-server && docker compose --profile bench run --rm -T -e MC_HOST=world-test -e RCON_HOST=world-test --entrypoint node bench scripts/work/pit_live.js --run-id p1 --bots 4 --kill 1) ; scripts/world/test-down.sh
/mnt/data/forgeaip-play/up.sh | down.sh [--purge] | check-mods.py   # second Forge server on 127.0.0.1:25569 (tailnet 25566)
/mnt/data/forgeaip-play/registry.sh                                 # after any change of its mods/: exact block table for the bots (registry.json)
/mnt/data/forgeaip-play/console-up.sh | console-down.sh             # the work console (web UI for pure bots: bots, pits, structure editor, builds), 127.0.0.1:3020, tailnet 3021
```

The work console (`src/work/web/`, `src/work/service/`, `public/work/`, docs/implemented/WORK-CONSOLE-v1.md; file map `src/work/README.md`) has no access token since 2026-11-10 (the network, i.e. loopback and the tailnet, or Cloudflare Access decides; a request with proxy headers and no valid Access assertion is refused; `WORK_REQUIRE_TOKEN=1` brings the token back),
reaches RCON, and is NOT the old WebUI: keep its session, CSRF, Host/Origin checks, the proxy-header refusal and closed validation when changing it. Bots there use the
play world's own table (`BOT_MOD_TABLE`). `aux_console/` (mod `aipconsole`: F12 web view of the console, Tag Tool item; build command in its README) is
installed on the play server and the owner's PC; `aux_mod/` is an older, unused project.

On the owner's PC (Windows/WSL2): `npm ci`, `npm test`, `npm run test:e2e`, `node index.js` (or `run.bat` / `./run.sh`).
Running the bot needs a Forge 1.20.1 server and an Ollama-compatible endpoint, which exist only on the owner's PC.

## Environment

LLM credentials: the vault record `ollama/forgeaip` first (value = key, fields `url`, `model`; read with the git-ignored
`config/vault-llm.conf`, see docs/implemented/WORLD-v1.md), `.env` as the fallback.

Copy `.env` values (file is git-ignored; never print or commit it):
- `OLLAMA_URL` full endpoint (e.g. `http://172.24.96.1:11434/api/generate`). In WSL2 `localhost` is the Linux VM, use the Windows gateway IP.
- `OLLAMA_MODEL` default `gpt-oss:20b-cloud`; `OLLAMA_API_KEY` bearer token; `OLLAMA_AUTH_SCHEME` default `Bearer` (empty = send key bare).
- Others: `docs/references/variable_map.md`.

## Repository layout

```
index.js            entry: AgentManager + WebUI (the debug WebSocket :3001 is started by each legacy bot_actuator child)
rl3/                RL-MOVE-v3 and pit expert trainer (JAX): simulator, PPO, export; runs on the PC GPU (docs/implemented/MOVE-v3.md, PIT-EXPERT-v1.md)
moe/                experts (one small PPO policy per item), rule planner, XGBoost/LightGBM router, chain; tools/sim is its environment (docs/proposed/MOE-v1.md)
src/work/           pure bots, ~13 role folders (jobs, bot, service, web, operator, world, display): map and "where do I change X" in src/work/README.md; calls execute() only
src/skills/         the action layer: 14 commands built only from player inputs (body, planner, runner, commands/*), intents.js + llm_prompt.js for the LLM
src/stack/           the router of the command stack (docs/implemented/COMMAND-STACK-v1.md): precondition failures + state -> the chain (unstick, move, equip ...); the only place that knows a remedy
src/experts/move3/ + src/experts/pit/   the learned cell-level walk (env.travel, setting move3) and the pit's station scoring network (pit method expert, setting pitExpert); models in models/experts/
src/skills_bot.js   the bot child process on the action layer (default; BOT_RUNTIME=legacy forks bot_actuator.js); src/vault_client.js reads LLM credentials
src/rl/             RL environment (env, controls, observation, goal, DPOD file-API runner); src/transport/ = login/FML3 factory shared with the actuator, mod_registry.js = exact mod blocks/items
modpack/            the mod set: lock (sha512), pack.py (server sync, .mrpack), install-client.ps1, the bot's block/item table
tools/registry-dump/  server-only Forge mod (Java) that writes that table on a disposable server
src/                runtime (agent_manager, bot_actuator + actuator/*, forge_handshake_state_machine, dynamic_registry_injector, middleware, llm_client, web_ui_server)
tests/              the files run by `npm test` (list: package.json) (+ mocks, run_tests.js, smoke.js)
public/             WebUI (static)
aux_console/        Forge 1.20.1 mod `aipconsole` (Java/Gradle): F12 web view of the work console, Tag Tool; aux_mod/ = older unused companion mod
tools/              registry-dump (Java), sim (Rust simulator), tblog (training log -> TensorBoard), site-finder, tickrate, train-dash
docker/             compose for a CUDA dev box, the full stack (forge-server), the RL server (rl-server) and the build world (world-server)
data/               system_presets.json + junk_list.json (tracked); data/sample/configs (mod dictionary); everything else here is runtime state and ignored
scripts/            tooling; scripts/adhoc = old probes, not tests
docs/               core/ (MASTER_GUIDANCE rules, GOAL; STATE.yaml frozen), ARCHITECTURE, LESSONS, guides, references, proposed, implemented, archive
```

## Architecture

The system connects a Mineflayer bot to a Minecraft 1.20.1 Forge server, bridging the incompatible FML3 protocol, and drives the bot using an LLM via a parent-process orchestrator. Full spec: `docs/ARCHITECTURE.md` (the code wins on conflict).

### Process Model

`index.js` → `AgentManager` (parent) → `skills_bot.js` (child via `fork()`; `bot_actuator.js` when `BOT_RUNTIME=legacy`), same IPC either way:
- Parent→Child: `EXECUTE_ACTION` (array of action objects)
- Child→Parent: `USER_CHAT`, `ERROR`, `STATUS`

The pure bots in `src/work/` are a separate process (`src/work/console.js`, started by the play world's `console-up.sh`), not forked by `AgentManager`.
Direction (GOAL.md, MASTER_GUIDANCE `<constraints>`): the LLM is being confined to instruction-to-goal translation and the RL policy picks actions;
do not add LLM calls to a per-tick path. Today's `AgentManager` still plans with the LLM; that is the thing to move, not to extend.

`AgentManager` queues chat, enforces a 5 s LLM cooldown, and tracks in-flight LLM calls per bot (`activeLlmRequests`, keyed by botId). On a new `EXECUTE_ACTION` the legacy actuator sets `currentCancelToken.cancelled = true`, drains the queue, then awaits `isExecuting` before assigning a new token (prevents races).

### Forge Protocol Bridge (`src/forge_handshake_state_machine.js`)

Intercepts `login_plugin_request` and acts as a transparent proxy; `fml:loginwrapper` wraps `fml:handshake`. Disc 1 → mod list reply; 3 → buffer registry sync; 4 → Ack; 6 → complete. Emits `handshake_complete` with the buffered registry payload. The trigger is the host suffix `\0FML3\0` (breaks on Node 22.23.4, BUGFIX-20261030-002).

### Modded Block Registry (`src/transport/mod_registry.js`; old: `src/dynamic_registry_injector.js`)

Since TASK-20261031-020 the action layer and the RL env install mod blocks and items exactly: block/item ids decoded from the
handshake's registry sync, state counts, properties and collision boxes from `modpack/forgeaip-create.registry.json`
(`attachForgeHandshake(bot, {registry: 'auto'})`; vanilla Forge servers are left alone). Vanilla state ids are unchanged on
Forge; mod states follow in block-id order. The old heuristic below is kept only for the legacy actuator: it loads `data/sample/configs/mod_blocks_dictionary.json`, parses `namespace:blockname` from handshake buffers, deep-copies vanilla templates for mod blocks, and installs a Proxy on `registry.blocksByStateId` that resolves unknown IDs by binary search to the parent block (no pathfinder crashes).

### Action layer (`src/skills/`, TASK-20261031-016)

Every command is a sequence of per-tick input frames (movement keys, look, hotbar, attack/use, Q/F) applied by one `Body`;
`runner.js` runs it on the live clock with a tick budget and a per-tick trace and ends it with `ok` or a reason from a closed
taxonomy (`REASONS`). Success is the change the server sends back, never the bot's own prediction. `execute(bot, name, args)` in
`src/skills/index.js` is the entry point. Spec, command reference and measured success rates: `docs/implemented/SKILLS-v1.md`.

### Command stack (owner's architecture, 2026-11-12, `docs/implemented/COMMAND-STACK-v1.md`, binding)

operator / Pit / Build -> **router** (`src/stack/router.js`, rule-based) -> experts -> **atomic instructions** (`execute(..., {atomic: true})`, `src/skills/preconditions.js`) -> body -> mineflayer.
An instruction checks its own preconditions (each decidable from the state alone: `mine` = in reach and the right tool in hand), halts with `precondition_failed` and the measured value, and never walks,
equips or names a remedy; an expert refuses only for its own preconditions; only the router knows the remedy and decides from the whole state (far + stuck -> unstick, move, equip, mine). Rules for changes:
the top (console commands, `gather`, and jobs once `stackJobs` is on) goes through `env.command`, not `execute`; a new instruction gets its preconditions in `preconditions.js` and a rule in `router.decide`;
no robustness inside an instruction (no hidden approach, retry or tool swap): that is how the 2026-11-12 failures came about. `rawCommands` is for debugging only.

### Bot Actuator (`src/bot_actuator.js`, ~6.7k lines, plus `src/actuator/{ctx,environment,flight,tools,utils}.js`)

The old LLM-driven action path, kept as the rollback (`BOT_RUNTIME=legacy`). Since TASK-20261031-017 AgentManager forks
`src/skills_bot.js` instead: same IPC contract, intents from `src/skills/intents.js`, no background loops.

Initialises Mineflayer with pathfinder, collectblock, DynamicRegistryInjector and middleware.
- **Chat dedup**: 3 s window (`_chatDedup`) against Forge's double `player_chat` + `system_chat`.
- **`ensureToolFor(block)`**: skips fluid/air; crafts tools only for diggable solids.
- **`withTimeout(ms, promise)`** wraps every async action; per-block collect cap `Math.min(timeoutMs, 20000)`.
- **Pathfinder limits**: `thinkTimeout = 5000`, `tickTimeout = 5` (prevents heap exhaustion on mod terrain).
- **Actions**: come, goto, collect, give, place, craft, equip, eat, smelt, kill, sleep, brew, enchant, explore, navigate_portal, activate_end_portal, place_pattern, status, stop. The mapping from these to the 14 action-layer commands is in `docs/implemented/SKILLS-v1.md` (the old README action table is gone).

### LLM client, middleware

`src/llm_client.js`: Ollama / OpenAI-chat / OpenAI-completions via `extractText()`; returns `null` on any error (caller must check); API key stripped of BOM/control characters. Middleware: `event_debouncer.js` (500 ms VeinMiner debounce), `inventory_nbt_patch.js` (stackSize → INT_MAX, true count from `StorageCount`), `create_contraption_hazard.js` (Create contraption AABBs non-walkable).

## Task and docs workflow

- Task state: the knowledge-DB (schedule for status, one memory record per task; see MASTER_GUIDANCE `<task_tracking>`); specs in `docs/proposed/` → `docs/implemented/`; history before 2026-10-30 in `docs/archive/`.
- After a code change: run the task's `validation_commands`, record each completed change as a memory entry tagged with its task id, and update `smoke_status` with the real last `npm test` date and result. Not `STATE.yaml`.
- A job that runs more than a few minutes (server, training, soak test, build) is registered on the schedule first (`schedule_add`), restart-safe (MASTER_GUIDANCE `<mcp>`).
- Docs are indexed into the knowledge-DB after each push: keep them accurate, give each doc a specific first heading and a one-sentence opening (`docs/README.md`).
- Commit format `TASK:<task-id> <type>: <description>`. Commit in coherent units, push each; `main` equals `origin/main` when finished.
- Docs-only tasks do not modify `src/` or `tests/`.
- Before changing a symbol run scip-neo4j `analyze_change_impact` / `get_symbol_dependencies` / `check_symbol_constraints` with `repo=https://github.com/I-yuki-0424/forge1201-MODED-AIPlayer`; use `get_index_status` to confirm the index is active, else read the code.
- Do not track `node_modules`, build output, logs, runtime `data/*.json`, JDKs. Git LFS: archives only (`docs/LESSONS.md` L1).
- Security: WebUI/debug WS are unauthenticated and must stay on loopback (L3). Dependency advisories: `TASK-20261030-004`.
