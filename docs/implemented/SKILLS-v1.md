# Action layer v1: 14 commands built only from player inputs

`TASK-20261031-016` (2026-10-31). The bot's action mechanism, rebuilt from the bottom: every command is a sequence of
per-tick input frames, the same inputs a person has (movement keys, mouse look, the two mouse buttons, hotbar keys, Q
and F, window clicks), each run on the live game clock, ended by a success the **server** confirmed or by a named reason
from a closed list, and traced tick by tick. It replaces nothing in the LLM path yet (see "Old actions"); it is the layer
an RL policy, a planner or the LLM front-end composes. Measured success rates are at the end.

## Why a rebuild

`src/bot_actuator.js` (6.6k lines) grew one special case at a time: `goto` alone is about 670 lines (waypoint lookup,
`/locate`, boat switching, jetpack promotion, cross-dimension routing); actions call each other through the queue;
success is mostly self-reported. Faults could not be localised, which is why fixes kept missing. The game itself offers
very little: forward/back/left/right, jump, sprint, sneak, look, left and right click, hotbar keys, Q, F, and clicks in a
screen. v1 takes that literally.

## Layers

| Part | File | Role |
| :-- | :-- | :-- |
| Body | `src/skills/body.js` | The only place input becomes packets. Applies one **frame** per tick: `forward back left right jump sprint sneak attack use` (held = true), `yaw pitch` (absolute), `hotbar` (0-8), `drop` (`one`/`stack`, the Q key), `swap` (F). Attack = tick-counted digging of the block under the crosshair, or a hit on the entity under it (press edge only, as vanilla). Use = use-item-on-block / use-item, decided like the vanilla client. |
| Geometry | `src/skills/geometry.js` | Pure: look angles, view rays, voxel ray cast through block shapes, visible aim points on a block, reach constants (4.5 blocks, 3 for entities). |
| World | `src/skills/world.js` | Read-only cell model: `air solid partial liquid danger unknown`, ray-hittable shapes (outline boxes for levers, buttons, torches, open gates). |
| Planner | `src/skills/planner.js` | Pure A* over standing cells: walk (8 directions, no corner clipping), step up 1, drop 1-3. No digging, placing, swimming or parkour. Node budget 20,000; partial paths when the goal is not found. |
| Motion | `src/skills/motion.js` | Path following from frames (yaw steering, look-ahead on straight stretches, jump on step-ups, sprint on long straight runs, stuck detection and up to 5 replans), approach-a-block goals, aiming the crosshair. |
| Runner | `src/skills/runner.js` | `ctx.tick(frame)` = apply a frame, wait for the physics tick that uses it. Tick budget per command, cancel token, death and disconnect detection, per-tick trace, phases, closed failure taxonomy. Never throws: every outcome is `{ok, reason, detail}`. |
| Commands | `src/skills/commands/{block,entity,item,gui}.js` | The 14 commands. |
| Registry | `src/skills/index.js` | Closed argument schemas, tick budgets, `execute(bot, name, args, {maxTicks, cancel, onEvent})`. |

Rule: a command advances the game only through `ctx.tick`. Window contents (crafting grid, furnace, chest) are moved
with Mineflayer's click helpers (`bot.craft`, `openFurnace`, `openContainer`), which are sequences of window clicks; the
command first walks to the block and puts the crosshair on it like any other block command.

Things the client must predict itself, as the vanilla client does (measured): after Q or F the server changes the
inventory but sends no slot update, so the body updates its copy; while a container or furnace is open, Mineflayer keeps
the player's items in the window's own slots and `bot.inventory` catches up only on close, so commands count inside the
window. Mineflayer rounds every look change to 0.15° (one vanilla mouse-sensitivity step), and the bot stops anywhere in a
cell while reach goals are judged from its centre: commands therefore settle near the centre, aim only at points 0.3
blocks inside the 4.5-block reach, and re-approach once from another cell before reporting `not_visible`. A mob in front
of a block takes the click (also while it plays its 20-tick death animation): aim points an entity blocks count as not
visible, and an entity in the crosshair is waited out for up to 10 ticks.

