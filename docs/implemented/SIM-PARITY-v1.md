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

Each cell: stage-A simulator (commit 6b6d18f4) / now. Outcome, all and ticks are shares of the modelled commands (ticks: of those both ok).

| command | n | modelled | outcome | outcome+cell+blocks+inventory | ticks |
| :-- | --: | :-- | :-- | :-- | :-- |
| mine | 2397 | 100.0 % / 98.7 % | 89.0 % / 98.8 % | 73.6 % / 95.8 % | 0.0 % / 98.1 % |
| place | 2134 | 100.0 % / 100.0 % | 56.8 % / 96.9 % | 34.5 % / 95.0 % | 10.3 % / 97.4 % |
| move_to | 1428 | 100.0 % / 99.4 % | 91.0 % / 99.2 % | 84.5 % / 97.1 % | 47.5 % / 79.1 % |
| equip | 175 | 100.0 % / 100.0 % | 100.0 % / 100.0 % | 98.3 % / 98.9 % | 100.0 % / 100.0 % |
| tunnel | 24 | 100.0 % / 100.0 % | 91.7 % / 91.7 % | 87.5 % / 87.5 % | 0.0 % / 0.0 % |
| move:bridge (+ run:bridge) | 532 | 0 / 98.1 % | - / 88.3 % | - / 74.9 % | - / 76.8 % |
| move:pillar | 487 | 0 / 100.0 % | - / 92.8 % | - / 89.9 % | - / 86.1 % |
| move:descend | 238 | 0 / 100.0 % | - / 64.7 % | - / 63.9 % | - / 68.8 % |
| activate, pour, pickup, withdraw, supply moves | 244 | 0 / 0 | - | - | - |
| **total** | **7,660** | **80.4 % / 96.2 %** | **78.7 % / 96.1 %** | **63.4 % / 93.0 %** | **19.5 % / 91.2 %** |

Per run now (outcome / all / ticks): pa-r1 100 / 100 / 100 %, pb-r1 97.5 / 95.7 / 94.4 %, mb-r1 99.8 / 98.8 / 98.9 %, mvb-r1 99.3 / 96.8 /
99.0 %, pc-r1 95.5 / 91.7 / 87.5 %, pc-r2 94.2 / 90.5 / 89.5 % (stage A on pc-r2: 73.4 / 55.3 / 22.1 %). The action layer's own commands
(no work-layer moves, 6,120): outcome **98.2 %**, all 95.9 %. Without the 143 work-layer moves the server ended `stuck` (physics, below):
outcome **98.0 %**, all 94.8 %.

Divergences by category, before -> now: dig_time 2041 -> 43, movement_reach 1772 -> 154, place_time 1009 -> 50, placement_rules 986 -> 81,
walk_time 671 -> 271, dig_rules 355 -> 43, drops 158 -> 25, gravity_blocks 10 -> 3; compared apart now: world_clock 40, random_drops 40.
Sum of simulated over real ticks per command: move_to 1.01, mine 1.02, place 0.93, pillar 0.98, descend 0.95, bridge 0.96, tunnel 1.55.

**Against the targets** (section 3): outcome 96.1 % on the whole corpus (target 98 %: met on the action layer's commands, 98.2 %, and on
everything but the physics `stuck` of the work-layer moves, 98.0 %; met on pa, mb, mvb; not on pb and the two place_c runs), all 93.0 %
(not met), ticks 91.2 % (met; walks 79 %). The two causes of the shortfall are not rules a command-level simulator can have: the body's
physics in `bridge` and `descend` (143 commands) and the work layer's own state beyond what is recorded (section 6). Recording the planner's
avoid floors and the floor's owner (pc-r2) removed the 24 `pillar` divergences of pc-r1 that came from another bot's scaffolding.

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

The RL `run` mode keeps its validated flood planner (`astar` off) but now also gets the new world rules (supports, vines, falling blocks,
the replaceable list); its SIM-RUST-v1 numbers were measured before these and are not re-validated here.

