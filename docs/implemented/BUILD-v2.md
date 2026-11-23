# BUILD-v2: the structure builder rewritten from scratch for survival crews (walking, pillars, clicks a vanilla client can make)

`TASK-20261121-073` (owner 2026-11-21): the Litematica build of the creative Fabric 26.1.2 server was "completely unusable" (docs/implemented/BUGFIX-20261121-072-litematica-creative-run.md), so the structure-building code was written again from nothing, in its own package `src/build/`, and is judged on new random natural worlds by the server.

## What the owner asked for

- Build `iron-farm-34.litematic` (Overworld) and `iron-farm-34-nether-side-main.litematic` (in the Nether) completely, every block right (entities excepted), on a new random-seed world with natural terrain each time, Peaceful.
- The only setup: the materials in shulker boxes inside a chest. No other help.
- Fix causes, not symptoms; repeat until the success rate is 100 %. Time limit 240 hours. Free the test servers afterwards. Work in parallel.

## The approach in one paragraph

The crew is creative (the owner's server is creative). A creative player flies and can place a block into an empty cell from anywhere within reach: the use packet names the target cell itself, the server sees air there and replaces it. So there is no temporary block, no support, no scaffold, no walking: the order of placement is free except for what vanilla itself requires (a repeater needs a floor, a wall torch its wall, a double chest its partner), and every state is reached by choosing the clicked face, the look and sneak exactly as vanilla's `getStateForPlacement` reads them. The builder never trusts its own action: after every batch it reads each cell back from the server's updates, and a survey of the whole box decides what is left after every stage.

## Verified facts the design rests on

| Fact | How it was shown |
| :-- | :-- |
| A creative bot flies by position packets with physics off; the server corrects only moves into blocks | `scripts/t26/fly_probe.js`, server position read back by RCON |
| A use packet on an air cell places the held block there (no neighbour), with the state the face and look decide | `fly_probe.js` (stone, hoppers by face, observer and piston by look) |
| The server applies a new look (and sneak) one tick after it arrives: a use sent in the same tick is judged with the previous look | `scripts/t26/look_probe.js`: 0 of 24 right in the same tick, 24 of 24 one tick later |
| The placement rules of `src/build/rules.js` give every block state of both blueprints | `scripts/t26/rules_probe.js`: 153 of 154 distinct states right; the one left is the probe's (a right chest half alone is single by definition; the left-half test places the pair and passed) |

## Code (`src/build/`)

| File | Job |
| :-- | :-- |
| `state.js` | block states: which properties the builder decides (facing, half, type, delay, note, open ...) and which the world decides (power, connections, lit, extended, occupied, instrument); `matches`, `dynamicPair` (a piston head or a flow the circuit makes); `normalise` (a block saved in motion becomes the block it carries; beds unoccupied); the item for a state |
| `rules.js` | the recipe of a state: item, clicked face, cursor, look, sneak, clicks after placement, dependencies; one rule per vanilla block family |
| `target.js` | the box in world coordinates, every cell's target (air included), recipes, portals (one lighting each), the item list |
| `survey.js` | the box against the target, read from a bot's view: `seal` (fluid outside next to the box), `fill` (fluid inside that must go), `clear`, `place`, `fix` (clicks only), `pour`, `ignite` |
| `job.js` | one build shared by the crew: stages, claims (a station and the tasks it reaches), readiness (order rules), failures, parking, rounds, the stall breaker |
| `drive.js` | one bot: claim, fly, do the batch grouped by look, clicks, read back, report; pours along a ray the server traces itself; portal lighting; the supply read |
| `fly.js` | where a body fits, A* through free cells (26 neighbours, no corner cutting), tunnels through terrain when there is no free way, motion by position packets |
| `act.js` | the hand: creative slots, aim (one tick), use, dig, use item, read back |
| `supply.js` | what the materials containers hold, shulker boxes included (their `container` component), without moving anything |

The work console runs it as the job kind `construct` (`src/work/service/construct.js`); `createBuildFromPlacement` (the Litematica page) picks it when every bot of the crew is in creative mode (`_builderFor`; `spec.builder` overrides), the old builder (`src/work/builder/`, `jobs/build.js`) stays for survival crews.

### Stages

1. **prepare**: fluids outside the box next to it are sealed (a block in the fluid cell, outside the box: the only cells outside the box the builder changes), fluids inside are filled, then every block that must go is broken, top-down and never next to a fluid.
2. **place**: every block by its recipe, bottom-up within a window of three layers above the lowest open one; a block waits for its dependencies (its support, the RIGHT half of a double chest before the LEFT one, the cell an observer watches, the block under a note block); clicks (note, delay, mode, open) right after the block, with an empty hand.
3. **late**: lava sources poured along a ray to a solid neighbour's face (the bucket's ray is the server's), portals and fires lit with flint and steel.
4. **settle**: four seconds, then one more survey: nothing left means done. Every survey sees the whole box again, so a cell spoiled later (a piston push, a fallen block, a mob) is work again.

A cell that fails eight times is parked; parked cells get three more rounds; a stall of 40 s (work left, nobody holds any, nothing ready) relaxes the order rules until the next survey.

### Items in creative mode

A creative player takes an item from the creative inventory (pick-block does the same). The builder does that for every item type the tagged materials containers hold (loose or inside shulker boxes, which are read where they lie and never moved), and only for those: a type the containers do not hold is parked and reported as `missing_item`. The containers are not changed.

## The test (`scripts/t26/build_t.js`)

`scripts/t26/up.sh N --new` (a new random seed), then `scripts/t26/run.sh N build_t.js LITEMATIC=/app/tests/fixtures/<file>.litematic [DIM=nether] [BOTS=8] [LIMIT_MIN=n]`. The harness picks a site 40-100 blocks from the spawn (in the Nether near the spawn's Nether coordinates, at a random height 40-80), puts the box's bottom at the ground height (Overworld, ±2), puts the materials into shulker boxes in a double chest on the ground beside the box, puts the bots on the chest in creative mode, tags the chest `materials`, and creates the job through the service (`createConstruct`). The judge compares the box with a reference copy made by commands (`execute if blocks`), finds every differing cell by halving and tests each against the blueprint's decided properties; a trial passes when the job ends by itself and no cell is wrong.

## Results

(see the section at the end, filled in as runs finish)


## 2026-11-21 night: the premise is survival (owner)

The first version above ran on creative mechanics (flight by position packets, creative-inventory items, instant breaking, use packets into air cells). The owner's premise is full
survival without cheats; that version was removed and everything that moves, digs, places or fetches was rebuilt. What stayed: the blueprint model (`state.js`, `target.js`, `survey.js`,
`pistons.js`, the server-side per-cell judge).

| File | Survival job |
| :-- | :-- |
| `vanilla.js` | vanilla's placement rules as a forward model (clicked face, hit point, look, sneak, neighbours -> state) |
| `place.js` | the click search: a face of a neighbour the eye sees FIRST along the ray, within 4.4, that gives the wanted state; live 153 of 154 states (`scripts/t26/place_probe.js`) |
| `move.js` | the mover: plan over standing cells (walk, step up, drop <= 3, pillar, bridge leaning over the edge, dig through, swim), no cell beside or over lava; a path follower on the bot's own physics; searches yield to the event loop |
| `supply.js` | materials by count from the tagged containers; shulker boxes set down as a depot beside the chest (facing up, never stacked), taken from like chests, put back at the end (`repack`) |
| `job.js` | claims: a stance from which the click or dig works (pillar or bridge supports, stances inside rock to be cleared), up to 64 tasks per stance; clearing waits only for the nine cells above; placing overlaps clearing once a cell's neighbourhood is cleared |
| `drive.js` | one bot: supply trips (rubble dropped first, items out of stock only when no container holds them), claims, work, deaths logged, the depot repacked at the end |

Measured on the parallel T26 batches (scripts/t26/batch.sh, 3 Overworld + 3 Nether worlds at a time): digging 0.23 s per block after the tool fix; clearing 8 000-18 000 blocks in 27 min for
an Overworld site; placing still slow (best 27 blocks in 27 min, 2026-11-22 ~05:00 JST): no survival build has finished. Causes found and fixed are in git log (`TASK:20261121-073`).
Deployed to the three fabric26 consoles after each fix (`docker compose -f /mnt/data/fabric26-worlds/compose.yaml restart console-creative console-survival-hard console-survival-op`).

## Handover 2026-11-22 23:40 JST (session ended by the owner; the next one starts from the owner's list of problems)

**Where it stands.** No survival build of either blueprint has finished. 93 commits (`git log --grep TASK:20261121-073`) found and fixed one cause at a time over about 24 h of parallel batches;
the owner judged that inefficient and stopped the loop to give all problems at once. Deaths went from 4-8 per world per batch to 0-3; clearing works (8 000-14 000 blocks in 27 min per
site); placing is the bottleneck (best 141-474 blocks in 27 min, mostly far less). Unit tests: `npm test` green 2026-11-22 (+ `tests/test_rcon_pure.js`, `tests/test_modules_load_pure.js`).

**Test servers the owner watches (left running, survival premise unchanged).** T26 worlds on the tailnet, port 25590 + N (ViaVersion lets the 26.3 client in):

| N | port | blueprint | box (min corner) | run log (/mnt/data/forgeaip-play/t26/out/) |
| :-- | :-- | :-- | :-- | :-- |
| 1 | 25591 | easy-ironfarm-fixd (2 bots, traced) | -13 88 -79 | scratchpad tr26.log of the old session |
| 2 | 25592 | iron-farm-34 (8 bots) | 254 68 203 | sT2-w2.log |
| 3 | 25593 | iron-farm-34 | 195 74 180 | sT2-w3.log |
| 4 | 25594 | nether-side-main (Nether) | -112 50 -11 | sS2-w4.log |
| 5 | 25595 | nether-side-main (Nether) | -59 66 42 | sS2-w5.log |
| 6 | 25596 | nether-side-main (Nether) | 69 67 -47 | sS2-w6.log |

The harness ends a run after LIMIT_MIN = 200 min (Overworld/Nether) or 120 (world 1) and then judges every cell; the server stays up until `scripts/t26/down.sh N`.

**Operator.** Only the owner, `Seia_Y`, by the offline-mode UUID of the name (734c8e10-06c7-37ad-9971-6f79965693a1): `scripts/t26/up.sh` writes `ops.json` into the world's volume before the
server's first start; no `OPS` env (the image resolved it at Mojang and opped another account), no Mojang lookup, `online-mode=false` (players are identified by name). Nothing manages
operators while a server runs.

**Watching a run from its start.** `WAIT_FOR=Seia_Y` (build_t.js, or `WAIT_FOR=Seia_Y scripts/t26/batch.sh ...`): the site, the chest and the crew are set up, then the build waits until
that player is on the server; the run's time limit counts from the start of the build. The harness says the site and the chest coordinates in the log and in chat.

**How to run and deploy.** `scripts/t26/batch.sh RUN "2 3" "4 5 6"` (Overworld on the first list, Nether on the second; new random world each), small traced run:
`scripts/t26/up.sh 1 --new && scripts/t26/run.sh 1 build_t.js LITEMATIC=/app/tests/fixtures/easy-ironfarm-fixd.litematic BOTS=2 LIMIT_MIN=120 RUN=x BUILD_TRACE=1`. Progress lines every minute
carry `time {walk,dig,place,trip,idle,claim}`; `claims in the last minute: {...}` says what claims returned (work / need X / nothing); `claim by ...` gives why tasks wait (every task by the
cheap reasons); a death logs the bot's last eight moves. `PROFILE_AT=12` writes a CPU profile to out/prof/. Deploy to the three consoles ONLY with `scripts/t26/deploy-consoles.sh` (it loads
every module first; an unparsable drive.js took the consoles down for 30 min on 2026-11-22).

**Open, as last measured (worth checking first).**
1. Idle crews with work left: world 2 had `{"nothing": 445}` claims a minute (no ready task found) with 7 500 blocks to place; the frontier layer's cells wait on each other or have no stance.
2. Placing in the air: lean-over-the-edge clicks and scaffold blocks exist (`_scaffoldFor`, `lean`), but few such cells get done; blocks on torches/wire now click the outline (untested at scale).
3. Nether: falls into the lava sea and pits remain possible (3 deaths on world 5); routes are re-checked live, digging under a crew member is refused, leaning keeps 0.2 on the block.
4. Supply: scarce items (redstone torches, levers, hoppers) run short across 8 bots; the depot of shulker boxes can fail in cramped caves (logs say which fallback failed).
5. Speed: walking dominates bot time once claims work; long tunnels/pillars cost the most.
6. Docs: the creative-era sections above are history; the survival design is the 2026-11-21 night section and this handover.

## Owner's problem list 2026-11-23 (commit fcdb79ca)

Causes taken from the live runs `watch-w2.log` / `watch-w3.log` (25592, 25593), then fixed:

| # | Problem | Cause found | Fix |
| :-- | :-- | :-- | :-- |
| 1, 8 | jumping onto redstone, stuck | the planner pillared from a cell holding built wire; the server refuses a block there | `View.placeable`: pillars and bridges only into replaceable cells, stance pillars checked in `claim` |
| 2 | temporary blocks everywhere | walking pillars and bridges were taken away only in the last stage | `Mover.unpillar` digs its own pillar down when it leaves; `job._offerTemps` makes unused walking blocks untemp tasks in every stage; scaffolds (placement supports) unchanged |
| 3, 9 | stances shift a few cells, bots crowd one corner | seeds by global height, no ownership | `job.sectorOf`: one ground-plan piece per bot (kept), own sector first; `job._deepen`: a clear claim takes everything in reach top-down |
| 4 | only ~3 bots drawn | the first bots' paths took the path cap | equal share per bot, 48 cells ahead; sectors drawn at the frontier |
| 5 | ping | long synchronous searches | plan yields every 500 nodes; progress line shows event-loop `lag max / p99` |
| 6 | powder snow | walked into and sank | powder snow is an obstacle that is dug; `unsink`; `build_t` refuses sites with powder snow in the footprint + 8 |
| 7 | no reasons visible | — | chat lines `[stuck] [idle] [wait] [supply] [evacuate]` (once per state, repeated every 2 min; `BUILD_CHAT=0` off) |
| 8 | whole crew waiting | a window read empty marked items out of stock for 10 min for everyone | empty windows re-read; "absent" only when every container was seen; 3 min |
| 10 | one stuck bot holds all | — | 4 min without progress while there is work: evacuate (claims released, out of the footprint with loose rules); 3-min deadline per claim/trip; chest wait at most 90 s |

### Part 2 of the list (same day) and what the live runs fy1-fy4 showed

| Problem | Cause | Fix |
| :-- | :-- | :-- |
| tall pillar everyone climbs | `escape` went to the top of the 60-high box; untemp tasks at -3000 pulled the crew onto leftover pillars | escape sideways (>= 3 cells, same height); a stance with no way is avoided at once (3 min), closed-in is decided by the search (< 80 cells), not by a count of failures; untemp only from a standing stance, after real work |
| sneaking everywhere | every cell beside a 4-drop was walked sneaking | only at the end of a run or a turn beside a drop, or next to lava |
| pushing at a cliff start, stacking in one cell | plans went through other bots; several pillared the same column | no plan through another bot's body; a pillar column is reserved 20 s; waiting/idle bots keep 2 cells apart, off edges |
| no bridging from a Nether cliff | the estimate priced a bridged cell at a walk (46 vs 4.6) | weighted estimate (x2.5 toward a goal in the air) |
| rubble picked up again | thrown where the bot then waited | thrown away from the next stance just before walking, at most every 30 s |
| one block per stance | the batch held only what was ready at claim time | `job._widen`: every block in reach whose supports stand or are earlier in the claim |
| dug out around itself | deep clearing took the floor ring | never the ring around the stance or below the floor |
| Nether deaths left the crew in the Overworld | no respawn point | a respawn anchor + glowstone in the chest; one bot sets it down and charges it, every bot sets its spawn (8/8 on three worlds) |
| overlay missing | test runs drew only with WAIT_FOR | on by default (DISPLAY=0 off); runs start without waiting for a login |
| found live | idle crews: lowest cells without a stance held the window; untemp under feet hid the stall; a hot step-off loop froze all bots 17 s; lava regions cached before their chunk loaded (8 bots into lava); claim and dig checks were most of the CPU in the Nether | all fixed (git log TASK:20261121-073, 2026-11-23) |

Measured (fy runs, 2026-11-23): Nether event-loop p99 868 -> 89-365 ms, blocks of 1.5-28 s gone; world 3 placed 515 blocks in 41 min (best before: 474 in 27 min); no build finished yet. Open: Nether placing is slow (chests and hoppers run short, cells over the lava sea); placement in the air; the builder's remedies are still its own rules, not the command-stack router.

### Part 3 of the list (2026-11-23 morning) and the runs fz*-ga*

| Problem | Cause | Fix |
| :-- | :-- | :-- |
| comparator facing never right | the look was the eye's ray to the hit point; at an angle it gave the wrong horizontal | flexible placement as Tweakeroo does it on a vanilla server: an exact rotation (a cardinal, level or near straight up/down) sent with the click when the natural look does not give the state; live probe 153/154 states, 36/39 exact-look placements right (the rest: the known right chest half, a gate's open click) |
| unmined areas at the edges | stances inside rock were allowed only in cells to clear | stances may be dug into natural terrain outside the box; covered cells are not re-checked for 2 s and blocks above the window are skipped in every stage (the 60 ms scan ran out before the ready cells) |
| Nether crew into the air at once | stances outside a lava-ringed pocket offered again and again | a searched-out plan gives the cells a bot can reach; claims offer only stances among them; with nothing there the bot leaves the pocket (once; then 2 min back-off) |
| sinking and floating in the sea | the breath reflex swam up while the builder's plan dived | the fall and breath reflexes are off for builder bots (lava and fight stay); swimming under the surface costs a dive |
| found live | 22 lava deaths: temporary blocks holding back lava were taken away; a stall's relaxed order dropped the fluid rule; lava pockets sealed in rock could not be filled; one bot took all scarce items; one dirt beside 400 cobblestone made pillars impossible; bridges rebuilt 2 230 times | untemp never beside a fluid, the fluid rule survives relaxing, sealed lava is opened from above and filled through the hole, fluid tasks are never parked, the fair share per trip, the temporary block is the plain block carried most, temps kept 90 s after last use, the stall rule applies while at most one bot works, a parked dependency does not hold a block |

### Runs gb-gh (2026-11-23 06:00-10:40): what the live runs showed after list 3

Each line a cause found in a run and its fix (git log TASK:20261121-073): chained bridges (the plan stood on its own temporary block), falls up to five for a healthy bot; bridges
over deadly falls only at a cost and walked sneaking; the weighted estimate toward goals in rock; stances outside one bot's reach count nothing against a cell; walls clicked on
their 1.0 outline; the plan digs a step up (a bot without blocks in a hole); the place window four layers; fluid tasks never parked; a cover with no stance for 20 s, or waiting
only on a fluid beside it, does not hold the cells under it; a pillar that failed is not planned in that cell for two minutes; items the chest is out of are handed back by
bots that do not need them; a trip takes what the bot's sector needs for eight layers; untemp always after the real work and never while ready blocks wait for items;
escapes never dig a block holding back a fluid; lava that can run within two of a clearing batch drops the claim; bamboo and dripstone around a bot are cut (their
random offset wedged the crew).

Best rates seen: Overworld iron-farm-34 52 blocks/min (gg1 w2, 883 in 17 min), clearing 26 000 blocks in 40 min. No build has finished yet.