## Commands

All coordinates are block cells (integers). "Success" is what the command waits for before it returns `ok`.

| Command | Arguments | Does | Success | Typical failure reasons |
| :-- | :-- | :-- | :-- | :-- |
| `move_to` | `x y z` | walk until the feet are in that cell | feet cell = target, speed settled | `invalid_target` (cannot stand there), `unreachable`, `stuck` |
| `look_at` | `x y z` or `entity` | turn so the crosshair rests on the block (up to 64 blocks) or the entity; no walking | own ray cast hits the target | `not_visible`, `invalid_target` |
| `mine` | `x y z` | walk into reach, pick the fastest tool that harvests it, hold attack, then collect the drop | server turns the block into something else and the drop is in the inventory | `missing_tool`, `unreachable`, `not_visible`, `not_confirmed` |
| `place` | `x y z item` | walk to a cell that sees a face of a solid neighbour, hold the item, clear the target cell, click that face (sneaking if the neighbour is interactive) | server shows the block in the cell | `missing_item`, `invalid_target` (occupied, no support), `not_confirmed` |
| `activate` | `x y z item? sneak?` | right-click an interactive block (lever, door, trapdoor, gate, ...), optionally holding a tool (`create:wrench`) and sneaking; with a tool any block | the block state changed, or a screen opened | `invalid_target`, `not_confirmed` |
| `pickup` | `entity` or `item` | walk onto a dropped item (nearest stack of `item`) | inventory count rose | `invalid_target`, `target_lost`, `stuck` |
| `attack` | `entity` | equip the best melee weapon, chase, swing when the weapon is recharged and the crosshair is on the target | the server reports the entity's death | `invalid_target`, `target_lost`, `timeout` |
| `equip` | `item`, `dest` = `hand off_hand head chest legs feet` | hotbar key, number-key swap into the hotbar, F for the off hand, shift-click or swap clicks for armour | the item is in that slot | `missing_item`, `invalid_args` (does not fit) |
| `eat` | `item?` | hold the food, hold use | item count fell and food rose | `invalid_target` (not hungry), `missing_item` |
| `toss` | `item count` | hold the stack, Q / Ctrl+Q until `count` are gone | inventory count fell by `count` | `missing_item` |
| `craft` | `item count? x? y? z?` | 2x2 grid when the recipe fits, else the nearest crafting table within 16 blocks | at least `count` more of `item` | `missing_materials`, `no_station`, `invalid_args` (no recipe) |
| `smelt` | `item count? x? y? z?` | nearest furnace / smoker / blast furnace, fuel from the inventory (not the input), wait, take the output | output in the inventory | `missing_item`, `missing_materials` (fuel), `no_station` |
| `deposit` | `item count x y z` | open the chest or barrel there, move `count` in | the container holds `count` more | `missing_item`, `invalid_target` |
| `withdraw` | `item count x y z` | open it, take `count` out | `count` more in the inventory | `missing_item` (container), `invalid_target` |

### Failure taxonomy (closed, `REASONS` in `runner.js`)

`invalid_args`, `invalid_target`, `missing_item`, `missing_tool`, `missing_materials`, `no_station`, `unreachable`,
`stuck`, `not_visible`, `not_confirmed`, `target_lost`, `timeout`, `died`, `disconnected`, `cancelled`, `internal`.
`internal` means a bug: the detail holds the stack. A `SkillError` with any other reason cannot be constructed.

### Debugging

Every result carries `phases` (named steps with their tick and data, e.g. `plan`, `walk`, `replan{why}`, `dig{ticks}`,
`collect_drop`) and `trace`, one row per tick: `[t, phase, keys, x, y, z, vx, vy, vz, yaw, pitch, onGround, hotbar]`,
keys as a 9-letter mask `FBLRJSNAU` (forward back left right jump sprint sneak attack use; `Q` drop, `X` swap appended).
`scripts/skills/report.py <run> --trace <n>` prints a trial as a timeline of phase and key changes. With the server's
verdict next to the bot's, a disagreement (bot `ok`, server not, or the reverse) is itself a finding: in the measured
runs below there were none.