## 6. What still differs (do not read simulator numbers past this list)

1. **The body's physics in the work-layer moves** (143 commands): 84 of 238 `descend` and 59 of 532 `bridge` ended `stuck` on the server:
   the bot dug its floor and did not drop (pb-r1 #232, #253, #303, #388, #506), a sneak step over an edge did not arrive. The simulator has
   no body and says `ok`. This is real bot behaviour worth a look by 075/081, and the main reason for the packet front end.
2. **Planner and aim corner cases** (about 100): placements and mines the real planner found no stand cell for (`unreachable` after a few
   expansions: 38 placements, 20 mines) or no aim point for (`precondition_failed: line_of_sight`: 25 atomic placements) where the simulator
   found one, and a few the other way; partial block shapes (slabs, stairs, trapdoors, walls, the sky deck's scaffolding) are full cubes or
   nothing in the simulator, which is where the two planners part.
3. **`pillar`** `not_confirmed` (11) and on another bot's block (24, pc-r1 only: recorded since pc-r2, then gone).
4. **Walk ticks**: 79 % of `move_to` within tolerance (the server is 98 % self-consistent here): the settle on the last cell and the turns
   are not in a per-move time; a tick-level body is the fix, not another constant. `tunnel` ticks are 1.55x the real ones (24 commands).
5. **Bot state the simulator only has when recorded**: avoid floors and the floor's owner (recorded since pc-r2), the rest of the
   temporary-block registry, the work layer's mine box (`protected`), a cancelled command's timing.
6. **Not modelled at all** (3.8 % of the corpus): `activate` (except beds), `pour`, `pickup`, `withdraw`, `deposit`, `look_at`, `toss`,
   `set_contents`, the supply moves (`take_many`, `deposit_many`, `take_shulker`), the builder's own controls (`src/build/move.js`),
   reflexes, mobs (the replay runs peaceful), hunger on Peaceful, light, fluids over time, redstone, block states beyond vine faces (a
   stair's facing compares by name).
7. **Data**: minecraft-data 1.21.1 lists 1,470 recipes against 2,409 for 1.20.1 (not verified: no corpus command crafted).
8. **The recorder's own cost**: up to 140 ms of event loop per bot at its first command (25 chunk snapshots), then 1-6 ms per new chunk.

## 7. Testing backend: the packet front end (backend B), prototype

Decision (stage A, approved): the real bot code on an in-process fake protocol client, server rules on the other side. First measurement
that could have changed it, the share of the recorded game ticks spent inside `execute` (the rest is the work layer's moves through the
runner; the builder's own controls in `src/build/move.js` are not even recorded): place_a **0 %** (one `bridge` per bot), place_c
**39.7 %** of 53,555 ticks, place_b 65.2 %, mine_b 95.0 %, move_b 99.2 %. Backend A (an adapter below `execute`) would leave out most of the
build tests and exactly the commands that carry the remaining divergences; the decision stands.

`scripts/sim/front.js` (loaded with `--require`): every `mineflayer.createBot` gets a `FakeClient` (`createBot({client})`), packets go in
and out as objects; RCON is answered in-process; the world is the recorded chunks; login replays the captured configuration and login
packets; rules: movement as the client sends it, digging accepted at >= 70 % of the vanilla break time (as `ServerPlayerGameMode` checks),
placing the item's default block into a replaceable cell no player stands in, drops into the pack, inventory slots, teleports, game mode;
clocks `SIM_SPEED` times faster.

**Measured** (the place_b run pb-r1 re-played by `play.js` three ways, same 930 commands, same forcing of position and pack):

| | the recording (real) | re-play on the real server | re-play on the front end, SIM_SPEED 20 | front end, SIM_SPEED 50 (first 300) |
| :-- | --: | --: | --: | --: |
| commands with the recorded outcome and reason | - | 910 of 930 (97.8 %) | **915 of 930 (98.4 %)** | 275 of 300 (91.7 %) |
| pairs with the same start (compare) / agreeing in outcome, cell, blocks, inventory | - | 513 / 99.0 % | 148 / **100 %** | - |
| game ticks run | 9,222 | 9,302 | 9,132 | 2,400 |
| wall time per game tick inside commands | 50.1 ms | 50.7 ms | **4.2 ms (12x)** | 2.7 ms (18x) |
| wall time of the whole run | 502 s | 612 s | 206 s (3x; the rest is play.js's own waits) | |
| server packets in / out | | | 21,268 / 3,452 | |

The move_b run mvb-r1 (411 commands, a cave walk and digs through sand and gravel) on the front end: 389 of 411 with the recorded outcome
(94.6 %; the 22 differ in cells the front end does not update: sand and gravel that fell, the death on Normal with no mobs here); 383 pairs
with the same start, **99.7 %** same outcome and 99.5 % same outcome, cell, blocks and inventory; but its walks took about 5 ticks fewer
than on the server (move_to ticks within tolerance 1.9 %), 2.2 ms per game tick. The cause of the 5 ticks is not found yet (the place_b
walks on the front end agreed within tolerance on 92 %).

Reading: on the real bot code the front end reproduces the server's outcomes as often as the server reproduces itself (98.4 % against
97.8 %), at 12x the game speed on one core; at 50x the bot's own wall-clock waits (confirmation windows, sleeps between steps) start to break
and fidelity drops, so 20 is the setting. Only 148 commands paired by start state because the front end has no world clocks and no block
updates yet (leaves never decay, vines never fall), so its world drifts from the recording; those are the next rules to move in. The
prototype is JavaScript; the server rules it needs (supports, vines, falling blocks, placement, dig acceptance) already exist in Rust in
`tools/sim` and move behind a pipe when it is built out (`forgeaip-sim serve`), with the RCON commands the tests use for setup and grading
(`fill`, `clone`, `execute if blocks`, `give`) — about 25 commands (stage-A count). Not yet: block states from the look (stairs, logs and
slabs are placed in their default state), entities other than players (item drops, mobs), fluids, light, hunger, containers.

**What it lets you test, and how fast**: every T26 test runs the same code it runs on the server; a place_b re-play takes 206 s instead of
612 s, and a world needs no server (no 54 s world start; memory not measured). With setup and grading commands added, the whole T26 suite
(pit, build, movement) can run on it; movement tests over 2,000 blocks need generated terrain the recording does not have (a region-file
reader exists in `tools/sim`: the world's own region files are the source).

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
# the same re-play on the front end (no server; capture once per version with scripts/sim/capture.js)
docker run --rm --name sim-front --network none -v "$PWD":/app:ro -v <node_modules>:/app/node_modules:ro -v /mnt/data/forgeaip-play/t26/out:/out -w /app \
  -e TRACE=/out/simrec/pb-r2 -e SIMREC_DIR=/out/simrec/pb-r2-front -e CAPTURE=/out/simrec/capture-1.21.1.jsonl -e SIM_SPEED=20 -e MC_PLATFORM=fabric -e MC_VERSION=1.21.1 \
  -e BOT_REGISTRY=vanilla -e TEMP_BLOCK=pumpkin -e SYNCMATICA=0 -e DISPLAY=0 node:20-slim node --require ./scripts/sim/record.js --require ./scripts/sim/front.js scripts/sim/play.js
```

Trace format (`format: 1`; shared with TASK-076, whose `src/native/trace.js` adds the per-tick `tick` line): `hello` (format, recorder, bot,
version, minY, height, dim, difficulty, gameMode, temp, native, world, run, speed, ms), `st` (state id, name, properties), `chunk` (u16 state
ids, deflate, base64, index ((y - minY) * 16 + z) * 16 + x), `blk` (ms, tick, cell, state id), `cmd` (id, ref, layer, name, args, atomic,
maxTicks, env, recMs, ms, tick, before), `res` (id, ms, tick, ok, reason, detail, ticks, wallMs, phases, after, trace), `spawn`, `death`.
