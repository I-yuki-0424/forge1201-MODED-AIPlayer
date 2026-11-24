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

## Handover 2026-11-23 13:30 JST (session ended by the owner: "nothing has progressed")

**Where it stands.** Still no survival build has finished. Since the 2026-11-22 handover about 70 commits (`git log --grep TASK:20261121-073 --since 2026-11-23`) fixed the owner's three
problem lists and ~40 causes found live; the owner judges the result as no progress, and by the acceptance test (a finished, cell-correct build) that is right.
`npm test` green 2026-11-23 11:25; deployed to the fabric26 consoles (3031-3033 answer 200).

**Last batch gh1 (started 10:37, LIMIT_MIN 200, ends ~14:00), at 172 min:**

| world | blueprint | placed | place left | parked | deaths |
| :-- | :-- | --: | --: | --: | --: |
| 1 (25591) | easy-ironfarm, 4 bots | 1170 | 3 | 179 | 0 |
| 2 (25592) | iron-farm-34 | 1711 | 5530 | 495 | 0 |
| 3 (25593) | iron-farm-34 | 2724 | 4709 | 237 | 4 |
| 4 (25594) | nether-side-main | 917 | 155 | 127 | 3 |
| 5 (25595) | nether-side-main | 416 | 247 | 831 | 1 |
| 6 (25596) | nether-side-main | 202 | 900 | 299 | 1 |

World 1 is the closest: 3 blocks left, but the stage stays `prepare` because a clear task (192,85,-259) and its neighbours have no stance, and 179 cells are parked (torches,
wall signs, trapdoors, temp blocks in the air: "no stance reaches it"). Parked cells are retried only in the end rounds (`ROUNDS`), which never start while the stage does not advance.

**What to look at first (in this order).**
1. Stances for cells in the air over non-standable built blocks (walls, hoppers, glass, trapdoors): this is where the small farm ends and most parking comes from. `job.claim`
   rejects them as `unsupported` (no pillar column to ground, `_bridgeFrom` only straight lines). Needed: stances on pillars in neighbouring free columns, standing on built tops,
   bridges that turn.
2. The stage machine: a few clear tasks without a stance keep the stage `prepare` for good; parked cells should be retried while the build runs, not only in the end rounds.
3. Placing pace: place claims average 2-3 blocks; supply trips are a large share of bot time (one bot at the chest at a time).
4. Nether: sites over the lava sea / under lava ceilings clear safely now but place slowly; deaths 1-4 per run remain (lava).
5. The owner's architecture point: the builder's remedies are still its own rules in `src/build/`, not the command-stack router (`src/stack/router.js`).

**How to run.** `scripts/t26/batch.sh RUN "2 3" "4 5 6"` (no WAIT_FOR: the owner wants runs to start at once; display on by default, `DISPLAY=0` off) and for world 1
`scripts/t26/up.sh 1 --new && scripts/t26/run.sh 1 build_t.js LITEMATIC=/app/tests/fixtures/easy-ironfarm-fixd.litematic BOTS=4 LIMIT_MIN=200 RUN=x`. Per-minute log lines:
`claims in the last minute ... tasks per claim; place claims N: ready/doable/batch`, `[progress]` with `lag max/p99`. `PROFILE_AT=N` writes a CPU profile. Server death causes:
`docker logs forgeaip-t26-N | grep "Bd.. (tried|fell|...)"`. Probe of placement rules: `scripts/t26/run.sh N place_probe.js` (153/154, 36/39 flexible).
Logs: /mnt/data/forgeaip-play/t26/out/gh1-w*.log. Uncommitted `docker/bot.Dockerfile` and `docker/compose.yaml` are not this task's and were left alone.

## Owner's problem list 4 (2026-11-23 afternoon) and the batches ha1-ha6