## Old actions

| Old `bot_actuator.js` action | v1 |
| :-- | :-- |
| `goto`, `come` | `move_to` (the caller resolves waypoints, structure names and player positions to a cell; long distances are walked by replanning partial paths) |
| `collect` | `mine` (+ `pickup`), repeated by the caller |
| `craft`, `place`, `equip`, `equip_armor`, `eat`, `smelt`, `kill` | `craft`, `place`, `equip`, `equip{dest}`, `eat`, `smelt`, `attack` |
| `withdraw_from_container`, `loot_chest_special`, `deposit_to_container`, `store_in_container`, `transfer_between_containers` | `withdraw`, `deposit` (transfer = both) |
| `give` | `look_at` the player + `toss` |
| `activate_block`, `sleep`, `set_respawn` | `activate` (beds are interactive blocks; not benchmarked) |
| `place_pattern` | `place`, repeated |
| `find_and_equip` | `equip` (finding is the caller's job) |
| `wait`, `stop` | idle frames; the cancel token |
| `boat`, `fly`, `navigate_portal`, `activate_end_portal`, `explore`, `find_land`, `brew`, `enchant`, `interact_gui`, `recover_gravestone` | not in v1 (riding, flying, dimension travel, exploration, other screens, mod-specific) |
| `chat`, `status`, `dump_chunks`, `patch_config`, `blackboard_*`, `add_waypoint`, `wiki_search`, `macro`, `send_custom_payload`, `shredder_*` | not game actions: communication, memory and operations belong outside the action layer |

Since `TASK-20261031-017` the LLM path uses this layer: `AgentManager` forks `src/skills_bot.js` (unless
`BOT_RUNTIME=legacy`, the rollback to `bot_actuator.js`). Its vocabulary is `src/skills/intents.js`: the old action
names the LLM already knows (`collect`, `kill`, `come`, `goto`, `give`, `craft`, `smelt`, `place`, `eat`, `equip`,
`equip_armor`, `withdraw[_from_container]`, `deposit[_to_container]`, `activate[_block]` with an optional mod tool and
sneak, `pickup`, `status`, `chat`, `wait`, `stop`), each resolved by name against what the bot sees and run as the 14
commands, answering in AgentManager's `Successfully` / `Partially collected X/Y` / `Failed <intent>: <reason>` wording.
Every other old action is refused with the list above; nothing falls back to old code. The prompt's action list is
generated from the intent table (`src/skills/llm_prompt.js`). The child has none of the actuator's background loops
(auto-eat, passive defence, anti-AFK, dodging): only its intent queue moves the bot. Live check
`scripts/skills/intent_check.js` (real AgentManager, mock Ollama, test copy of the build world, docs/implemented/WORLD-v1.md):
13 of 13 instructions graded from the server, all 14 prompts with the generated catalogue.

## Measurement

`scripts/skills/bench.js` against the Forge 1.20.1-47.4.10 RL server of this VPS (`docker/rl-server`), one bot,
2026-10-31. Every command 10 times per run in a seeded random order; every trial on a freshly rebuilt arena with random
targets (positions, heights, block types, items, slots, mobs, recipes, containers, counts). Each trial is graded from the
**server's** state over RCON (block state, inventory, position and rotation, food level, entity existence, container
contents), never from the bot. A per-trial server-side precondition (target exists and is not yet in the goal state)
turns a vacuous trial into a harness error, never into a pass. `--clutter 1` adds random 2-3-high walls, steps, 1-2-deep
pits and raised platforms around every scenario, raises half of the stations and containers onto a block and adds decoy
mobs to `attack`.

### Result (final code, commit e5543102)

