# RL interface v1: environment, action space, goals, reward, server

First implemented slice of `TASK-20261030-013` (interface), `-007` (server), `-008` (goal contract), `-006` (event log) and `-009` (transport layer), 2026-10-30. It is the BOTSYSTEM side of the DPOD file API (`Decision-Process-order-driven/integrations/botsystem/PROTOCOL.md`, commit 6adee25): BOTSYSTEM is the environment, DPOD is the policy and learner. No LLM is involved; goals are fed directly.

Verified on the live Forge 1.20.1 server of this VPS with `scripts/rl/verify_game_side.py`: 20 of 20 checks pass, each graded against the server's own state (RCON `data get entity`, `clear … 0`), not against what the bot reports. What is not done is listed at the end.

## Parts

| Part | File | Role |
| :-- | :-- | :-- |
| Transport | `src/transport/forge_bot.js` | login with the FML3 marker, protocol bypasses, chat hardening, optional registry injection. Extracted from `bot_actuator.js`, which now calls it |
| Action space | `src/rl/action_spec.js` | data-defined spec (`full`, `min`), validation, per-tick key schedule, hash |
| Controls | `src/rl/controls.js` | applies one action to the bot, tick by tick |
| Goal | `src/rl/goal.js` | goal schema v1, encoding, reward, termination |
| Observation | `src/rl/observation.js` | declared fields, built only from client-side state |
| Environment | `src/rl/env.js` | `reset(goal)` / `step(action)`, RCON reset, paused-physics clock |
| Runner | `src/rl/run_env.js` | DPOD file API loop over two JSON-lines files |
| Event log | `src/rl/events.js` | structured, correlated events (`events.jsonl` per run) |
| Server | `docker/rl-server/compose.yaml`, `scripts/rl/up.sh`, `down.sh` | Forge 1.20.1, pinned, tmpfs world, loopback only |
| Verification | `scripts/rl/verify_game_side.py` | scripted scenarios + server-side grading, driven through DPOD's `PolicyServer` |

## Decision: the policy acts at control level

The roadmap asked for a choice between a skill-level action space (walk-to, mine, craft over `EXECUTE_ACTION`) and raw controls. v1 uses raw controls, in the form DPOD already proposed (keys `off`/`tap`/`hold`, yaw/pitch deltas, hotbar select), for these reasons:

- It is the only level with a counterpart today: DPOD's interface, `UniformRandomPolicy` and tests already speak it, and the 20 checks above exercise every component.
- Skills need the single-role skill layer of task 009, which does not exist yet (`bot_actuator.js` is still 6.7k lines of LLM-planned actions). Building a skill API first would repeat the entanglement 009 removes.
- It keeps the policy's input honest: a skill such as "mine this block" hides pathfinding and aiming that a learner would otherwise have to discover, which is a form of hand-specified knowledge under DPOD's rules.

The cost is sample efficiency: from raw controls, goals that need long chains (craft a pickaxe) are out of reach of any budget this project has. v1 goals are therefore short-horizon (`reach`, `collect` one block) and skills are the next layer: a skill component can be added to the same spec as a `select` without changing the protocol. Both statements are reasoning, not measured.

## Action space (`hello.action_spec`)

`full` = 9 keys (`forward back left right jump sprint sneak attack use`, modes `off|tap|hold`), `yaw_delta_deg ∈ {-45,-15,0,15,45}`, `pitch_delta_deg ∈ {-15,0,15}`, `hotbar ∈ 0..9`, rules: `forward`/`back` and `left`/`right` exclusive, `sprint` requires `forward` and excludes `sneak`. `min` = `forward jump sprint attack` + `yaw_delta_deg ∈ {-30,0,30}`. `ticks_per_step` = 4 (placeholder; 4 ticks = 0.2 s of game time).

The spec hash equals DPOD's for both (`f085fbad…` and `a2f361b9…`, pinned as vectors in `tests/test_rl_env_pure.js`); the runner refuses a `hello_ack` whose hash differs.

Conventions DPOD's text left open, now fixed (all measured against the server):

