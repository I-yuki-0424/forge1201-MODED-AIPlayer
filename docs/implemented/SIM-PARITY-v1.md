# SIM-PARITY-v1: the Rust simulator against the real server, command by command, and a packet front end for testing (TASK-20261125-078)

The owner's report (problem list 5, Large 2): results of the Rust simulator `tools/sim` often differed from the real server; run the same world
and the same bot actions on both, watch whether they match, fix what does not, and make it practical for testing (Medium 3: "make use of the
Rust server"). This document is the result: how runs are recorded and replayed, the parity level and why, the noise floor of the real
server, the parity table before and after the fixes (each fix a rule of the game or of the action layer, never a fitted rate), what still
differs, and the testing backend (a packet front end that runs the real bot code) with its measured speed and fidelity. All numbers are
from Fabric **1.21.1** test world 5 (seed 976441802478263148; pc-r2 on -3445026601923726469), 2026-11-25/26, bots on mineflayer's own
physics and inventory (TASK-076's native modules were not the default in any recording; the trace header now records which ran).

## 1. Which simulator

| Simulator | What it is | In the parity work? |
| :-- | :-- | :-- |
| `tools/sim` (Rust, std only) | Command-level simulator: each action-layer command is one transition (outcome, reason, ticks, position, blocks, inventory), world clocks between. Built for the RL skill environment (SIM-RUST-v1). | **Yes.** |
| `rl3/` (Python/JAX) | Cell-level movement simulator for training `move3` and the pit station network. | **No.** The T26 tests move bots with NAV (`navigator` default `nav`); `move3` runs only with `navigator: legacy`. Its contract is its own golden files; the recorder's per-tick traces can feed it if `move3` returns. |
| `scripts/work/sim_plan.js` | Plan-level simulated builder. | No: it simulates the plan, not the server. |

## 2. Recording, re-playing, comparing

| Tool | What it does |
| :-- | :-- |
| `scripts/sim/record.js` | Loaded with `node --require` (the T26 harness: `scripts/t26/run.sh N <test>.js NODE_ARGS=--require=./scripts/sim/record.js SIMREC_DIR=/out/simrec/<run> [SIMREC_TRACE=1]`). Wraps the action layer's `execute` and the runner's `run` (the work layer's moves are named `move:<name>`), changes nothing the bot does, and writes one JSONL file per bot: chunk snapshots and every block update the server sent, and per command its arguments, atomic flag, the planner settings (`env`: planNodes, maxDrop, noVines, the floors it must avoid, the owner of the block under the feet), the state before (position, look, ground, health, food, pack with damage and enchantments, hotbar slot) and the outcome after (ok / reason, detail, ticks, phases, state). Cost: 1-6 ms of event loop per new chunk, up to 140 ms at a bot's first command (25 chunks; `recMs` on the command line), ~4 KB per chunk. |
| `forgeaip-sim replay RUN_DIR...` (`tools/sim/src/replay.rs`) | Rebuilds the world from the first snapshot of every chunk plus the block updates in time order; runs every modelled command in the simulator **from the recorded world and state** (teacher forcing: the simulator's changes are undone afterwards, so a divergence never carries over) and compares it with the server. Prints the parity table; `--rows` writes one row per command. |
| `scripts/sim/play.js` | Re-plays a recorded run on the real server: a new world of the same seed (`scripts/t26/up.sh N --new --seed S`), the recorded blocks put back, every recorded command again from its recorded state (tp, pack, hotbar slot). Recorded with the recorder, each command carries `ref` = the original id. |
| `forgeaip-sim compare RUN_A RUN_B` | Pairs two runs command by command (`ref`); pairs whose surroundings (blocks within 3 of the bot and the target), cell or pack differed at the start are left out. Used for the noise floor (real against real) and the front end (real against front end). |
| `scripts/sim/capture.js` | Records every packet of a real session (configuration, login, chunks): what the front end replays at login. |
| `scripts/sim/front.js` | The packet front end (section 7). |

What is compared per command: **outcome** (ok and reason), **cell** after (`floor` of the position), **blocks** (cells changed during the
command within 6 blocks of the bot's start, end or any cell the command names; a change nearer to another bot's concurrent command is that
bot's), **inventory** (delta of the 36 main slots), **ticks**, food. Kept apart because no command can be expected to match them: changes
of the world's own clocks (`world_clock`: leaf decay, grass under a block, a falling block landing) and random drops (`random_drops`:
saplings, sticks, apples, flint, cocoa beans). `cancelled` (the caller stopping a command) is not a server answer and is not compared.

Categories of a divergence: `movement_reach`, `collision`, `walk_time`, `dig_time`, `dig_rules`, `placement_rules`, `place_time`, `fluids`,
`drops`, `gravity_blocks`, `hunger`, `light`, `recipes`, `inventory_other`, `blocks_other`, `other_time`, `world_clock`, `random_drops`
(rules in `categorize`, replay.rs).

## 3. The parity level, and the noise floor that bounds it

| Measure | Target | Why |
| :-- | :-- | :-- |
| outcome and reason identical | >= 98 % | The router and the jobs branch on the reason (COMMAND-STACK-v1): a wrong reason is a wrong decision. Bounded by the server's agreement with itself. |
| outcome, cell, blocks and inventory identical | >= 98 % | The tests are graded on blocks and items. |
| ticks within 10 % or 2 ticks (both ok) | >= 90 %, and the sum of simulated ticks within 0.95-1.05 of the real per command | Real ticks carry lag; the sum is what makes the simulator's run time an estimate of the real one. |
| coverage (commands modelled) | reported | Grows with what is ported. |

**Noise floor (measured first).** The place_b run pb-r1 (958 commands) was re-played on a new world of the same seed with `play.js` (930
commands re-played; the 28 recorded as `cancelled` are not; no pack failed to restore): **513 pairs** started from identical surroundings, cell and
pack. Real against real: **99.8 %** same outcome and reason, **99.0 %** same outcome, cell, blocks and inventory, **99.3 %** ticks within
tolerance. The only steady noise is random drops (21) and world-clock changes (11). Since the server agrees with itself on more than 99 %,
the targets stay at 98 %. 417 commands were left out because their start differed (the world drifts: leaves decay, random drops differ).

## 4. The corpus

| Run | Test (result) | Bots | Commands | What it exercises |
| :-- | :-- | :-- | --: | :-- |
| pa-r1 | place_a (4/4 PASS) | 4 | 4 | one 30-cell `bridge` per bot from one platform |
| pb-r1 | place_b (stopped at 8 min: the build job stalled in its sweep, 075/081's domain) | 1 | 958 | recipe placements, aimed and blind digs of a jungle tree, pillar, descend, bridge, walks |
| mb-r1 | mine_b DEPTH=6 (FAIL: a unit `unreachable` at the expert station) | 1 | 917 | 762 atomic mines with Efficiency 255, equip, walks |
| mvb-r1 | move_b (FAIL: one death on Normal) | 1 | 411 | walks out of a cave, digs through sand and gravel |
| pc-r1 | place_c LIMIT_MIN=20 (FAIL: timeout) | 3 | 2,808 | Litematica build in the sky: atomic and recipe placements, bridges, pillars, descends, supply moves |
| pc-r2 | place_c again on a new seed (FAIL: timeout), with the planner's avoid floors and the floor's owner recorded | 3 | 2,562 | the same |

## 5. Parity before and after (all six runs: 7,660 commands)

Each cell: stage-A simulator (commit 6b6d18f4) / now (2026-11-26, after the tick physics and the fixes below). Outcome, all and ticks are
shares of the modelled commands (ticks: of those both ok).

| command | n | modelled | outcome | outcome+cell+blocks+inventory | ticks |
| :-- | --: | :-- | :-- | :-- | :-- |
| mine | 2397 | 100.0 % / 98.7 % | 89.0 % / 99.5 % | 73.6 % / 97.9 % | 0.0 % / 98.4 % |
| place | 2134 | 100.0 % / 100.0 % | 56.8 % / 99.9 % | 34.5 % / 98.9 % | 10.3 % / 97.6 % |
| move_to | 1428 | 100.0 % / 99.4 % | 91.0 % / 99.4 % | 84.5 % / 98.7 % | 47.5 % / 79.2 % |
| equip | 175 | 100.0 % / 100.0 % | 100.0 % / 100.0 % | 98.3 % / 98.9 % | 100.0 % / 100.0 % |
| tunnel | 24 | 100.0 % / 100.0 % | 91.7 % / 95.8 % | 87.5 % / 95.8 % | 0.0 % / 0.0 % |
| move:bridge (+ run:bridge) | 532 | 0 / 98.1 % | - / 99.6 % | - / 97.9 % | - / 92.9 % |
| move:pillar | 487 | 0 / 100.0 % | - / 94.7 % | - / 93.2 % | - / 86.1 % |
| move:descend | 238 | 0 / 100.0 % | - / 99.6 % | - / 98.3 % | - / 91.6 % |
| activate, pour, pickup, withdraw, supply moves | 244 | 0 / 0 | - | - | - |
| **total** | **7,660** | **80.4 % / 96.2 %** | **78.7 % / 99.3 %** | **63.4 % / 98.1 %** | **19.5 % / 93.0 %** |

Per run now (outcome / all / ticks): pa-r1 100 / 100 / 100 %, pb-r1 99.2 / 98.0 / 94.8 %, mb-r1 99.8 / 99.6 / 98.9 %, mvb-r1 99.3 / 98.1 /
99.0 %, pc-r1 98.8 / 97.4 / 90.6 %, pc-r2 99.6 / 98.3 / 91.4 % (stage A on pc-r2: 73.4 / 55.3 / 22.1 %). The action layer's own commands
(no work-layer moves, 6,120): outcome **99.6 %**, all **98.5 %**.

| corpus | modelled | outcome | all | ticks |
| :-- | --: | --: | --: | --: |
| all six runs | 7,367 | 99.3 % | **98.1 %** | 93.0 % |
| without pc-r1 (five runs) | 4,676 | 99.5 % | 98.5 % | 94.4 % |
| all six runs without the 24 pc-r1 pillars whose floor's owner was not recorded | 7,343 | 99.6 % | 98.4 % | |

**Which figure the target is judged on: all six runs, 98.1 %.** pc-r1 was recorded before the recorder kept the floor's owner, so 24 of its
commands measure a recorder gap (fixed since pc-r2), not the simulator; but its other 2,667 commands are the largest multi-bot sample in the
corpus and carry exactly the divergences that are left (neighbours' bodies, fluids), so dropping the run would flatter the simulator more than
the gap distorts it. The figure without the 24 commands (98.4 %) and without the run (98.5 %) are given so the effect of the gap can be read
off; the verdict is the same on all three.

Divergences by category, stage A -> now: dig_time 2041 -> 36, movement_reach 1772 -> 72, place_time 1009 -> 47, placement_rules 986 -> 2,
walk_time 671 -> 269, dig_rules 355 -> 17, drops 158 -> 9, gravity_blocks 10 -> 3; compared apart: world_clock 46, random_drops 40.
Sum of simulated over real ticks per command: move_to 1.01, mine 1.02, place 0.93, pillar 0.98, descend 0.95, bridge 0.96, tunnel 1.55.

**Against the targets** (section 3): outcome and reason **99.3 %** (target 98 %: met on every run); outcome, cell, blocks and inventory
**98.1 %** (target 98 %: met; met on every run but pc-r1, 97.4 %); ticks **93.0 %** (target 90 %: met; walks 79 %). What is left is listed in
section 6.

How the numbers moved after the first version of this document (outcome / all / ticks on the whole corpus): 96.1 / 93.0 / 91.2 % ->
the player's tick physics in Rust (`tools/sim/src/physics.rs`, a port of TASK-076's `src/native/physics` for 1.21.1; all 19 golden traces
of `tests/golden_native` replay within the JS test's tolerance) driving `descend` and `bridge` (the 143 physics `stuck`: descend 64.7 ->
99.5 %, bridge 88.3 -> 99.6 %) 99.2 / 96.0 / 92.5 % -> the rules below marked (2026-11-26) 99.2 / 97.6 / 93.0 % -> the pillar's free
cell and the moves' own cells in the attribution 99.3 / 98.1 / 93.0 %.

### The fixes, each a rule of the game or the action layer

| Category | Cause found in the corpus | Fix (tools/sim) |
| :-- | :-- | :-- |
| dig_time | The RL constants assumed walking to every drop (20 + 19 ticks); the test worlds put drops straight into the pack and the work layer digs `collect:false` / `blind`; Efficiency 255 was ignored. | Dig ticks as `body.js` counts them: instant break 2, else k + 3, aimed + 2; Efficiency (level² + 1) on the tool's speed; auto-pickup on test worlds (mine, tunnel). |
| movement_reach | The first look was from the cell centre, the real one from the eye where the body stands; the RL flood (1,500 nodes, 18 blocks) instead of the planner; atomic commands never walk; work bots plan 6,000 nodes with vines as air; another bot's scaffolding is no floor. | The recorded eye; the planner's A* (`planner.js` nodes, moves, costs, the reach heuristic) with the bot's recorded settings and avoid floors; atomic preconditions (`preconditions.js` for mine and place) end `precondition_failed`; no walking when atomic; a body in the air lands before it plans; the body falls into a dug floor. |
| dig_rules | Vines on a felled tree went with the log (only those hanging on it); cocoa with its log; rays were stopped by vines. | Neighbour updates (`canSurvive`): vine faces from the recorded block states, floor-bound plants, torches, rails, carpets, doors, wall-mounted blocks, cocoa; rays pass blocks without a collision shape. |
| place_time / placement_rules | `place` with a recipe never walks and needs only reach to the support; REPLACEABLE had the 1.20.1 name `grass`; atomic placements check reach, the body in the cell, the item in hand. | `placeWithRecipe` ported (support face, reach + 0.5, 4 ticks); `short_grass`, `tall_seagrass`, `bubble_column` replaceable; place preconditions. |
| move_to outcome | The real command refuses a target nobody can stand on (`invalid_target`) and an unloaded one (`unreachable`) before walking. | The same checks. |
| walk_time | Ticks were the RL fit on flood costs; the bot sprints on straight runs. | Ticks of the planned path at vanilla speeds per move (walk 4.63 per block, sprint 3.56 when the next four moves are plain walks, diagonal x 1.414, step up 9, drops by free fall, water x 2.5) + 3. |
| gravity_blocks | Sand over a dug cell fell instantly; in the game it falls as an entity and lands later. | Falling blocks land after vanilla free fall (+2 ticks); a landing is a world-clock change. |
| coverage | `pillar`, `descend`, `bridge` were not modelled (place_a is one `bridge` per bot). | `tools/sim/src/moves.rs`: the moves' rules (the stack item: the test world's temporary block first; a bridge's cells one step apart; no pillar on another bot's block), ticks per level / cell from the corpus medians. |
| attribution | Four bots bridging from one platform: each bot's window held the others' blocks. | A change nearer another bot's concurrent command is that bot's. |
| physics (2026-11-26) | `descend` and `bridge` ended `stuck` on the server 143 times: the dug floor did not drop a body that overlapped the next column, a sneak step over an edge did not arrive. | `physics.rs` (the player's tick physics: collision with the real block boxes, sneak edge back-off, step-up, fluids, climbing); the moves run their body on it. |
| bridge (2026-11-26) | The bridge took away the bot's own bridge block it started on (bridge.js unlays the floor of each step when `bot.__temps` holds it as this bot's `bridge`); the simulator only took away blocks laid in the same command: 63 bridges with a pumpkin too many and one fewer in the pack. | The same rule; the recorder records `env.floorOwn`, older traces take it from the recorded outcomes of the bot's earlier bridges. |
| movement_reach (2026-11-26) | A plan that does not reach the goal still walks: planner.js returns the path to the expanded node with the lowest heuristic (`partial`), motion.js walks it and plans again (five times, then `stuck`); the simulator said `unreachable` where it stood (57 mines, 11 walks ended in another cell). | `plan_follow`: the same partial walks and re-plans. |
| gravity_blocks (2026-11-26) | Sand over a dug cell leaves it 2 ticks after the dig's block update, the block above 2 ticks after that (FallingBlock's scheduled tick checks the cell below); the simulator emptied the whole column at once (mvb-r1 #382: the sand over the dug cell was air in the dig's window, the two above it in the next command's). | Each block of the column leaves its cell 2 ticks after the one under it, timed from the dig's moment inside the command (`Sim::dig_t`). |
| placement_rules (2026-11-26) | A bed is two blocks: the head goes into the cell the placer faces (10 beds in pc-r1/pc-r2). | The same, refused without room for the head. |
| placement_rules (2026-11-26, pillar) | 11 pillars ended `not_confirmed` on the server, the simulator stacked the block. From the recordings: in 6 a neighbour's body overlapped the cell at that moment (its position on the line between the start and the end of its own recorded command: standing in the cell, or bridging through it); in 3 (pc-r1 #675-677) the feet cell held the iron farm's redstone wire, which a placement cannot replace; 2 are not explained (pc-r1 #735: the neighbour stood two cells above, not in the cell; pc-r2 #640: the neighbour reached the top cell near the end of a 19-level pillar, the level timing is a share of the window, not measured). | The server's rule: no block into a cell that is not replaceable or that another body overlaps; the replay gives the simulator the other bots' bodies across the command's window (`Sim::bodies`). |
| attribution (2026-11-26) | A move owned only its start and end cells, so the blocks a 15-level pillar stacked and took away in between were nearer to a neighbour's cells and went to the neighbour (a measurement error of the replayer, not a simulator one). | A command owns the cells it works on (`cmd_cells`): a pillar's and a descend's column, a bridge's floor cells. The changes still counted against a command now have no other bot's command within 17 blocks: they are fluids spreading and vines (section 6). |
| compare (2026-11-26) | Vines spreading into air (VineBlock random tick) appeared as block changes of walks; the simulator's side counted a vine losing a face as a change, the real side does not. | Vine spread is a world-clock change; both sides compare block names. |

The RL `run` mode keeps its validated flood planner (`astar` off) but now also gets the new world rules (supports, vines, falling blocks,
the replaceable list); its SIM-RUST-v1 numbers were measured before these and are not re-validated here.

## 6. What still differs (do not read simulator numbers past this list)

The remaining 142 commands that differ in outcome, cell, blocks or inventory (1.9 % of 7,367 modelled), by cause:

1. **Stance choice on partial shapes and planner corner cases** (about 70, 0.95 %): mines, placements and walks where the real planner stood
   on another cell or found none (`mine` / `place` ending in another cell: 46; `unreachable` the other way: about 20), mostly on the sky deck's
   scaffolding, slabs, walls and the iron farm's trapdoors, which the two planners treat differently at the edges.
2. **`pillar`** (32, 0.43 %): 24 on another bot's block in pc-r1 (the floor's owner was not recorded yet), 2 `not_confirmed` not explained
   (pc-r1 #735, pc-r2 #640, section 5), the rest blocks of a neighbouring bot's build under way in the same column.
3. **Fluids over time** (15, 0.20 %): water and lava spreading cell by cell next to a placement or a dig; the simulator floods a dug cell's
   neighbourhood at once (water) or not at all (lava).
4. **The builder's own controls and vines** (about 15): blocks placed by `src/build/move.js` (not recorded) inside another command's window,
   vines on a felled tree that the simulator keeps.
5. **Walk ticks** (ticks only): 79 % of `move_to` within tolerance (the server is 98 % self-consistent here): the settle on the last cell
   and the turns are not in a per-move time. `tunnel` ticks are 1.55x the real ones (24 commands).
6. **Bot state the simulator only has when recorded**: avoid floors, the floor's owner and the bot's own bridge blocks (recorded since pc-r2 /
   2026-11-26), the rest of the temporary-block registry, the work layer's mine box (`protected`), a cancelled command's timing.
7. **Not modelled at all** (3.8 % of the corpus): `activate` (except beds), `pour`, `pickup`, `withdraw`, `deposit`, `look_at`, `toss`,
   `set_contents`, the supply moves (`take_many`, `deposit_many`, `take_shulker`), the builder's own controls (`src/build/move.js`),
   reflexes, mobs (the replay runs peaceful), hunger on Peaceful, light, fluids over time, redstone, block states beyond vine faces (a
   stair's facing compares by name).
8. **Data**: minecraft-data 1.21.1 lists 1,470 recipes against 2,409 for 1.20.1 (not verified: no corpus command crafted).
9. **The recorder's own cost**: up to 140 ms of event loop per bot at its first command (25 chunk snapshots), then 1-6 ms per new chunk.

## 7. Testing backend: the packet front end (backend B)

Decision (stage A, approved): the real bot code on an in-process fake protocol client, server rules on the other side. First measurement
that could have changed it, the share of the recorded game ticks spent inside `execute` (the rest is the work layer's moves through the
runner; the builder's own controls in `src/build/move.js` are not even recorded): place_a **0 %** (one `bridge` per bot), place_c
**39.7 %** of 53,555 ticks, place_b 65.2 %, mine_b 95.0 %, move_b 99.2 %. Backend A (an adapter below `execute`) would leave out most of the
build tests and exactly the commands that carry the remaining divergences; the decision stands.

`scripts/sim/front.js` (loaded with `--require`): every `mineflayer.createBot` gets a `FakeClient` (`createBot({client})`), packets go in
and out as objects; RCON is answered in-process; login replays the captured configuration and login packets; the players (positions, packs,
slots, teleports, game mode) stay in JavaScript. **The world is `forgeaip-sim serve`** (`tools/sim/src/serve.rs`, one JSON line per request
over a pipe, 2026-11-26): a block-state world from a recorded run (`TRACE=<dir>`) or from a server's region files (`REGIONS=<dir>`,
`SIM_SPAWN=x,y,z`), with the simulator's rules: digging as `ServerPlayerGameMode` counts it (progress per tick x (ticks + 1) >= 0.7 at the
stop, an instant break at the start, a fifth off the ground and with the eye in water, a block that needs a tool breaks slowly by hand and
drops nothing, a dig stopped early finishes at 100 % as the server's delayed destroy), the tool's drop straight into the pack (the test
worlds' auto-pickup), blocks that lose their support (vines by their faces, plants, torches, cocoa), water into a dug cell, sand and gravel
that leave their cells 2 ticks apart and land later; placement states from the click and the look (`Block.getStateForPlacement` per family
as `orient.js` models it: stairs, slabs, logs, trapdoors, torches and wall torches, chests, furnaces, pistons, observers, hoppers, ladders,
doors, beds with their head); the harness's world commands (`setblock`, `fill`, `clone`, `execute if|unless block(s)`). The game clock is
stepped, not scaled: every 50 / `SIM_SPEED` ms of wall time it advances one tick and runs each bot's physics poll once (scaling the wall
clock let mineflayer catch up several physics steps inside one counted tick: walks came out 5 ticks short), and serve's world clock runs on
it (one request per 5 ticks).

**Measured** (recorded runs re-played by `play.js`, every command from its recorded state; the share with the recorded outcome and reason
counts every re-played command, the pairs only those whose surroundings were the same at the start):

| | recording | re-play on the real server | front end, JS world (00:40) | front end on serve (13:00) |
| :-- | --: | --: | --: | --: |
| place_b pb-r1: commands with the recorded outcome and reason | - | 910 of 930 (97.8 %) | 915 of 930 (98.4 %) | 904 of 930 (97.2 %); 904 of 923 (97.9 %) without the 7 below |
| pb-r1: pairs with the same start / same outcome, cell, blocks, inventory | - | 513 / 99.0 % | 148 / 100 % | **317 / 98.4 %** |
| pb-r1: wall time per game tick inside commands | 50.0 ms | 50.5 ms | 4.0 ms (12x) | **3.1 ms (16x, one core: `--cpus 1`)** |
| move_b mvb-r1: commands with the recorded outcome and reason | - | | 389 of 411 (94.6 %) | **401 of 411 (97.6 %)** |
| mvb-r1: pairs with the same start / same outcome, cell, blocks, inventory / ticks | - | | 383 / 99.5 % / 99.7 % | 382 / **99.7 % / 99.7 %** |
| mvb-r1: wall time per game tick inside commands | 50 ms | | 2.0 ms (25x) | 2.0 ms (25x) |

The serve world holds the block updates the JS world lacked, so more commands start from the recorded surroundings (pb-r1 pairs 148 ->
317) and the move_b digs through sand and gravel now come out as on the server (94.6 -> 97.6 %). The 7 place_b commands that differ from the
recording and did not before are `descend`s that ended `stuck` on the server (#232, #253, #303, #388, #506, #564, #698) and `ok` on the
front end: since TASK-075's fix in `src/work/bot/moves.js` the bot centres itself before it digs its floor (exactly these five are named
in its comment), so the current code no longer gets stuck there. That is a change of the bot, not of the front end: a re-play measures the
code it runs. SIM_SPEED 50 (measured on the JS world, first 300 commands): 91.7 %, the bot's own wall-clock waits start to break; 20 stays
the setting.

Reading: on the real bot code the front end reproduces the server's outcomes about as often as the server reproduces itself (97.9 % and
97.6 % against the server's 97.8 % on place_b), at 16-25x the game speed on one core and without a Minecraft server (no 54 s world start).
Not yet: entities other than players (item drops on the ground, mobs), fluids over time, light, hunger, containers (`withdraw`, `deposit`,
shulker boxes), redstone. The decision stands (backend B); the next step for TASK-079/080 is to run whole T26 tests on it from the test
worlds' region files (`REGIONS=`), which serve already loads, and grade them with the same RCON commands it answers.

## 8. How to

```bash
# record (one world, one harness at a time; never 03:00-06:00 JST)
REPO=$PWD scripts/t26/run.sh 5 place_b.js NODE_ARGS=--require=./scripts/sim/record.js SIMREC_DIR=/out/simrec/pb-r2 NATIVE_PHYSICS=0 NATIVE_INVENTORY=0 NATIVE_DIG=0
# replay in the simulator (tools/sim/build.sh first)
tools/sim/target/bookworm/release/forgeaip-sim replay /mnt/data/forgeaip-play/t26/out/simrec/pb-r2 --rows rows.jsonl --json summary.json
# noise floor: the same commands on a new world of the same seed, then compare
scripts/t26/up.sh 5 --new --seed <seed>
REPO=$PWD scripts/t26/run.sh 5 ../sim/play.js TRACE=/out/simrec/pb-r2 SIMREC_DIR=/out/simrec/pb-r2-play NODE_ARGS=--require=./scripts/sim/record.js
tools/sim/target/bookworm/release/forgeaip-sim compare /mnt/data/forgeaip-play/t26/out/simrec/pb-r2 /mnt/data/forgeaip-play/t26/out/simrec/pb-r2-play
# simulator tests (the golden physics traces are read from tests/golden_native)
docker run --rm --network none -e CARGO_TARGET_DIR=/w/target/bookworm -v "$PWD/tools/sim":/w -v "$PWD/tests":/tests:ro -w /w rust:1-bookworm cargo test --release --offline
# the same re-play on the front end (no server; tools/sim/build.sh first: front.js starts forgeaip-sim serve, SIM_BIN overrides its path;
# capture once per version with scripts/sim/capture.js; REGIONS=<world>/region SIM_SPAWN=x,y,z instead of TRACE for a world from region files)
docker run --rm --name sim-front --network none -v "$PWD":/app:ro -v <node_modules>:/app/node_modules:ro -v /mnt/data/forgeaip-play/t26/out:/out -w /app \
  -e TRACE=/out/simrec/pb-r2 -e SIMREC_DIR=/out/simrec/pb-r2-front -e CAPTURE=/out/simrec/capture-1.21.1.jsonl -e SIM_SPEED=20 -e MC_PLATFORM=fabric -e MC_VERSION=1.21.1 \
  -e BOT_REGISTRY=vanilla -e TEMP_BLOCK=pumpkin -e SYNCMATICA=0 -e DISPLAY=0 node:20-slim node --require ./scripts/sim/record.js --require ./scripts/sim/front.js scripts/sim/play.js
```

Trace format (`format: 1`; shared with TASK-076, whose `src/native/trace.js` adds the per-tick `tick` line): `hello` (format, recorder, bot,
version, minY, height, dim, difficulty, gameMode, temp, native, world, run, speed, ms), `st` (state id, name, properties), `chunk` (u16 state
ids, deflate, base64, index ((y - minY) * 16 + z) * 16 + x), `blk` (ms, tick, cell, state id), `cmd` (id, ref, layer, name, args, atomic,
maxTicks, env, recMs, ms, tick, before), `res` (id, ms, tick, ok, reason, detail, ticks, wallMs, phases, after, trace), `spawn`, `death`.