| Run | Seed | Terrain | Passed | Harness errors | Bot/server disagreements |
| :-- | --: | :-- | --: | --: | --: |
| `v3-plain` | 101 | flat arena | 140 / 140 | 0 | 0 |
| `v3-hard-a` | 202 | clutter | 140 / 140 | 0 | 0 |
| `v3-hard-b` | 303 | clutter | 140 / 140 | 0 | 0 |
| `v3-hard-c` | 404 | clutter | 140 / 140 | 0 | 0 |
| **total** | | | **560 / 560** (Wilson 95 % [0.99, 1.00]) | 0 | 0 |
| `v3-control` (`--control noop`) | 404 | clutter | 0 / 140 | 0 | |

Per command: 40 of 40 for each of the 14 commands, Wilson 95 % interval [0.91, 1.00] each, so every command is at or above
the 90 % target at the lower bound of its interval. The requested test (10 per command, random order, random targets,
flat arena) is `v3-plain`: 140 of 140, 10 of 10 per command (one run of 10 only bounds a command at >= 0.72; the four runs
together bound it at >= 0.91). Median ticks per command (20 ticks = 1 s): look_at 1, craft 1, activate 2, equip 2,
withdraw 4, toss 11, deposit 12, place 17, eat 35, pickup 36, move_to 39, mine 43, attack 77, smelt 403 (two 10-s
furnace cycles). Wall time per 140-trial run: 5-6 minutes including the arena rebuilds.

The negative control replaces every command with 20 idle ticks on the same worlds: all 140 grades fail, so no grader
passes by itself.

### How the result was reached (every defect, its evidence and its fix)

| Run | Code | Result | Defect found | Fix |
| :-- | :-- | :-- | :-- | :-- |
| `smoke1` | first version | 10 / 14 | Q drops: the server applied them but sent no slot update; `withdraw` counted the stale `bot.inventory` while the window was open; harness: idempotent `setblock` refused, hunger too short to pass saturation | body predicts Q/F; count inside the window; harness fixes |
| `smoke2`, `att1` | | 41 / 42 | `attack` passes on pigs, cows, sheep, chickens without a single swing: `spawn-animals=false` makes the server discard summoned animals | per-trial preconditions; mobs the server keeps |
| `full1`, `control1` | | 140 / 140, control 0 / 140 | scenarios too easy to discriminate | `--clutter` |
| `hard1` | | stopped at 129 / 140 (all passed) | the bot froze (server: "Timed out"): `pickupEntity` re-called `follow()`, which returned without a tick | `follow()` always consumes a tick; unit reproducer froze before, passes after |
| `hard2` | | 139 / 140 | drop in a 1-deep hole, bot waited on the rim out of vertical pickup range | walk into the item's cell; unit reproducer |
| `final-*` | | 140 + 136 + 139 of 140, control 0 / 140 | 5 `not_visible`: reach judged from the cell centre, bot stopped off-centre; Mineflayer rounds looks to 0.15° | settle, 0.3-block aim margin, re-approach once |
| `v1-*` | | 418 / 420 | 2 `not_visible`: a dying decoy slime from the previous trial in the crosshair (named by the new failure detail) | entity-blocked aim points are not visible; reset waits for removal |
| `v2-*` | | 231 / 231 valid, 50 harness errors | the reset barrier checked a square while the kill covers a sphere; a late item | kill until the client sees an empty arena (harness only) |
| `v3-*` | final | 560 / 560, control 0 / 140 | none | |

Every trial's per-tick trace and the server's measurements are in `exchange/<run>/` (git-ignored, on the VPS).

## LV2: natural terrain (2026-11-01, `scripts/skills/bench_lv2.js`)

The flat benchmark above carves a flat 29 x 29 arena for every trial, so it never meets real ground. LV2 keeps the terrain
as generated. Every trial gets its own site in the build world (natural seed, `scripts/world/reset.sh`), and no site is
used twice: a seeded permutation of a 64-block grid inside a pre-generated 1,280 x 1,280 region. At each site:

- The bot stands on the nearest dry ground cell of the site centre that has at least 80 cells it can walk to (step up 1,
  drop up to 3). "Ground" is the bot's own world model (`world.kindOf` = solid), so the harness never picks a cell the bot
  calls invalid.