- `yaw_delta_deg > 0` turns **right**, `pitch_delta_deg > 0` looks **down** (F3-screen signs; Mineflayer's are opposite). Pitch clamps at ±90°.
- `tap` = key down on tick 0 of the step only; `hold` = every tick of the step. Nothing carries between steps. `attack hold` over several steps keeps digging the same block.
- `hotbar` 0 leaves the slot unchanged; `n` selects slot index `n-1`.
- `attack` digs the block under the crosshair within 4.5 blocks, counted in ticks (not Mineflayer's wall-clock timer), or hits an entity within 3 blocks (cooldown 10 ticks; entity attack is **untested**: the world has no mobs). `use` places the held block on the face under the crosshair, otherwise activates the held item (`use` on an item is **untested**).
- Not yet in the space: inventory GUI, drop, swap hand, crafting windows.

## Observation (`hello.obs_spec`, 13 fields)

`pos[3] vel[3] look[4]=sin/cos(yaw,pitch) on_ground health food held_slot inventory[16] grid[324] cursor_block cursor_dist entities[16] goal[22] step_frac`.

- `grid` = block categories of a 9×4×9 box around the feet (world-aligned): `air soil stone log leaves planks liquid ore sand other_solid unloaded`. Unnamed (modded) blocks fall back on their collision shape.
- `inventory` = counts of 16 listed items; `entities` = the 4 nearest within 8 blocks as `[kind, dx, dy, dz]` (kind 1 item, 2 mob, 3 player, 4 other).
- `goal` = one-hot type, relative target vector (/16, clipped) for `reach`, item one-hot and count for `collect`.

Every field comes from state the client holds (own state, loaded chunks, entity list, inventory, crosshair ray). DPOD refuses an undeclared field, so adding one means changing `obsSpec()`.

## Goals (schema v1, fed directly)

```json
{"v":1,"type":"reach","offset":[dx,dz],"tolerance":1.0,"max_steps":150}
{"v":1,"type":"collect","item":"oak_log","count":1,"max_steps":150}
```

`validateGoal` refuses unknown types, items outside the closed list of 16, unknown fields, out-of-range numbers, NaN. `reach` target = episode start + offset; `collect` count ≤ 8 (the reset places one log per item). This is the contract the LLM front-end of task 008 must emit; the LLM part itself is not built.

## Reward and termination

`reward = task + shaping`, both sent in `reward_terms`. `task` = +1 on the success predicate (reach: horizontal distance ≤ tolerance and |Δy| ≤ 1.5; collect: inventory count ≥ count), −1 on death, else 0. `shaping` (reach only) = (d_prev − d_now)/10, a potential difference, so its sum over an episode is exactly (d_0 − d_N)/10 (checked: 0.6797 vs 0.6797). `terminated` = success or death; `truncated` = `max_steps` reached. Collect has no shaping (sparse).

## Clock and reset

- Mineflayer's physics is paused between steps (`physicsEnabled=false`); a step enables it for exactly `ticks_per_step` physics ticks. The policy may take any time to answer. The server keeps running in real time, so effects that need server ticks (an item being picked up) can land in the next step, not the one that caused them. After each step the env waits `settle_ms` (25) of wall time for the replies; this is a source of non-determinism and is logged.
- `reset` runs over RCON, not through the bot (the bot never has operator rights): gamemode, `clear`, `effect clear`, teleport to a fixed origin with one of 8 headings drawn from the seeded generator, rebuild a 25×25 arena (air above, dirt/grass below), remove dropped items, heal, build the collect row. It then waits until the client has seen every change (teleport, empty inventory, health, blocks) and runs 3 settle ticks. A sync that does not complete in 8 s raises `ResetError`.
- `--gap-ms N` waits after each terminal observation before the next reset, so an external grader can read the server state.

## Server (task 007, first slice)

`docker/rl-server/compose.yaml`: `itzg/minecraft-server` pinned by digest, Forge 1.20.1-47.4.10, flat world with fixed seed, peaceful, no mobs, daylight fixed, view distance 4 / simulation distance 3, `online-mode=false`, world on tmpfs (nothing persists), `mem_limit 3g`, `cpus 3`, only `127.0.0.1:25566` published, RCON reachable inside the compose network only (password generated into the git-ignored `docker/rl-server/.env`). `scripts/rl/up.sh` starts it; `down.sh` removes everything. The first start downloads and installs Forge (about 1 minute).

Profile `RL_PROFILE=vanilla` (default) does not inject registry data. Reason, measured: on a server without content mods the `DynamicRegistryInjector` still "injected 28 MOD blocks" and the client named dirt `forge:modid4`, so the inventory observation lost the item (`BUGFIX-20261030-015`). `modded` keeps the old injection.

Measured 2026-10-30 (random policy, `full` spec, 4 episodes, 600 steps, one bot):

| Quantity | Value |
| :-- | :-- |
| Server TPS / mean tick time | 20.0 / 1.9 ms (4 % of the 50 ms budget) |
| Step time (4 ticks) | mean 189 ms, median 185, p95 226 |
| Throughput | 4.84 steps/s = 19.4 ticks/s per environment |
| Policy round trip (Python, random) | mean 14 ms, max 26 ms |
| Reset | 166–199 ms |
| Memory | server 2.28 GiB (cap 3 GiB), env process 58 MiB |

Reading: the pipeline runs at the real-time limit of 20 TPS and the server itself has about 25× headroom in tick time. At 4.84 steps/s one environment needs about 57 hours per million steps, so training needs either several bots per server or a faster tick. Neither is built: options to test are (a) several bots in separate arenas on one server (needs a per-env origin; `clear @e[type=item]` in the reset is global today), (b) a tick-rate mod through `aux_mod` plus scaling Mineflayer's 50 ms physics clock, (c) action repeat (`ticks_per_step`). Whether stock Forge 1.20.1 has a tick-rate command is still *unverified*.

## Review against DPOD's rules

- **Leakage / oracle:** the observation has no server-only field; the goal vector is the task statement, not hidden state. The reward uses the same client-side state as the observation (position, inventory), so no counterfactual or simulator access. The scripted policies in `verify_game_side.py` read only declared observation fields and exist to test the environment; they are not learners and no result here counts toward a DPOD gate.
- **Scenario regularity:** the collect log row is always 3 blocks ahead of the initial heading, so a learner could exploit that. Distance and angle must be randomised before any generalisation claim.
- **Evaluation protocol (task 013 item 5), not yet exercised:** pre-registered metric, evaluation seeds disjoint from training/tuning seeds, ≥ 5 seeds per claim, positive control before a null result. The seeded generator (`--seed`, per-episode `mulberry32`) supports it; nothing has been trained.

## Run

```bash
scripts/rl/up.sh                                        # server (waits until healthy)
python3 scripts/rl/verify_game_side.py                  # 20 checks, needs ../Decision-Process-order-driven (DPOD_DIR to override)
# a policy of your own, e.g. DPOD's random one:
(cd ../Decision-Process-order-driven && python3 -m integrations.botsystem --root $OLDPWD/exchange --run-id r1 --policy random --expect-spec full)
(cd docker/rl-server && docker compose --profile env run --rm -T rl-env --run-id r1 --spec full --episodes 4 --sample reach --seed 1)
scripts/rl/down.sh
docker run --rm --network none -v "$PWD":/w -w /w node:20-slim npm test    # pure tests incl. tests/test_rl_env_pure.js
```

Run data (`exchange/<run_id>/`, git-ignored): `env_to_policy.jsonl`, `policy_to_env.jsonl`, `events.jsonl` (schema 1: `run_start connected reset step step_timing episode_end run_end` plus `kicked bot_error bot_end invalid_act`), `verification.json`.

## Not done

- **A learner.** Whether DPOD's Transformer+MDP model is the policy is still the owner's decision (task 013). DPOD notes its 2.9 million-combination `full` space rules out a flat softmax: it needs factored heads, or `min`.
- **Speed:** parallel bots, tick acceleration, the modded profile, a soak test (task 007). **Skill layer** (009). **Rust query tooling and detectors** for the event log (006). **The LLM front-end** (008, 011).
- **Randomised scenarios**, entity attack and item `use` tests, other goal types.
- **HTTP transport** (DPOD names it as not written): the file channel is single-machine.