Where the waiting came from (problem 5), measured on gh1 (`/mnt/data/forgeaip-play/t26/out/gh1-w*.log`): no movement by raw commands (the mover uses inputs; a pillar sends the vanilla
use packet). Three sources: the supply (trips 30-55 % of bot time on the Overworld worlds, one bot at the chest, 402 waits of 90 s on w3), the router's stances (873-5 436
"no way to" per world: the claim's picture of pillars and bridges disagreed with the planner's, a stance 3-4 cells away searched 30 000 cells in vain) and the division / window
(1.8-3 blocks per place claim: one global four-layer window held every part at the lowest open layer anywhere).

| # | Problem | Cause | Fix |
| :-- | :-- | :-- | :-- |
| 1 | stuck on a trapdoor | the pillar clicks the block under the feet without sneaking: a trapdoor opens | `Mover.pillar` sneaks when that block is interactive (`V.INTERACTIVE`) |
| 2, 3 | heaps of empty shulker boxes, one bot holds the supply | depot boxes were opened on every trip whatever they held, never taken away | depot entries carry their contents (`holds`); boxes without a wanted item are not opened; an emptied box is broken by the bot that emptied it, picked up and put back into the chest |
| 4 | placing by layers of areas | equal ground pieces; a global window; one trip per few layers | areas: k-d cuts of 4x4-column tiles weighted by work, each cut where both sides have little work in the same rows (`job._planSectors`); window per tile (`job.topAt`: lowest open layer of the tile and its 8 neighbours + 7, one stance's reach); a trip takes the whole area's bill (scarce items by share, beds at most 9) |
| 5 | standing still | see above | stances only among the cells the mover's own flood reached (`Mover.flood`, Dijkstra over the planner's moves); no stance in the air for a bot without temporary blocks; a trip that brought nothing makes the bot skip those items for a minute instead of waiting |
| 6 | first come at the chest | one lock for the whole supply | `enterSupply`: two bots at a time, the best record first (`job.merit`: tasks held - 2 x failures - 20 x empty trips, last ten minutes); one bot per depot box and in the chest (its window's slots go stale), boxes in parallel |
| 7 | old code still running | — | every fix: all worlds made new and every crew restarted (ha1 ... ha6) |
| 7' | crowding | no cap per area | at most two bots per area (`PER_SECTOR`); a bot with nothing goes to a bench off the box at the chest's height; Nether crews are two bots |
| 8 | temporary blocks at the end | walking blocks kept 90 s, scaffolds until the end | walking blocks taken 10 s after the last use (never while a bot is within four cells); scaffolds dug by the stance that used them as soon as no block beside them waits (`unscaffold`) |
| 9 | sample efficiency | one crew per world | `scripts/t26/multi.sh RUN "1 2 3 4" OW NE`: OW crews of 8 and NE Nether crews of 2 per world, each on its own site (`build_t.js CREW=k`); 16 crews overloaded the host (load 18 on 12 cores, plans ran out of time), 12 (2+1 per world, server 3 CPUs / 6 GB) run at load ~11 |
| 10 | visual checks | — | requested from the owner with coordinates (see the session report) |

Found in the batches themselves and fixed: concurrent withdraws moved whole stacks (1 152 smooth stone for 364; counting from the pack lagged the clicks: 14 pickaxes, 1 088 dirt
for one bot) -> whole stacks by shift-click counted by the click, a checked partial withdraw for small parts, surplus stacks handed back at the end of a trip; tools marked out of
stock because a box was busy (bots dug stone by hand); a bench reached by a drop in the Nether was a pit; parked cells now come back after 90 s while the crew finds nothing ready.

Measured at 20 min (ha5, before the last fixes): Overworld crews placed 535-1 445 blocks (gh1's best whole run: 2 750 in 200 min), trips about 10 % of bot time, 0 deaths, 0
evacuations, lag p99 80-120 ms. Nether crews: clearing 1 500-2 600 of 7 000-27 000 cells in 20 min.

Batches ha6-ha8 (each started after the fixes before it, every crew restarted): falls into the dug box came from routes over terrain other bots were clearing (no route stands on
a block another bot has claimed, no bot digs under another's current route) and from jumps off pillar tops (a step up at the edge of a drop of five costs six pillar steps); the
claim tried only twelve seeds, the same stance-less ones each time (they now go last); the harness took an ocean site after 30 failed draws (it refuses now). ha7 at 20 min: 0
deaths over 12 crews, Overworld 540-1 860 placed. What slows the crews after ~30 min (ha8 w3, 1 560 -> 1 580 placed in four minutes): cells in the air whose stances are all
`unsupported` (442-545 rejections per parked cell: no pillar column to ground over built blocks, no straight bridge), the handover's open point 1. No build has finished yet.

### Owner's visual checks V1-V6 and two more problems (2026-11-23 evening), batches ha9-ha11

| Check | Seen by the owner | Fix |
| :-- | :-- | :-- |
| V1 | two Nether bots on netherrack, one floating a little, the way out open | a bot whose walk makes no progress while it is off the ground (a gap too low for the body: the server's crawl pose, unknown to the bot's physics) digs out the cells round its head and jumps (`unwedge`, logged `wedged at`); ha10-ha11: 0-5 per crew, none stayed stuck |
| V2 | no heap of empty boxes | (works) |
| V3 | units rarely whole: a bed or trapdoor missing | parked blocks say "no way to the stance"; see the open point below |
| V4 | many temporary columns beside the units | the mover climbs down its pillar whenever it leaves it (unless the next stance is on the same column), breaks its bridge blocks behind it, temps within three cells are taken between the work: about 2 000 taken back per crew in 25 min (ha11) |
| V5 | Nether bots digging with bare hands | tools by the volume to dig (`build_t`: pickaxes = 3 per bot + box volume / 1 500) |
| V6 | no jumping between pillar tops | (works) |
| Bd4f | shut in by the blueprint's glass around its own cell | no block that leaves the bot's own cell without a side or the top open (`shutsIn`) |
| tiers | the upper tiers of the Nether gate hardly built | stances the claim's model calls unsupported are asked of the planner (`Mover.canReach`, at most six a minute per bot); in ha10-ha11 none of them was reachable either: open |

Open, as measured on ha10/ha11: the place pace halves after ~25 min (to 26-34 blocks a minute) on cells in the air whose stances are all `unsupported` (435-485 rejections per
parked cell) and that the planner cannot reach within 20 000 cells either; walking is 65 % of bot time. The next step is a builder's way up the structure itself (stairs of
temporary blocks inside the box, standing on built tops) rather than more searching.

### Visual checks round 2 (2026-11-23 night), batch ha12

Seen by the owner: temporary blocks still left (V7); a Nether crew idle in front of lava (V8); bots digging on with bare hands after their tool broke (V10); on 25593 most bots
standing at the chest. Causes from the logs (ha11): the chest's temporary blocks ran out (deaths drop them, bots threw away rubble over three stacks) and the crew stood at the
chest with 1-4 blocks each, so no pillar and no stance; dead Overworld bots respawned at the world spawn, beside the other crew's chest 300 blocks away, and could not plan
back; the V8 site hung in the open over the lava sea (34 353 of 35 840 cells already right, every stance unsupported, nothing to build down from). Fixes: five stacks of
temporary blocks kept, 48 stacks in the test chest; a spawn bed beside the chest (Overworld), a bot over 200 blocks from its site leaves the crew; the bot climbs down its own
pillar right after each stance's work; a spare pickaxe, tools worn at a fifth of their life; the harness refuses Nether boxes whose lower third is under 40 % rock.
ha12 at 25 min: best Overworld crews 1 257-1 500 placed, untemp 1 400-3 200 per crew, 0-1 deaths; the spawn bed was set on world 3 (8/8 bots) but found no cell on
world 1 ("no cell took the spawn bed", 12-14 tried: open); a bamboo forest site (w1) kept the crew at its chest (plans of 30 000 cells did not get 30 cells into it).

### Visual checks round 3 (2026-11-24 00:20 JST), batches ha13-ha16

Owner: temporary blocks fewer but still many (V11: one block to stand on and one to place against should be enough); bots idle near the chest (V12); no bed found and many
dead bots at the world spawn; a Nether site inside a fortress (V14). Fixes: where the blueprint has a plain full block (smooth stone, glass, obsidian ...) a pillar or bridge
uses that block, so the climb builds the structure and leaves nothing (`rules.buildBlock`, no temporary block counted in the plan); stances on temporary blocks over one
high rank below every other; the spawn bed is set down from behind its foot (any side as a fallback) and a spawn counts as set only when the server says so (`set_spawn` over the
hotbar), again after a `spawnReset`; a builder short of air surfaces first (four drowned, ha13); the harness refuses Nether sites with fortress blocks. Found on the way: the
first air check froze a crew's process for minutes (out of the water the surfacing returned at once and the loop never yielded; found with a live stack via the inspector,
`kill -USR1` + Debugger.pause). ha15 at 25 min: 0 deaths on all crews, the spawn bed confirmed on 6 of 8 Overworld crews, best crews 1 350-1 630 placed.

### Blocks in the air (2026-11-24 morning, owner away; batches ha18-ha26)

Offline analysis of iron-farm-34 built bottom-up: every block has a supported stance within reach; 353 layer parts (3 917 cells) touch nothing below and each needs one first
block from a touching pillar or bridge (the rest grow against it). The planner itself solves a 25-high floating platform in 33-70 ms. On the live worlds the failures came from
elsewhere, found with `scripts/t26/plan_probe.js` (a spectator runs the builder's planner from a failing bot's cell: plans of 45-54 steps where the crew's planner gave up after
30 000 cells) and a self-diagnosis in `Mover.goto` (`[diag] ... a way without '<rule>'`: the crew rules behind the failures were other bots' bodies, blocks claimed by others,
reserved pillar columns, failed-pillar cells).

| Cause | Fix |
| :-- | :-- |
| the claim judged stances by rules of its own (a stance three above the bot it may not dig) | the claim uses the bot's mover rules (`job.moverRules`) |
| every block of other bots' 64-task claims was not standable | "doomed" only within the claimer's reach |
| bodies anywhere, reserved columns, failed-pillar cells were bans | bodies only within four cells; all three are costs in the plan |
| a depot box that never opened held the last dirt; blocks broken high up fall and are lost | the box is taken up and put back; 96 stacks in the test chest; a bot without blocks digs natural ground near the chest |
| pillars built again for every stance (64-84 claims a minute, 2-5 placing; mid-air digging falls) | a temporary block stays while placing is left around it; the pillar is kept for a next stance within five cells |
| climbing down while another bot crossed the pillar's top | unpillar and scaffold removal respect other bots' routes |
| only straight bridges in the claim | a per-level breadth-first search for bridges that turn |
| seeds by the lowest layer: bots left a floor 20 up for a cell five layers down elsewhere | seeds by nearness (a climb counts double); a bridge step with the blueprint's own block is cheap, so floors are laid by walking over them |
| a few low cells held their tiles' window (3 925 of 4 425 cells above it) | a cell lowest in its tile for three minutes no longer holds the window |

Measured: ha21 at 55 min 1 794-2 247 placed per Overworld crew; ha25 2 132-2 808; ha26 at 30 min up to 2 107. No build has finished yet.

ha26 ran 120 min on the code above: the best crew placed 6 571 of 6 920 (w4 c0, 349 left), five crews 4 400-5 600; then every crew flattened. Causes and fixes (ha27-ha28):
drops onto temporary blocks due to be taken away (a temporary block with an untemp task is never stood on; no drop lands on another bot's temporary block); bots boxed in by
the others' blocks (no block that boxes in any crew member; a search of two cells or fewer digs out and escapes); in the tail, 1 080 temporary blocks took all but four claims a
minute (a nearby one ranks as a placing at the same distance) while 187 of 234 ready cells waited for items nobody fetched (a bot whose ready placing mostly needs items it lacks
fetches them); temporary columns with no stance beside their top are claimed from on top and dug down under the bot (`unpillar({ any: true })`).
ha28 at 30 min: 0-1 deaths per crew, the best Overworld crews 2 083-2 464 placed.