- Targets are real terrain: walk targets and stations on reachable cells, the blocks to mine are the actual ground, trunks
  and stone faces, and `look_at` aims at real blocks in sight.
- Chests, barrels, furnaces and crafting tables are set on the natural ground, and 1 to 3 hostile mobs (zombie, husk,
  skeleton, spider; helmets against daylight) attack the bot during every command.
- Grading is the server's state over RCON, as in the flat benchmark. Each record includes the server's mean tick time.

Ten bots run in parallel. One player can follow bot 1: they are teleported next to it at every trial and stay in creative,
and its planned path is drawn for them only (white end_rod particles; a flame marks the end). Reproducible: a trial depends
only on (seed, index) and the world, so a rerun needs a fresh world from the same seed (`reset.sh --seed <s>`, then
`--pregen 1`). `walk` phase events now carry the planned cells (`cells`), so paths are also in every trace.

| Run (world seed 205483087572977, LV2 seed 1101, 140 trials, 10 bots) | graded | pass | rate | Wilson 95 % |
| :-- | --: | --: | --: | :-- |
| `l1-natural`, before the fix | 133 | 109 | 0.82 | 0.75-0.88 |
| `l2-natural-mudfix`, same 140 sites on a fresh copy of the world | 132 | 123 | 0.93 | 0.88-0.96 |

Graded = trials minus harness errors: 7 and 8 sites with no usable ground in both candidates (mostly water). Server mean
tick time 25-39 ms during the runs; no disconnects, wall time 128 s.

**Defect found (fixed, reproducer in `tests/test_skills_pure.js`):** 13 of the 24 failures in `l1` were bots on **mud**
(collision box 0.875 high, common in this jungle/mangrove world). The world model counted only full cubes as ground and
`feetCell` used `floor(y)`, so a bot standing on mud (y = 63.875) was "inside" the mud cell: `start cell not standable`,
or `invalid_target` for a target on mud. Now a single box over the whole cell with a top >= 0.8 (mud, soul sand, dirt
path, farmland) is ground, and the feet cell is `floor(y + 0.2)`. Bottom slabs (0.5) are unchanged.

**What is left (l2):** 3 bots killed by the mobs during `smelt`/`attack`; 5 more `start cell not standable` with other
causes (for example #84 mined the mud under its own feet, then could not plan its way to the drop); 1 `equip` the bot
reported done that the server did not confirm. None of these are fixed yet.

The flat benchmark run on the natural world's surface (arena next to spawn): 140/140 plain (`w1-natural`), 139/140 with
clutter (`w2-natural-clutter`; #71 `craft` of 8 planks got 4, the second craft not confirmed within 20 ticks).

## Limits (v1)

- Movement: walking, one-block step-ups, drops of up to 3 blocks. No swimming, ladders, parkour, digging or bridging
  through obstacles: such targets end as `unreachable`. Slabs, stairs, fences, doors count as obstacles; near-full blocks
  (mud, soul sand, dirt path, farmland) are ground since LV2.
- `look_at` does not walk; `mine`, `place`, `activate` and the screen commands need a standing cell that sees the target.
- Entity reach is the vanilla client's (3 blocks); hits follow the weapon's recharge time, no critical hits or sprint knock-back tactics.
- Passive (fleeing) animals are not in the benchmark: the RL server runs with `spawn-animals=false`, and 1.20.1 then
  discards every animal on its next tick (measured: all summoned pigs, cows, sheep and chickens were gone before the
  command started). Turning that on would also populate the RL arenas.
- Vanilla blocks only; modded blocks fall back on their collision shape (world.js) and were not benchmarked.
- The live clock only: inside the RL environment (paused physics, `src/rl/env.js`) the commands are not wired yet.
- `activate` with `item`/`sneak` (mod tools) and the intent layer were checked on vanilla blocks only; mod blocks need the
  owner's mods on the build world (WORLD-v1.md).
