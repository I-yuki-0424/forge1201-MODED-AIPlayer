# ACCEPTANCE-v1: the completion conditions of the command stack, verified on a random-seed normal world (2026-11-12)

`TASK-20261112-062`, part 2. The owner's four-part acceptance of 2026-11-12 for [COMMAND-STACK-v1](../implemented/COMMAND-STACK-v1.md): a strip-mined and backfilled chunk, a 2000-block walk out and back, a 64-item gathering run, and an iron-block placement 500 blocks away that needs a craft first. This document fixes how each is graded, what is built for it, in which order, and how "retrain the experts as needed" is decided.

## The world and the rules (owner)

A freshly generated normal Overworld (random seed, difficulty peaceful, the play world's mod set not required for the test) on a disposable server; the only changes allowed from the initial state are a chest of tools and a chest of cobblestone, both tagged. The tools are command-generated and extremely efficient (to save time). Bots are the work console's own (`WorkService`), commanded through the console API as the owner does: jobs for 1, `journey` / goals for 2 to 4. Everything is graded from the SERVER's state (`/fill`, block and item counts, positions), never from a bot's report.

## Grading (interpretation fixed here; the owner's wording in quotes)

1. **Strip-mine, backfill, `/fill`.** "Strip-mine the starting chunk": a pit job over the chunk containing the spawn, from the highest surface in the chunk down to y -59 (bedrock is at most y -60 and cannot be mined). "Run the Fill command. If no target is found, this side succeeds": the server's `/fill <box> minecraft:air replace <block>` for every non-air block name left in the box reports `Could not fill` / `No blocks were filled`. "Backfill and run Fill again": a build job fills every cell of the box with cobblestone; then `/fill <box> minecraft:air replace minecraft:cobblestone` must report `Successfully filled N blocks` with **N = 16 x 16 x height**, height = top - bottom + 1 of the box. (The `/fill` is run on a copy of the final state, or its effect is undone with the opposite fill, so that the world is left as the bots made it.)
2. **2000 north and back.** Starting from the initial point, to z - 2000 (same x), then back; arrival within 4 blocks across and 3 levels of the target, then of the initial point, by the server's position; no death, no server move (`teleport` off).
3. **64 / 64 / 64 / 64.** From the initial point: 64 logs (any wood), 64 cobblestone, 64 stone made by smelting cobblestone, 64 iron ingots made by smelting raw iron; counted in the bot's inventory and its containers by the server (`clear <bot> <item> 0`).
4. **Iron blocks 500 south.** The 64 ingots become iron blocks (7 blocks, 63 ingots) and are placed 500 blocks south of the initial point. "If you give the instruction to place iron blocks, the router should see that there are no iron blocks, craft them first": the instruction sent is `place iron_block` at a cell 500 south; the chain `craft ... -> travel -> place` is the router's.

Negative controls: a run with nothing sent must score 0 on every check; the `/fill` check must fail on the initial (unmined) chunk.

## What has to exist (gaps found on 2026-11-12)

| Need | State today | To build |
| :-- | :-- | :-- |
| A random-seed disposable world with the tools chest and the cobblestone chest | the real-world copy copies the play world; `rl-server` is flat | `scripts/accept/world.sh up|down` (fresh volume, no seed given, peaceful) and `setup.js` (the two chests, tagged, command-generated tools) |
| Strip-mine of one chunk with only a tools chest and a cobblestone chest | pit jobs exist; their upkeep expects ore / trash / food chests | a run on exactly that setup, causes fixed as found |
| Backfill of a box with cobblestone | layout jobs (floor, wall, room walls) | a volume fill (every cell of the box), resupplied from the cobblestone chest |
| 2000-block walk and back | `journey` in legs, `env.travel` | measured; causes fixed as found (chunk generation of a fresh world, water, ravines) |
| Goals above single instructions: "have N of X" with recipes (logs, planks, table, furnace, cobblestone, smelting with fuel, iron ore -> ingot -> block) | `gather` collects blocks; `craft` and `smelt` instructions approach tables and furnaces by themselves | router rules: `item_in_pack` unmet -> craft sub-goal (station placed if none in reach) -> instruction; preconditions for `craft` / `smelt` / `place`; a goal layer at the top |
| Iron within reach of the start | gather digs at most 4 blocks into rock | measured on the world; the strip-mined chunk exposes the ore |

## Retraining "as needed": decided by measurement, not by assumption

- The experts wired live are `move` and `unstick` ([EXPERTS-v1](../implemented/EXPERTS-v1.md)). They act through `move_to`, `mine` and `tunnel` on the non-atomic path, which this task did not change; their live evidence is [REAL-WORLD-VERIFICATION-v1](../implemented/REAL-WORLD-VERIFICATION-v1.md) (movement target >= 80 %, escape >= 90 %).
- The item experts of MOE-v2 and the learned router have never run live, and their observation has no live port. They were trained on the simulator's semantics (a short walk is part of `mine`); under atomic instructions that is wrong, so they are NOT used by this acceptance. The rules (the teacher, `moe/solvers.py`, 0.88-1.00 in the simulator) are ported into the router instead.
- Procedure: (1) after the stack is complete, measure `move` and `unstick` on the real-world copy (`scripts/real/real_move.js`, `real_escape.js`) with the new build; a rate under target means retrain that expert on the PC (simulator, WSL2, nice 10, owner's permission given 2026-11-12) with the cause fixed; (2) the simulator gets an atomic mode (`mine`, `place`, `activate`, `attack`, `craft`, `smelt` fail instead of walking; the held item is state) and the item experts are retrained against it on the PC in parallel with the live work, to be wired only where the real-world copy shows them beating the rules. Their results are reported as what they are: simulator numbers.

## Order

1. Finish the A/B of `mine` / `place` on the real-world copy (running) and fix what it shows.
2. World script and setup; negative controls.
3. Test 2 (walk out and back): the cheapest, finds the transport problems first.
4. Test 1 (strip-mine, `/fill`, backfill, `/fill`).
5. Goals, recipes and the router rules for craft / smelt / place; tests 3 and 4.
6. Regression of `move` / `unstick`; retraining where needed; simulator atomic mode on the PC.
7. Deploy to the play console (restart: about four minutes of lost work, so after everything else), then the four tests in one run on a new world, from the initial state.

## Status log (updated as work proceeds; everything graded by the server on Fabric acceptance worlds, `scripts/accept/`)

World tooling: `/mnt/data/forgeaip-play/accept/up.sh N [--new]` (a Fabric 1.20.1 server per number, random seed, peaceful, about 2.8 GB each, ports 25581+), `scripts/accept/run.sh` (`ACC=N`), `scripts/accept/dryworld.sh N` (rerolls the seed until the starting chunk is dry land: a beach or sea chunk is underwater digging, a different problem). Tests: `t1_chunk.js`, `t2_walk.js`, `t3t4_items.js`; probes `probe.js`, `swim_probe.js`; the real-world movement and escape harnesses run on these worlds through shims.

| Item | State (2026-11-13) |
| :-- | :-- |
| `mine` / `place` A/B on fresh copies of the play world (8-40 blocks) | old code 19/20 and 19/20, new code raw 19/20 and 19/20, router 19/20 and 19/20: no measurable difference at these distances (Wilson intervals [76, 99]) |
| Test 2 (2000 N and back) | four causes found and fixed, each with a test that fails on the old code: leg targets inside caves under hills; legs ignoring what the planner can reach (now the frontier of its reach, bounded exploration); a sea (legs now end on the water surface, `move_to` accepts it); drowning cancelling an operator command. Not yet passed: world 7 (spawns on an island, 1100+ blocks of open ocean) ended `stuck` at z -1295 in deep water; a land world has not been run to the end with the final code |
| Test 1 (strip-mine, `/fill`, backfill, `/fill`) | passes at 4 x 4 x 8 (6/6 checks: pit finished, masked compare clean, backfill, `/fill` = 128) on a dry world. Full chunk NOT passed: the pit stalls in steep natural terrain (see below). A janitor bug found on the way is fixed (no tagged container takes cobblestone: every surplus was a failing deposit, 309 failures) |
| Tests 3 and 4 (64 x 4 items, iron blocks 500 S) | goal layer built (`obtain`: gather, smelt with fuel, craft with stations; exploration on rings for trees, staircase + tunnel for ore; `place` of an item not in the pack makes the router obtain it first). At 8 of each it found three more causes (nothing within gather's reach: no trees within 64, iron deeper than 4 blocks; the router calling a bot in its own tunnel stuck) now fixed; the small run has not yet completed; the full 64 / 500 run has not been done |
| Expert measurement (retrain decision) | movement on a Fabric world: 24/30 = 80 % (Wilson [63, 90]) before the travel fixes (three of the six failures `stuck` at sea level), **29/30 = 97 % (Wilson [83, 99]) with the final code** (distances 20-150, one `cancelled` at 18 s; seed 21, world 6; target 80 %). Escape: 16/20, but 3 of the 4 failures are the expert's own 3-minute cool-down after two failures (`refused`), i.e. a harness artefact; without them 16/17 = 94 % at a 120 s limit. No retraining is justified by these numbers. The item experts and the learned router stay unwired |

### Open: the pit in steep natural terrain

On world 4 (a mountainous start, box top y 116, bottom -59, 8 bots, `expert` method) 175 of 528 units finished before every bot stood waiting. Chain, from the problem log: units fail `unreachable` at `expert_station` ("could not stand at the station", the bot 2 blocks from it) or `station` ("too far from the station to dig a corridor toward it", the bot at the surface and the station 30+ levels down); after 60 s of such errors the console's own forced kill (`forceKill`) kills the bot, which drops its pack (tools included) and respawns at the world spawn, inside the box's column at the surface, over a pit now too deep to walk into (no haul road for the `expert` method, teleport off); 22 forced kills drained the tools chest and the remaining bots wait for a tool nobody can make. Candidates, not yet separated: the station model placing stations on cells the bot cannot reach in uneven terrain; the respawn-at-spawn loop; `road: true` for deep boxes. The same mechanism explains the beach chunk failure earlier.

## Not claimed

Nothing in this document has been measured yet. Rates from the simulator are never evidence (CLAUDE.md, verification standard).

### Status 2026-11-13 (tests 2, 3 and 4 run on Fabric acceptance worlds; everything graded by the server)

| Test | Result | Evidence and limits |
| :-- | :-- | :-- |
| 2: 2000 blocks north and back | **Passes on world 7 with the tools chest's tools in the pack: 3 of 3 checks** (out 728 s, back 815 s, 0 blocks off, no death, no server move). Out leg bare-handed: world 2 passed 5 of 5 (692-804 s, 0 off, across sea and mountains), world 6 1 of 1, world 7 failed once (stuck at z -1625, 369 short). **The way back fails on world 2** in a basin around z -460 to -570 (3 of 3 bare-handed, and with tools) and on world 1 (a mountain at the target, 10-25 blocks short) | Defaults: bare hands (`TOOLS=1` for the tools): with tools the movement expert dug and one outward walk ended 40 levels underground until the expert was kept from aiming more than five levels down. A bot that spawns on a tree canopy (world 6, y 81) cannot get down: its legs wander on the leaves (not fixed) |
| 3: 64 logs / 64 cobblestone / 64 smelted stone / 64 iron ingots | **Passes on world 4 in a run that started with 64 raw iron given (`GIVE_RAW=1`)**: server count 64 / 64 / 64 / 64. Wood, cobblestone and smelted stone pass on worlds 3, 4 and 5 in several runs. Mining the 64 raw iron by the goal layer alone worked in separate runs (64 or more in the pack on worlds 3, 4 and 5, 12 to 60 minutes) | **No single run has done the mining and everything after it yet**: deaths (5 of 7 drownings in flooded shafts, 2 suffocations; the breath reflex was added late) and the long mining time stand in the way. The earlier "no trees in 2400 s" and "iron unreachable" are fixed |
| 4: 7 iron blocks 500 south | **Passes on world 7 (7 of 7, run alone with 64 ingots given) and on world 4 in one of three runs**; the other world-4 runs failed on a shoreline target row (first block: `line_of_sight`, no usable support) and on "no free cell" for the crafting table (fixed afterwards, not re-run there) | The row is chosen as seven usable columns near z + 500; the instruction sent is `place iron_block`, the router crafts, walks and places |
| 1: strip-mine | not run in this session: the owner builds the chunk first (build world above) | |

Causes found and fixed on 2026-11-13, each with a test that fails on the old code (commits `TASK:20261112-062`): a swimming bot bobs between two cells and the goal needed the exact one (every sea crossing ended stuck in its first leg); a walk ends within 3.3 cells and the expert is not sent toward a summit within 6 blocks; 300 legs instead of 80; legs that go down more than 10 levels are tried last; a leg does not end in a dead end; an enclosed walk digs a staircase up; gather gives up after three unreachable picks, remembers failed picks for ten minutes and works only ore the router can stand at (its own `standCells` inside the planner's reach); an out-of-range drop no longer fails a mine that already broke its block; the tunnel precondition asks for the first cell's tool only; prospecting walks open steps and drops, waits out "not standing on ground", steers to visible ore, stays underground, retraces its own trail and uses another site after a failed shaft; the way back ends on the entry's column; smelting asks for one batch and one kind of fuel; stations are reused only within 5 blocks and placed on the beach's own levels; place steps out of the target cell; a reflex-stopped instruction is asked again; the breath reflex; the router's escape digs out.

Open: one run of all four on one world; the way back across the mountain basin of world 2 (the bot cannot climb ledges it dropped from); drowning and sand-fall deaths in deep shafts; deploy to the play console (restart: the owner has removed bots and jobs, so nothing is lost).

### The test-1 build world (owner request 2026-11-13: build the starting chunk by hand, run test 1 on it as the initial state)

Join it with a Minecraft 1.20.1 client (vanilla or Fabric, no mods) at **`100.77.246.23:25580`** (tailnet only; operator `Seia_Y`). It is a persistent Fabric world, not a disposable one: `/mnt/data/forgeaip-play/accept/t1.sh up | down | status | snapshot [label] | list | restore <label>` (a snapshot is taken before every `down` and `restore`; `initial` is the untouched world). Files: `compose-t1.yaml`, `t1-datapack/` (own local git repo).

| What the owner asked | What was done |
| :-- | :-- |
| Remove the randomness of the spawn point | fixed seed `4370349159688736012` (stored in `t1.seed`); `gamerule spawnRadius 0`; world spawn at **-16, 67, -48** (the chunk corner of chunk -1,-3). Every player, bot and respawn appears on that one block (a bed overrides it for a player) |
| A chest that supplies cobblestone and the tools forever | a chest at **-19, 66, -44** (outside the spawn chunk, so the strip-mine does not dig it up). A marker entity (`forgeaip_supply`) stands in it and the datapack `forgeaip` re-stocks it every 0.2 s: slots 0-5 netherite pickaxe, axe, shovel, sword, hoe and shears (unbreakable, efficiency 255), slots 6-26 cobblestone 64. Anything taken is back within a fifth of a second (tested: slot emptied, back after 1 s) |

Moving or adding chests: stand where the chest should be and run `/function forgeaip:supply_chest` (places a chest and its marker; as many as wanted). To move one: `/kill @e[type=marker,tag=forgeaip_supply,limit=1,sort=nearest]`, break the chest, run the function at the new spot. Keep each chest outside the box that will be strip-mined. The chest only works while its chunk is loaded (always the case near the spawn or any player or bot).

Running test 1 on it afterwards (the harness reads the world, creates and tops up nothing): `ACC=0 PREBUILT=1 scripts/accept/run.sh t1_chunk.js METHOD=expert LIVE_OUT=/out/t1_prebuilt.json` (the box is the chunk of the spawn; the chests are found through the markers and tagged as tools and cobblestone chests). Take a `t1.sh snapshot` of the finished terrain first: the run changes the world.
