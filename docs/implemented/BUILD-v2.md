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
| `drive.js` | one bot: supply trips, claim, walk to the stance, do the batch grouped by look, clicks, read back, report; pours along a ray the server traces itself; portal lighting; the supply read |
| `place.js` | where a survival player stands and what it clicks to put a state into a cell: a face its eye sees first along the look ray, within reach, that vanilla's rules turn into the wanted state |
| `vanilla.js` | vanilla's placement rules as a forward model (26.1): the state a click on a face at a hit point gives |
| `world.js` | reading the world through a bot: a cell's state, the eye, eye-to-box distance |
| `pistons.js` | a piston in the other phase than the blueprint's snapshot: the cells in front of it count as right |
| `supply.js` | what the materials containers hold, shulker boxes included (their `container` component); a survival bot's trip to fill its pack (depot boxes) |
| `move.js` | survival movement: the plan over standing cells (walk, step up, drop, pillar, bridge, dig) and its execution with the bot's own inputs (`Mover`) |
| `fallguard.js` | under every move: a body on support never moves sideways onto a fall over three or onto lava (it wraps the bot's physics tick); planned drops open their columns to their planned depth (2026-11-25) |
| `pool.js` | the crew's shared pool: a bot asks the colleague that can spare an item, walks up beside it and the colleague throws the stacks over (2026-11-25) |
| `temps.js` | the ledger of temporary blocks: registered before the click, confirmed by the server, released when the step that needed them is over, classified when found standing (2026-11-25, TASK-20261125-075) |

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

End of 2026-11-24 (batches ha29-ha30): the tail fixes (hand-back by nearby need, fetch rule, drops onto others' temporary blocks, hand-backs every two minutes and only
stacks worth the walk) did not lift the tail: ha30 at 120 min, best crews 5 342-5 911 placed (ha28: 5 600-6 127 at 132 min), the last 1 000-3 000 blocks at 10-20 a minute.
Between minutes 100 and 120 supply trips and hand-backs were about 40 % of bot time, walking about 35 %. Open for the next session: the supply in the tail (items spread over
eight packs; a shared pool or a bot that collects for the others), deaths in the tail (5-10 per crew, falls from structures over 100), the Nether crews' many single-item trips
(about 30 item types for two bots). No build has finished yet.

## Handover 2026-11-24 23:00 JST (session ended by the owner: too large; the next one starts here)

**Where it stands.** No survival build has finished (the acceptance test: a finished, cell-correct build). The blocks in the air are no longer the blocker: the best Overworld
crews place 80-95 % of iron-farm-34 (about 6 900 blocks) in about two hours, against 25-40 % on 2026-11-23. The last 5-20 % (the tail) is where every run stops.
`npm test` green 2026-11-24 21:05; deployed to the fabric26 consoles (3031-3033 answer 200); `main` = `origin/main` (commit 39cd87c3 and this handover).

**Last batch ha30** (scripts/t26/multi.sh, 150 min, every crew FAIL by the server's judge):

| crew | blueprint | placed | left | deaths |
| :-- | :-- | --: | --: | --: |
| w3 c1 | iron-farm-34 | 6 128 | 762 | 5 |
| w4 c1 | iron-farm-34 | 5 572 | 1 168 | 5 |
| w1 c1 | iron-farm-34 | 5 521 | 1 210 | 3 |
| w3 c0, w2 c0, w4 c0, w1 c0 | iron-farm-34 | 4 016-5 154 | 1 676-2 865 | 8-13 |
| w2 c1 | iron-farm-34 | 3 660 | 2 964 | 1 (heavy clearing site) |
| w1 c2, w3 c2 | nether-side-main | 962-967 | 167-182 | 0 |
| w4 c2, w2 c2 | nether-side-main | 0-590 | 512-1 049 | 0 |

Best runs so far: ha26 w4 c0 6 571 placed, 349 left at 120 min; ha28 five crews 5 000-6 127 at 132 min.

**What to look at first (in this order).**
1. Supply in the tail: items are spread over eight packs; between minutes 100 and 120 of ha30 trips and hand-backs were about 40 % of bot time. Two fixes (hand-back by nearby
   need, fetch rule) did not lift the pace. Idea: one shared pool (the chest) kept full by a collecting bot, or bots handing items to each other directly (vanilla: a toss).
2. Deaths in the tail: 5-13 per Overworld crew, falls from structures over 100 (temporary blocks taken away under routes, drops). `died at ... last:` lines give the moves.
3. Nether crews: two bots, about 30 item types, many single-item trips; the lowest cells are often chests and hoppers with no stance.
4. The owner's temporary-block standard (V11): "one block to stand on and one to place against". Today: blueprint blocks are used for climbs where the blueprint has a plain
   full block; other temporary blocks stay while work is near (about 1 500-2 300 per crew queued for removal in the tail). Not met yet.

**How to run.** `LIMIT_MIN=150 scripts/t26/multi.sh RUN "1 2 3 4" 2 1` (per world two Overworld crews of 8 and one Nether crew of 2; servers 3 CPUs / 6 GB; 16 crews overload
the 12-core host). Before a new batch: kill the old one by PID (`ps -eo pid,args | grep "t26/multi.sh RUN"`, never `pkill -f` with a pattern that matches your own shell) and
containers by name (`docker ps --format '{{.Names}}' | grep ^live-t26-`), then `scripts/t26/dev.sh N stop` for every world (leftover watchers keep the volumes in use and
`up.sh --new` refuses). The owner's rule: after a fix, every crew restarts on the new code. Keep runs out of the 03:00-06:00 reboot window.

**Diagnostics.** Per-minute `[progress N min]` (placed, work left, time split, deaths); `claims in the last minute` (place claims, ready/doable/batch); `lowest cells left: ...` (the
cells that hold the window and why); `[diag] ... a way without '<rule>'` (which crew rule made a search fail); `scripts/t26/run.sh N plan_probe.js FROM=x,y,z TO=x,y,z
[TEMPS=n] [BOX=...]` (the planner from a spectator on the live world); a frozen process: `docker exec C kill -USR1 1` and Debugger.pause over 127.0.0.1:9229 from a container in
its network (node 20: `--experimental-websocket`). Server deaths: `docker logs forgeaip-t26-N | grep "fell from"`. Check test exit codes directly (a pipe into `tail` hid a
failing test once).

**Servers.** T26 worlds 1-4 on the tailnet (100.77.246.23:25591-25594) left up with the ha30 sites; worlds 5-6 down. The owner is the only operator (Seia_Y). One ha30 harness
container (`live-t26-1-*`) was still running at 23:00; stop it by name if it has not exited. Uncommitted `docker/bot.Dockerfile` and `docker/compose.yaml` are not this task's.

**Where the details are.** This file's sections from "Owner's problem list 4" on; knowledge-DB LLM-records/2026-11-23-...-owner-s-problem-list-4-... and
LLM-records/2026-11-24-...-blocks-in-the-air-...

## Shared pool and fall guard (2026-11-24 night to 2026-11-25; the owner's instructions after the handover)

The owner's three instructions: (1) in the tail the materials are scattered and the supply turns unstable: make them one shared pool, and let a bot ask a working colleague
for items instead of going through the chest every time; (2) falls from height are a lack of robustness in movement, not in pathfinding (a cell that is safe with Shift is
fallen off when jumped onto; a jump that looks possible hits the head and the bot falls), and they happen from early on, not only in the tail; (3) temporary blocks stay a
special issue, not for this session. Done when materials are shared and handed over properly and builds succeed stably.

**The shared pool (`src/build/pool.js`).** What a bot carries beyond what the cells near it need (place tasks within 12 across and 8 up or down, not parked, with a stance, and
its own claims) is the crew's. A bot whose ready work waits for items asks the colleague that can spare the most of them nearest to it (a climb counts double, at most 48 away;
never tools, shulker boxes or the temporary block), walks to a cell two to three from it with a clear line between them, and the colleague throws whole stacks over, level, so
they land at the asker's feet and out of its own reach (vanilla `toss`; the server gives the items to whoever touches them after two seconds). The giver serves between its
tasks and between its moves, and waits for an asker that is near; it does not throw while a third bot stands beside the asker. A colleague is asked first when the chest is out
of an item it can spare or when it is much nearer than the chest (0.6 of the chest's distance); otherwise the trip goes to the chest as before. Items the chest is out of that
a colleague can spare are no longer left to the bots that carry them (the claim's `skip`). The hand-backs to the chest are off (`BUILD_PEER=0` brings the old way back).

**The fall guard (`src/build/fallguard.js`).** The bot's position is computed by its own client physics (prismarine-physics) and the server takes it; the guard wraps that
tick (`bot.physics.simulatePlayer`). When a body held by a floor (a block shape under its box within three below; water counts; lava, magma, fire, cactus do not) would move
sideways to where nothing holds it, the part of the move that still holds it is kept (it slides along the edge) and the rest is undone. It holds whatever the controls do: the
momentum of a landing on a pillar top, a jump cut short by the head, an upright corner, a push. Sneaking does not do this: it works only on the ground, and the mover sneaks
only where it expects an edge. A planned drop opens its column only to its planned depth: a landing that is gone when the body steps off holds it at the edge. Before a step
up the mover now looks at the head room over the take-off and at the landing cell (`Mover.follow`), and a cell is standable only with its top under the middle of the cell
(`View.stands`). Tests: `tests/test_build_fallguard_sim.js` on prismarine-physics, each case checked to fall without the guard.

What the live batches found (T26 worlds 1-4, two Overworld crews of eight and one Nether crew of two per world; every crew restarted on each fix):

| Batch | Found | Fix |
| :-- | :-- | :-- |
| hb1 | the asker stood 2.3-3.2 away and the toss, aimed down, fell between the two; the walk onto lying items read the item's metadata (unreliable on 26.1) | (then) the asker beside the giver; any new item entity walked onto |
| hb2 | a toss of part of a stack drops the items one by one: 26 obsidian lay spread out and four bots picked them up | whole stacks; part of a stack only up to 16 |
| hb2 | five bots in a row dropped onto a temporary block that was gone (a planned drop opened its column to any depth) | a drop opens its column to its planned depth |
| hb3 | four bots on two crews stepped onto an open trapdoor of the blueprint (a plate along one side with its top at 1) and fell through: planner and guard both took it for a floor | support only under the body: `View.stands` and the guard |
| hb3 | askers walked to rubble (blocks dug nearby) and the crew took the toss | the toss is told by when and where its entities appear; no toss while a third bot is beside the asker |
| hb4 | a bot perched on the rim of a block; each step toward its target also left the rim; the guard undid it for minutes (7 484 ticks) | keep the part of the step that still holds the body |
| hb4 | askers gave up after four chases while the giver climbed between stances | the giver serves between its own moves; the asker follows until the request's time is up |
| hb6 | from beside it, the giver took its own toss back | the asker stands two to three away with a clear line; the toss is thrown level |
| hb6 | a killed batch's `up.sh` started the watchers again and the next batch did not start | `scripts/t26/stop.sh RUN` (children, containers by name, watchers) |

hb7 (60 min, on the code up to cf2ca92f): no deaths on any of the eight Overworld crews by minute 58 (ha30 by minute 58: 18 deaths on its eight), at the same pace (mean
3 588 placed against ha30's 3 581); hand-overs 99 done of 173 asked (57 %); of 13 tosses nobody got, 7 were taken back by the giver (it walked on between its moves: since ac6f3bb4 it
stands still until the asker has the stack). Measured before that: hb6 at 25 min, no deaths on any of the 12 crews (ha30: 54 deaths in 150 min, all falls onto the ground); Overworld crews placed 782-2 259 (ha30 at 25 min:
345-2 347); 29 of 45 hand-overs done (64 %). The tail (the last 5-20 %, where every earlier run stopped) has not been reached on this code yet: the batches were cut short for
the fixes and by the 03:00-06:00 reboot window.

How to run: `LIMIT_MIN=150 scripts/t26/multi.sh RUN "1 2 3 4" 2 1`; stop with `scripts/t26/stop.sh RUN`. In the `[progress N min]` line: `stats.guard` (ticks the guard held a
body back), `stats.pool` (served/asked, items), `time.peer`. Per request: `pool: A <- B {...}: done | failed (did not meet | nothing picked up; picked up by {...})`. A death
line names the guard's last hold and, in its trace, the tasks done at the stance.

**hc1, the long batch (2026-11-25 06:05, 210 min, all fixes up to 041ba61d), at 150 min:** no deaths on any of the 12 crews (ha30: 54 in 150 min, all falls). Overworld crews
placed 4 064-6 471 of about 6 900; place tasks left 96-510 on seven of the eight crews (2 552 on one heavy site); ha30's best at 150 min had 762 left. Hand-overs: 878 done of
1 259 asked (70 %; failures: 249 nothing picked up, 59 did not meet, 48 nothing left to spare, 17 expired). Time at 150 min per Overworld crew: walking 27 600-39 300 bot-seconds,
chest trips 8 600-14 500, hand-overs 2 300-7 300. No build finished.

**What stops the tail now (it is no longer supply or falls).** In the best crew (w2 c0) the 96 place tasks left did not change for the last 30 minutes while the crew took
temporary blocks away (3 900 -> 5 700 taken; 970-1 900 still queued per crew). The cells left are ready but have no stance: for example the hopper at 235,78,-97 (world 2)
sits between smooth stone under it and the glass already placed over it, with open floor beside it, so no click gives its facing; the order of the build locked it in. Two open
problems for the next session: (1) cells the build order closes in before they are placed (hoppers, a lever and redstone under a block placed first): the order rules
(`job.ready`) or a dig-and-replace of the closing block; (2) the temporary blocks (the owner's special issue). The console deploy of this code: 2026-11-25 08:50
(fabric26 consoles 3031-3033 restarted; 200 on the tailnet, 403 for proxy headers without an Access assertion).

**hc1 at its end (210 min, 09:41):** every crew FAIL by the server's judge; still no deaths on any of the 12 crews over the whole run. Place tasks left: Overworld 93-481 on six
crews, 910 and 1 886 on the two heavy sites; Nether 8-323. Temporary blocks still queued: 500-1 689 per Overworld crew. In the last hour the best crews placed almost nothing
more (w2 c0: 96 -> 93), which confirms the closed-in cells and the temporary blocks as what is left.

## Temporary blocks: one ledger, lifetime = the step (TASK-20261125-075, owner list 5 Large 1; stage A offline, 2026-11-25)

Owner: temporary blocks from movement, temporary placement and water countermeasures stay in large numbers; breaking right after placing and removing everything at the end were
both tried with no effect; place it, break it as soon as it has served; if registration is careless fix the movement system; "still needed" is fundamentally wrong. Contract:
`docs/proposed/OWNER-LIST-5.md`, section TASK-20261125-075.

**Every code path that puts down a block that is not a blueprint cell (before this change).**

| Path | Registered | Released by | Kept by |
| :-- | :-- | :-- | :-- |
| `Mover.pillar` (move.js) | only if the block showed within the bot's ~1.5 s wait | `unpillar` when the next walk starts; after a stance's work only if no placing within 5 x 5 x (-4..+3) (`job.workNear`) | next stance within 5 cells and 3 high; placing near; stops over a gap / beside a fluid / under another bot's route -> job untemp |
| `Mover` bridge step | only if seen 200 ms after the click | `_behind`: the block behind, only over air | "over ground it is a step, left to the crew" |
| `Mover.placeTemp` | after a 500 ms wait | — | unused (removed) |
| scaffold task (`job._scaffoldFor`, drive `work`) | outside the box only, at the report; inside the box in no list | `unscaffold` when within reach | while ANY place task beside it waits |
| fill task (fluid in a box cell) | never | the next survey (Overworld crews surveyed once in 210 min, hc1) | — |
| seal task (fluid outside the box) | never | never | — |
| escape / evacuate / unwedge movers | as pillar/bridge | as pillar/bridge | as pillar/bridge |
| spawn bed, respawn anchor | never | never | — |
| job `_offerTemps` (the crew's untemp tasks) | — | — | a crew member or stance in the column up to 80 above; a bot within 4 cells; 10 s after the last use; placing in the 4-cell buckets around (about 12 x 8 x 12) |
| untemp ranking | — | — | 2000-2600 points behind all placing |
| untemp "dig the column down from its top" | — | — | its top reached by a NEW pillar beside it (that pillar was the next bot's untemp: a treadmill) |
| work layer (pit, move tests): `moves.js` pillar/descend, `bridge.js`, shelter cover | before the click (NAV-v1) | `tidy` after every walk step; `sweep` at the job's end | under the feet; out of reach; orphans of a live bot; `sweep` FORGOT an unreachable block (it stood in nobody's list) |
| `skills/commands/block.js` `place {temp}` (pit seals, water rescue) | only when confirmed within 10 ticks | pit cleanup, `cleanTemps` | a seal while fluid is beside it |
| `bot/reflex.js` fall block | when `placeBlock` answered within 250 ms | as an orphan | off for builders (`__builderOwns`); the 4 291 + 2 805 hc1/hd1 "reflex fall" lines are the harness's spectator scout before the job (a spectator places nothing) |
| `bot/temps.js` registry | — | — | at most 4 000 entries / 3 days (the oldest are dropped silently) |

**Cause table from the hc1/hd1 logs (T26 26.1.2 worlds, iron-farm-34, 210 min; what the logs allow, no server scan existed).** Per Overworld crew at the end: 500-2 044
untemp tasks still queued (b/d: released only by the keep rules above, then waiting behind all placing), 10-73 parked untemp tasks (c: "no way to the stance" 8-51, "no stance
reaches it" 2-22), and an unknown number of blocks the keep rules never offered at all (not logged; d). The judge's wrong cells that should be air (3 054-7 125 per crew) could
not be told apart (temporary block, natural ground, fluid): the judge did not record what a cell held. The tail was a treadmill: in the last 60 minutes the eight Overworld
crews of hc1 placed 0-532 blueprint blocks but took 1 377-3 896 temporary blocks away and put down at least 1 170-3 690 new ones (removed + change of the queue). Cause (a)
paths: late placements of pillars, bridges and skill `place {temp}` (registered only within a wait), fills and seals (never registered), scaffolds in box cells, `sweep`'s
forgotten blocks, the bed and the anchor.

**What changed (commit 727495be).**

| Cause | Change |
| :-- | :-- |
| a: registered only when seen within a wait; fills, seals, box-cell scaffolds, bed/anchor never | `src/build/temps.js` `TempLedger`: every placement is an entry before its click (`intend`), confirmed or ended by the server's block update (`drive.js` listens to `blockUpdate` for every bot); a pending one is settled as never placed only after the server's refusal or 5 s. Fills, seals, scaffolds and the bed/anchor are entries. `place {temp}` (skills) registers before the click; `nav/go.js sweep` keeps an unreachable block registered and reports it |
| b: no release | the bot's step: `release` (drive.js) runs before anything else the bot does next (a claim elsewhere, a trip, a hand-over, idling, an escape); the column under it is dug as it comes down, its other blocks in reach and sight are dug from where it stands, the rest are untemp tasks at once with the reason. A dead or leaving bot's blocks are the crew's at once (`orphanOf`). When nothing but temporary blocks is left, every block of every bot is due (the survey) |
| d: "still needed" | removed: the 90 s / 10 s waits, a bot within four, placing in the buckets around, the next stance within five cells, scaffolds kept while any neighbour waits, bridges over ground left to the crew. What remains: the next stance ON the same column (the column is that step's), a scaffold lives until its own block stands or is parked, a fill hands its cell to that cell's clear or place task at once, a seal (outside the box) that still holds a fluid back at the end and a block holding a fluid back are kept by a named rule and counted (`keep`) |
| c: removal impossible by construction | untemp stances and the "dig the column from its top" claim only where the flood reaches them on foot (`Mover.flood` now records the blocks the way places); untemp tasks rank as placing at the same distance, the placer's own first |
| pace | a bot on its own column prefers a next stance on that column (the work around a pillar is taken from it, as a player does) |

**Instrumentation.** `[progress N min]` ends with `temps {inPlace, pending, due, kept, peak: {bot, n} (this minute), peakEver, over2 (times a bot came to hold a third),
placed, removed, never, orphaned, failed: {reason: n}, byHow}`. `build_t.js` scans box +-24 (+-16 up/down) for every temporary-block name (the crew's, `TEMP_BLOCK`, every
item the ledger saw) before the job and after it, and classifies each new one with the ledger: `[temps] {left, inBox, outside, table: {a, b, c, d, why}, ledger, peakByBot}` and
up to 200 cells in the trial JSON (`temps`); the judge now records what each wrong cell holds (`wrongHas`). Tests: `tests/test_build_temps_pure.js` (12, each rule with its
negative control) and the rewritten temporary-block test in `tests/test_build2_pure.js`.

**To verify live (stage B, on the Fabric 1.21.1 test worlds with pumpkins as the temporary block).** Zero temporary blocks at the end of `build_t` (with the cause table),
`mine_b`, `move_a`, `move_b`; at most two per bot at any minute except a column under a bot on it (a survival pillar of n levels is n blocks while the bot stands on it: the
exception to name with its measured heights); placing pace against hc1 at equal minutes. Open risks: a route that climbs its own pillar and walks off its top sideways leaves the
column (released at once; removed on foot from its top only when a floor reaches it); Nether bridges between chest and site are now built again on each crossing.

### Stage B (2026-11-26 night, Fabric 1.21.1 test world 4, pumpkins as the only temporary block, NATIVE_*=0)

Smoke runs of `build_t` (iron-farm-34, 8 bots, 25-30 min, `JUDGE=0`, new random seed each): what each showed and what was changed (commits on main between c288de5e and
822f4f0c).

| Run | Found | Change |
| :-- | :-- | :-- |
| tb1 | bots pillared with dug dirt and cobblestone, invisible to a pumpkin scan; with only pumpkins allowed they had 0-8 each after 15 min: a bot holding rubble counted itself stocked | `tempblocks.only()` (TEMP_BLOCK in the harness: the operator's block is the only temporary block, for pillars, bridges, seals, the supply's temporary item and the chest); counting, keeping and fetching use the same list (`drive.js tempKinds`) |
| tb1 | the final judge of 138 240 cells took over 25 min | `JUDGE=0` for smoke runs; the scan looks for the operator's block only |
| tb2 | a pillar left sideways (climb, then a walk or bridge off its top) stood: 3-21 blocks beyond the bot's column, the most at once per bot | `Mover._behind` digs the column the bot stepped off, top-down, leaning out over the shaft for the lower blocks; a walking run that starts on its own block is cut after the first cell for it |
| tb3 | stances on a bridge block or the build beside the bot's pillar top; blocks released out of reach waited behind the crew's ranking (due 9-33, a bot holding 6-18) | the way back (`Mover.walkBack`: onto the pillar's top, its bridge block dug, the pillar dug down); that pillar counts as the stance's own in the two-per-bot count; a bot's own leftovers are its next work at any distance |
| all | a timed-out run left every bot's blocks standing | `BuildJob.wrapUp` at the time limit (`WRAP_MIN`, default 10): only the untemp tasks are work, any distance |
| 077's probe | panes and wires changed shape at every temporary block beside them | `tempCost`: 60 more for a block a pane/bars/wall/fence connects to or that sits over or beside a wire; counted in `temps.shapes` |
| 078's corpus | `descend` dug the floor and the bot never dropped (5 of 5 cases: the body 0.2-0.3 off the middle, standing on the next column) | descend centres the body first (`moves.js`) |

Per-minute measurements (`[progress]` temps): tb3 (before the way back and own-first): the most beyond its column 11-18 per minute, about 150 bot-seconds over two per minute,
9-33 released blocks waiting; tb4 (with them, first 7 minutes): 4-6, about 20 bot-seconds a minute, 0-3 waiting.

### Stage C (2026-11-26 day, after the reboot; Fabric 1.21.1 test worlds 1-4, pumpkins the only temporary block)

**Cause table of the 1.21.1 runs of 2026-11-26 morning (code = main at 8a3713e9, server scans).**

| Run (world) | Left at the end (scan) | a: never registered | b: step never released | c: removal failed | d: kept | Over two (bot-seconds) |
| :-- | --: | --: | --: | --: | --: | --: |
| `build_t-w121-smoke` w1 (40 min) | 24 | 2 (1 no entry, 1 placed again) | 0 | 22 (8 no face in sight, 13 released and never tried, 1 under its placer) | 0 | 7 480 |
| w2 | 32 | 1 | 0 | 31 (15 no face in sight, 15 never tried, 1 a crew member on it) | 0 | 12 877 |
| w3 (bamboo jungle) | 36 | 15 (13 no entry) | 1 | 20 (17 never tried, 3 no face in sight) | 0 | 14 360 |
| `mine_b-w121-a` w1-w3 (240 min, timeouts) | 128 each | 0 | the whole kit of 128 per world: lake fill, seals, water rescue (`registeredTempsLeft` 128) | | | |

Over-two seconds by kind (`looseHow`, smoke w1-w3): a column of more than four left by a walk, bridge or drop off its top 51-76 %, a column of four or less 19-22 %, scaffolds 19 % (w2).
Temporary blocks put down in 30 minutes: 2 370 / 3 295 / 1 726 against 623 / 1 436 / 39 blueprint blocks. Beside a built wire (`temps.shapes`): up to 15 in a progress line (tb2/tb4, w4).

**Causes found on the way and what removed each (all on main, each with a test in `tests/test_build_temps_pure.js` unless marked live-only).**

| Cause (class) | Evidence | Change |
| :-- | :-- | :-- |
| a route climbed a column of its own and walked, bridged or dropped off its top: the landing can take back at most four (leaning over the shaft), the rest stood out of reach and was later dug from a new pillar beside it (c, the treadmill) | 51-76 % of the over-two seconds of the smoke runs | `move.js leaveColumn`: a column taller than `LEAN_DEPTH` = 4 is left only by the route's last step, onto the stance beside its top (its way back, `walkBack`); diagonal / up / drop off a column only when the landing can take it back. Routes to high places become staircases of columns of four or less, each taken back as the bot steps off |
| a pillar step over its own temporary blocks put the blueprint's block on top; unpillar stops at the build, the column under it was stranded (c) | bt075a w2: a drop off a column of 5 under a blueprint block | a pillar on its own column goes on with temporary blocks (`tempOnly`) |
| beside its pillar's top with the next stance over its own cell, `release` kept "the column" (the wrong one), skipped the walk back and dug the pillar from beside as far as it saw (c) | bt075b w3 "leaves a column of 5 ... walkBack null" | the kept column is the one the bot stands ON; `release` never digs a column of its own deeper than four from beside; such a column's top is claimed from on top first (`descend`) |
| a bed, a hand-over, a supply or bench trip walked off from the stance beside a pillar's top without the step's release (b) | bt075b w3: a column of 6 stood 57 s while its bot walked 46 cells away | `Mover.goto` walks back onto its own pillar and down it before any walk |
| the stance's own place task dug the pillar's top block (a blueprint cell) and put the build's block there; a clear task dug it from beside (c) | bt075b w1: columns of 7 and 8 under placed blocks; bt075c w2 "task clear ... dig pumpkin" | place and clear tasks skip a block of the bot's own pillar while its step lasts |
| a pillar click onto a cell with nothing solid (air, grass, snow: the bot mid-jump after a failed step up) puts the block INTO the clicked cell, one lower than registered (a) | bt075c w1/w2 "unregistered pumpkin" one under the planned cell (the new `onBlock` log) | registered in the cell the server will fill |
| wrap-up: trips for tools and walks to the bench laid new blocks; released blocks in the air were only taken on foot (c) | bt075a w3: 262 put down in the first three minutes of wrap-up; smoke: 13-17 "released, not tried yet" | no trips while wrapping; the bot's own released block, and every block while wrapping, may be taken from a stance that needs blocks (safe now: the route leaves no column standing) |
| a temporary block beside a built wire or pane: each one flips the wire twice (TASK-077's packet count; the cost of 60 still left 11-15 a progress line) | tb2/tb4 w4, bt075a w1/w2 `temps.shapes.wire` 15 / 11 | a ban in the planner beside built wires and panes; the cost beside cells where the blueprint still wants one; scaffolds never beside a planned wire or pane; a wire built beside a standing temporary block counted (`temps.shapesLate`) |
| mine_b: the pit's fluid fills (seals, lake fill, water rescue: box cells and the ring) were pumpkins only on the test worlds and spent the whole kit of 128 on water, then the bot had nothing to climb with (b/d: 128 left in each box) | mine_b-w121-a w1-w3 | fills use the dug rubble first (they are ground dug with their layer, or the ring that keeps the lake out: the contract's point 5); pumpkins stay for pillars and the like |

**Measured (build_t, iron-farm-34, 8 bots, 30 min + wrap-up up to 10, `JUDGE=0`, Fabric 1.21.1 worlds 1-3, a new random seed per world and run, speed x1.0).**

| Run (code) | Left at the end, server scan (w1 / w2 / w3) | Cause of what was left | Bot-seconds over two (w1 / w2 / w3) | Blueprint blocks placed at 29 min | Temporary blocks beside a built wire |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `build_t-w121-smoke` (8a3713e9) | 24 / 32 / 36 | a 18, b 1, c 73 | 7 480 / 12 877 / 14 360 | 623 / 1 436 / 39 | up to 15 a line (tb2/tb4) |
| `bt075a` (leaveColumn, pit fills) | 47 / 24 / 17 | a 2, b 1, c 85 | 10 250 / 6 246 / 3 842 | 1 633 / 1 064 / 316 | 15 / 11 / 0 |
| `bt075c` (f91f7fc0: + goto walks back, release, tempOnly, place/no-trip rules) | **1 / 2 / 3** | a 4 (3 rolled-back digs, 1 no entry), b 1 (a pillar laid after the count touched 0), c 1 (wrap time out) | 1 001 / 2 369 / 1 615 | 594 / 1 183 / 584 | 0 (4 wires built beside standing blocks: now skipped) |
| `bt075d` (5d4ff4ae: + restore of rolled-back digs, quiet wrap end, wires never built beside temporary blocks) | 6 / 1 / (w3: the crew never read the chest, no work, not counted) | c 7: 2 under its placer (a bridge block over a gap at the time limit), 3 a crew member on it, 2 orphaned by the pause at the end | 2 364 / 1 143 | **1 913 / 1 737** | 0 / 0 (built beside: 0 / 0) |
| `bt075e` (8729fa6f: + step off temporary blocks in the wrap-up, planned-wire lookup fixed) | 31 / **0** / 2 | w1: c 31 (29 orphaned when the wrap-up paused the crew, 2 under its placer: the wrap-up's staircases at the top of the build, y about 105, did not converge in 10 min); w3: c 2 orphaned (the job called itself finished in the wrap-up with 2 standing) | 1 681 / 443 / 416 | (w1 in wrap at 29) / 1 324 / 1 438 | 0 |
| `bt075f` (fd5d61ec: + nav walk-end sweep, `_behind` reasons logged) | (w1: no dry site in 30 draws, harness) / 4 / 5 | c 9: 6 orphaned (the job finished in the wrap-up; fixed in 5dfb6743: a wrap-up is never finished while blocks stand), 3 "a tall column: from its top" never reached | 1 792 / 1 776 | 1 219 / 1 949 | 0 |
| **`bt075g`** (5dfb6743: + no route over another bot's movement block, a wrap-up never finished while blocks stand) | **0 / 0 / 0** | none (wrap-up 346 / 57 / 261 s) | 3 155 / 147 / 464 | 27 / 714 / 1 613 (w1: a jungle, 1 991 temporary blocks for clearing) | 0 / 0 (built beside: 0 / 0) |

**Where it stands (bt075g, the last code):** zero temporary blocks at the end of the build on all three worlds by the server scan; at most two per bot is held 98-99.8 %
of bot time in w2/w3 (147 and 464 bot-seconds over two of about 19 000) and 84 % in w1 (3 155, a jungle being cleared: columns of four or less while the landing takes them
back, and columns left where `_behind` could not see the lower blocks: the log's "not in sight"); no temporary block beside a built wire or pane. Not yet zero over two: the
named candidates for the exception the contract allows are (1) the column beside the floor while it is being taken back (counted as in use since this stage), (2) water fills
and seals inside the box until their cell's own task (bt075f w2: one bot held 24 fills of a pond), (3) scaffolds until their block stands.

The seeds differ from run to run (the T26 standard), so the rows compare the same harness on different terrain. Over two as a share of bot time (8 bots, about 40 minutes): 39-75 % in the
smoke runs, 5-12 % in bt075c. What is left over two in bt075c: columns of four or less in the seconds while the landing takes them back (6-56 %), columns of more than four still
standing beside a stance that is not their top (9-78 %, the cases fixed after f91f7fc0), and in w3 the water fills and seals of the build (52 %) and scaffolds (29 %).

**Pace against hc1** (26.1.2, eight Overworld crews, the same blueprint, minute 30): 424 / 1 140 / 1 324 / 1 355 / 1 506 / 1 826 / 2 614 / 2 795 blueprint blocks (median about
1 430). bt075c at minute 29: 594 / 1 183 / 584, bt075a 1 633 / 1 064 / 316; the smoke runs before the change 623 / 1 436 / 39. The spread comes from the terrain (bt075a w3 and the
smoke w3 were jungles: 22 000-36 000 cells to clear before the first block); on equal minutes the new rules are within hc1's range but not above its median, and the version and
worlds differ, so "not worse than hc1" is not shown on equal terms.

**move_a / move_b (nav, registry scan).** move_b on 1.21.1 (074's `move_b-w121-a`, 2026-11-26 morning): 0 / 0 / 0 left. move_a: `ma075a` (world 4, x1, seed
-1552390885555710857): 4 of 4 reached, left 0 / 0 / 0 / 1 (MvE4: one block 15 cells behind its end, out of reach when it passed; nav's walk now sweeps its own blocks within
48 at the goal); `ma075b`: world 4 came up at speed x2 (079's per-test speeds on main: move_a 2): 0 of 4, three bots "unreachable, 1 cell expanded" at the start, not a
temporary-block matter (reported to the orchestrator); `ma075c` (x1, `SPEED=1`, seed 5434895445132380191): 2 of 4 reached (a death and "8 segments without getting closer": movement), left 0 / 0 / 0 / 0.

**mine_b (the pit; registry `src/work/bot/temps.js`, scan of the box +-12 for pumpkins).** `mb075a` (world 4, seed 6421017476795594789, a dry chunk, 60 min): 0 left, 0 registered,
timeout at 41 of 70 units. `mb075b` (world 4, seed -974350776696569252 = the box of mine_b-w121-a w3, 954 + 121 water cells, 90 min, rubble fills): **3** pumpkins left (the old
run on that box: 128, the whole kit, at 240 min), 163 registered blocks left, all fluid fills in the box of dug rubble (lake 12, seal 7, rescue 1 of the first 20 listed: ground the
pit digs with its layer, contract point 5), timeout with 5 of 67 units (the pit stalls on "seal: no standing cell within reach (inside rock)", as on 26.x and before this task:
a pit problem, not a temporary-block one). The 3 pumpkins stood because a timed-out pit had no end pass at all: `pit.js wrapUp` now gives it one (the movement blocks and nav's
sweep), called by `mine_b.js` for `WRAP_MIN` (default 5) before the scan. `mb075c` (the same box, with the wrap-up, speed x3 by 079's profile, 60 game minutes = 21 min): **0** pumpkins
left, 39 registered blocks (lake 14, seal 6 of the first 20: the box's rubble ground), wrap-up 45 s, 1 death, the pit as stalled as before.

The standard run with the wrap-up (`mb075e`, worlds 1-3, new seeds, 240 game minutes at x3, plus `mb075d` on world 4):

| World (seed) | Fluid in the box | Pumpkins left (scan) | What they were | Wrap-up |
| :-- | --: | --: | :-- | :-- |
| w1 (2085753754334713954) | 738 water + 84 lava | **0** | (477 rubble fills registered: the box's ground) | 30 s, finished |
| w2 (-8077720576801942768) | 60 | 5 | the pit bot's pillars | did not run: the bot was not in its worker loop (300 s, job running) |
| w3 (-3266761227149522799) | 1 208 | 44 | lake fills of pumpkins once 798 fills had used up the rubble | 33 s, finished |
| w4 (-8835564041475972616) | | 2 | pillars high on a mountain box (spawn y 129) | did not run: "replace-tool while waiting" the whole 300 s |

w3's cause is removed (`sealItem`: on the test worlds a fill never falls back to the operator's block; out of rubble the pit digs some). Open: the pit's wrap-up only runs
when the bot's worker is in its loop; a bot waiting for a tool or cooling down after failures (the service's states, outside this task's files) skips it, and its last
pillars stand (w2, w4). Every box stayed dirty (118-122 layers): the pit stalls in water ("seal: no standing cell within reach (inside rock)") as before this task.

**The two-per-bot rule as ruled by the orchestrator (2026-11-26 evening), binding from here on.** At most two temporary blocks per bot at any time (one to stand on, one to place
against); the column a bot stands on while it pillars counts as one structure in use. Measured exceptions:
(a) a column being dug back from beside it is the removal in progress: at most one per bot, and the bot does nothing else until it is gone;
(b) water fills and seals inside the build box are bound to their cell, not to a bot: they do not count toward a bot's two, each is removed by its own cell's task, and the end
scan must still find zero; their count over time is reported (`temps.byHow` fill/seal, and `kept`);
(c) a scaffold belongs to its block's claim: at most one per bot, gone when its block stands, in the same claim.
Everything else counts.

Re-measured under this rule from the runs' per-second records (`looseHow`: fills and seals left out, one scaffold per bot left out; (a) was already left out by `TempLedger.loose`
since stage C), bot-seconds over two, w1 / w2 / w3:

| Run | Before the ruling | Under the ruling |
| :-- | :-- | :-- |
| `build_t-w121-smoke` | 7 480 / 12 877 / 14 360 | 7 480 / 12 827 / 14 360 |
| `bt075a` | 10 250 / 6 246 / 3 842 | 10 250 / 6 172 / 3 842 |
| `bt075c` | 1 001 / 2 369 / 1 615 | 1 001 / 2 369 / 723 |
| `bt075d` | 2 364 / 1 143 / - | 2 324 / 1 143 / - |
| `bt075e` | 1 681 / 443 / 416 | 1 559 / 443 / 364 |
| `bt075f` | - / 1 792 / 1 776 | - / 269 / 1 752 |
| `bt075g` | 3 155 / 147 / 464 | **3 155 / 147 / 454** (about 16 % / 0.8 % / 2.4 % of bot time) |

What is left in bt075g w1 (a jungle being cleared; 3 155 s): columns of more than four (1 905 s, of them 775 with a bridge block) and of four or less (1 250 s). The log names
two causes, both on the build side (src/build, TASK-081 from here): released columns "a tall column: from its top" (174 times in the run) that wait for a bot to climb onto
their top, because the stance beside a pillar's top ended without the walk back (`walkBack 0`: the walk onto the top failed or its head cell was taken) and the descend claim
for such a top is offered only on foot and only to its placer (another bot's due block is `doomed` for routes); and `Mover._behind` stopping at "not in sight" (7) or "a crew
member on it or its route" (3) on the columns of four or less. Handed to 081 (see the report of 2026-11-26).

## Making a build finish (TASK-20261125-081, owner list 5 Large 3.1-3.3; Fabric 1.21.1 test world 4)

Owner: no construction has fully succeeded; the pit's proven mining is not reused for the site's terrain; find why the placements left in the last run were left; units by shape
instead of small areas; separate the cause of the bots' pauses. Contract: `docs/proposed/OWNER-LIST-5.md`, section TASK-20261125-081.

### What was left in hc1/hd1 and why (26.1.2, 15 Overworld crews of eight, iron-farm-34, 210 min; logs parsed against the blueprint)

| What was left | Crews | Cause | Change |
| :-- | --: | :-- | :-- |
| the stage never left `prepare` (1-190 clear tasks to the end), so the late stage (36 portal lightings, 1 512 portal cells) never ran | 15 of 15 | the builder's own clearing: a few cells (under covered cells, beside fluids, out of reach) held the stage for hours | the site's terrain is the pit's (below); what a pit leaves after its rounds is parked "left by the pit" and does not hold the stage |
| the two hoppers at the bottom (3,-11,-1 and 3,-11,0 of the blueprint), "ready, no stance" | 10 of 15 (13 with them left) | a support cycle: they face each other, a hopper faces into the block it is clicked against, so each needs the other standing first; no order places either (not the glass above, as 073 read it) | `Target.cycles()` finds such cycles from vanilla's placement rules (one in iron-farm-34, 29 in the Nether side); the job puts a temporary block into one cell, the other block goes against it, the temporary block is dug and the cell gets its own block |
| 64 floating spruce trapdoors (all six neighbours air; facing west, top half), "ready, no stance" | most | the lonely-block scaffold went below the cell first; a click on a block below gives only a bottom half | the scaffold goes where a click gives the wanted state (`Target.supportsOf`): beside (east) or above |
| white beds parked "got minecraft:air" (159 cells) | 15 of 15 | the bot pillared up in the bed's head cell and clicked the side of its own pillar; the server refuses a bed whose head cell is not replaceable (b081a `[bed]` 780,74,570: "head cell had pumpkin") | recipes name the other cell of two-cell blocks (`room`: a bed's head, a door's upper half); no click while it holds a block, in the stance's own world too |
| glass 146, smooth stone 117, obsidian 66, beds 35, slabs 22: parked "no way to the stance" | most | the planner's `[diag]`: 3 345 of 3 457 failed searches had a way without the `doomed` rule (others' temporary blocks due for removal are no floor); 075's ledger removed most of those blocks since | (075); measured again below |

### Clearing is the pit's (item 1)

After the first survey the box's columns from the highest cell to clear down to the lowest become an open-pit job (`job.planPit`: `pit.createPitJob(box, PIT_LEDGER,
{ method: 'sweep', road: false })`, the work console's own plan, units, layer gate, water rules, final sweep and end passes). Each bot fetches its kit (tools and temporary blocks,
nothing of the build) and works the pit's units with the work layer (`drive.js clearByPit` -> `runWorker(pit, ...)` with the bot's work environment from the service,
`construct.js`), nothing of the build is placed meanwhile; then the box is surveyed again. Up to three pit rounds run over what a pit left, all before the first block stands (a pit
digs every block of its columns); whatever is still left then is parked "left by the pit". A run's wrap-up wraps up a pit still at work. The builder's own clearing is gone
(`6fbbe1fa`): the top-down "covered" rule, the leaves-wait-for-logs rule, fluid fill/seal task creation, the fluid-pocket opener, deepening from one stance and placing that overlapped
clearing. A clear task is now a wrong block in a cell to build or a scaffold's cell. The pit method: sweep (dug with sight from a station per tile); on the same mine_b box `cmp4`
sweep passed and expert failed, and in b081b the expert's stations "could not stand" 18 times in ten minutes.

### Work units by shape (item 3)

After a batch of placing, the bot steps on along the line its blocks lie on (the longer axis of what it placed, one to three cells, same level, on ground or the build) and takes
what it reaches there (`job.claimNext`: the cells near the next stance only, no scan of the box, no seed ranking, no flood); a full claim only when the line ends. A bridge, a
wall or a floor strip is one run of stances without a claim between them. `BUILD_RUNS=0` turns it off.

### Pauses (item 4)

`src/build/pauses.js`: an action is a dig (from its start to its end), a click (use on a block, use of an item, a window click), a tick in which the body moved; every gap over
0.5 s between two actions is classified by where its milliseconds went: `cpu` (this bot's own claim, plan, flood, or the shared thread busy with another bot's), `retry` (after a
failed step), `bot` (waiting for another bot: hand-over, the chest's queue, nothing claimable), `server` (a look's tick, the block update after a click, a container), `other`.
The code names what it does with labels (`within`, `sleep(ms, label)`), the bot is found by AsyncLocalStorage, long synchronous sections are charged to the other bots.
`build_t` prints `[pauses N min]` per minute and the whole table at the end; `scripts/t26/pause_report.py LOG` sums a log.

Changes by cause: block reads by state id (`fastblock.js`, one shared Block per state: 23 % of the crew's CPU in 079's profile), a walk to a stance inside the bot's flood takes
the flood's route without a new search, a walk to a claimed stance gets 1.5 s of planning CPU (hopeless searches ran to the 4 s budget), the rule-by-rule diagnosis of a failed
search every five minutes, runs instead of a full claim per stance.

Hot paths for TASK-082 (Rust), from 079's profile and these tables: the builder's A* (`move.js plan`), the claim's stance search (`job.claim` seeds: `stationsAround`, the click
search `place.ways` with its rays), the bridge-distance map per level, and the work layer's NAV planner during the pit (event-loop blocks of 1.2-2.3 s in b081c's pit phase).

**Before (`b081a`, code 2867180a = main before 081's changes, world 4 seed -3849703754884137004, 8 bots, first 31 minutes: clearing, then placing; 1 247 blocks placed,
the stage still `prepare` with 329 cells to clear):** 1 405 pauses over 0.5 s, 1 962 bot-seconds (13.5 % of the crew's time).

| Class | Pauses | Seconds | Share | Largest labels |
| :-- | --: | --: | --: | :-- |
| cpu | 743 | 714 | 36 % | the bot's own plan 606 s (621 pauses) |
| other | 485 | 648 | 33 % | unlabelled drive sleeps 453 s (labelled since: read-back, click, supply queue), supply trips 167 s |
| retry | 70 | 493 | 25 % | the plan after a failed walk 481 s (63 pauses, about 8 s each: searches that cannot succeed ran to the 4 s budget) |
| server | 107 | 114 | 6 % | the mover's tick waits (look, click) |

In the placing minutes alone (15-31) retry was 45 % (443 s) and cpu 33 %.

**Why a place claim holds two or three blocks (offline, `iron-farm-34` built from its own target up to layer 8 on stone ground, a stance the claim chose):** the claim's
stance had 68 doable cells within reach, 66 of them with no click from it. They were cells of layers 9-13 (glass walls, the floating smooth stone and obsidian floor of layer
11) inside the window of seven layers but with no solid neighbour yet: nothing to click against until a pillar or a neighbouring block stands. The blueprint's layers hold
5-16 % of their 2 304 cells (113-379), as lines and floating floors, so the placing pace is set by how fast supports appear, not by the stance search. The window that counts
these cells as ready makes the claim's "ready" and "doable" figures look larger than the work it can do; the per-minute line now also prints the doable cells in reach of the
chosen stance and how many had no click (`bb1c03e7`).

### Runs (Fabric 1.21.1 test world 4, iron-farm-34, 8 bots, a new random seed each, pumpkins the only temporary block, speed x1)

| Run (code) | What it showed | Change |
| :-- | :-- | :-- |
| `b081a` (2867180a, before 081) | 30 min: 1 247 placed, the stage still `prepare` with 329 cells to clear; the pause table before (above) | (baseline, stopped at 30 min) |
| `b081b` (expert pit) | two bots entered the pit with an empty pack after a trip that brought nothing (missing_item x22), the others with their area's materials; expert stations "could not stand" 18x | kit-only trip before the pit; sweep method |
| `b081c` (sweep pit) | the pit cleared 7 018 cells in 702 s (5 left); then every bot's first claim threw: drive's new `work` option shadowed `work()` | renamed (2371e5d6) |
| `b081d` | the pit sat at 2 239 / 2 304 units for 20 min on a forest site (tree blocks its units could not take, 7 bots waiting) | 6-min stall cap (safety net); 075's tree fix (ebf6798e, c627010e) |
| `b081f` (26e2d282) | pit 396 s (5 518 cells, 0 stuck, no trees on the site, cap not fired); 96 plant cells left (the pit's model saw them as air), broken by the builder; then placing: 1 548 at 30 min, 4 028 at 68, 4 932 at 96 (57 parked). From minute ~85 six of eight bots were stranded at y 108-122: "no way to the materials" 125 times, searches of 40 000 cells from the top of the build | see below; stopped at 96 min (its judge was decided) |

**The stranding (b081f).** 075's lifetime rule takes a pillar back as soon as its step is over, so the way up a bot took no longer exists when it wants to come down; the
planner's only ways down were drops of at most six, and the build's glass walls offer none. The pause table showed it: minutes 80-92 had 2 397 bot-seconds of
`retry: plan` (67 pauses of about 35 s, 85 % of all pause time). The remedy is a move, not a keep rule: **sink** (`move.js`, owner ruling of 2026-11-26, OWNER-LIST-5
addendum 4, Tweakeroo-class placement): a temporary block goes under the block the bot stands on (that block's bottom face clicked; the server checks reach, not sight), the
block under the feet is dug, the bot is one lower, standing on its new block; a column of its own going down, taken away as it goes, which fits 075's rule. Probe on world 4
(`scripts/t26/sink_probe.js`, H 12): the server placed every block under the floor, the bot came down to the ground, 9 placed, 0 left (`sink-probe-1.log`). With it,
a search that ran out to a stance rules out the stances around it for three minutes (89d644cc), so the claim does not offer the next cell beside an unreachable one.


**Pit and NAV side after the ruling (TASK-075 continued, 2026-11-26 evening; src/build is TASK-081's from here).**

| Run (1.21.1, worlds 1-3, new seeds) | Result |
| :-- | :-- |
| `mb075f` mine_b, 240 game min at x3, wrap-up through the service (`wrapJob`, `_endPass`) | pumpkins left 2 / 1 / 1: pillar blocks hanging in the dug box (the pit's end now takes them: `cleanHanging` includes movement blocks), one block dropped from the registry by moves.js after a short wait (now kept registered) |
| `mb075g` mine_b | **w1 PASS** (box empty, 0 pumpkins); w2 2 pumpkins (the bot died during the end's cleanup after running out of pumpkins: the pack kept only one stack of the operator's block, now all of it); w3 0 pumpkins (145 fills of dug rubble, the pit stalled in water as before) |
| `bt075i` / `bt075j` build_t, the site cleared by the pit (081's `planPit`, `plants: true`) | no tree block failed a unit; before 018dfdd9 every plant failed ('inside rock', then 'not_visible': no collision shape to aim at); after it the pit finished on all three worlds with 0 stuck (864 / 3 168 / 1 152 units in 281 / 1 161 / 783 s) and left 0 / 0 / 1 clear tasks to the builder |
| `mbv075a` / `mbv075b` move_b | 1/3, then 3/3 PASSED with 0 / 0 / 0 temporary blocks left (the walk that gave up mid-fight now waits 8 s off a node, and a walk that ends without its goal sweeps its own blocks) |
| `start_probe` (seed 5479556643456516314, ma075b's bamboo tops) | 4/4 bots off the bamboo and walking (NAV: digdown onto partial blocks, only digdown on a partial top, the floor mined blind, clearCell honest) |
| `under_probe` (owner ruling, addendum 4) | 3/3: the server accepts a block placed against the bottom face of the floor, blind, and the floor dug after it (moves.js `descend` already does this) |
| `ma075d` move_a (x1) | 9/12 reached (75 %: a failure by the standard; the morning's 1.21.1 run had 6/12), the temp scan found 0 on all 12 bots |
| `bt075k` build_t, the site's pit after the b081h fixes (tree pass: a low block the plain mine misses goes the aerial way, given-up blocks back to the units; registry: late window, reflex registers before its click) | w1 (y 122-131): 1 440/1 440 units in 534 s, 0 stuck, 0 clear tasks left to the builder; w2: 2 160/2 160 in 1 062 s, 0 stuck, 0 clear left; w3 (a village, 10 937 cells): still in its first round at the run's limit; no unregistered pumpkin reported on any world |

**Unreachable cells on forest sites: one root fix (TASK-075, 2026-11-27 night, 081's b081d / b081h / b081i / b081k).**
A cell a pit unit cannot reach from its station is no longer a special case per tree shape (oak canopy, birch crown, spruce down to the snow, the crew's own pumpkin
6.7-18 out of reach, a snow layer). Whatever it holds, a reach failure (unmet `in_reach`, `unreachable`) goes straight to a blind mine when the eye is within 4.6, else
to one NAV trip within reach (`env.nav`, near 2: walk, dig, pillar, bridge, descend, the block two below), then the mine again (208176ae, 58414e14). No six-try retry
ladder for a reach failure; at most three NAV trips per unit; each trip has a 60 s deadline, checked between segments and between steps (214693e6, 3f110f6a; `go()`
option `deadline`). A tree block is a cell like any other: no aerial skip, no "left to the tree pass", the layer is not done while one stands; the tree pass is only a
speed-up. Units over 30 s are logged (`pit <region> u<n> slow <s> s: {nav, navS, blind, cellsS, mined, trees, cell}`), and a unit's failure carries `routeFail`,
`liftFail` and where the bot stood.

| Run (1.21.1, `SITE_BIOME`, `LIMIT_MIN=45`) | Cells | Pit | Tree blocks left in the box (server scan) |
| :-- | --: | :-- | :-- |
| `bt075t3` birch_forest (208176ae) | 5425 | finished, 955 s, stuck 0 | 0 |
| `bt075t8` taiga / spruce (314af84f) | 9087 | cut by the time limit at 2697 s, 2903/3024 units | 82 (70 spruce_leaves, 12 spruce_log); 2 pumpkins |
| `bt075t9` dark_forest (314af84f) | 16353 | cut at 2695 s, 3701/3744 units | 4 (dark oak log and leaves, a mushroom block); 2 pumpkins |
| `bt075t10` jungle (314af84f, no between-steps deadline yet) | 16285 | cut at 2699 s, 4525/6336 units | 3422 (the pit was unfinished); 15 pumpkins |

Pace: rock sites ran 7.3-11.4 cells/s (`bt075h/j/k`), the forests about 3.4 (taiga), 6.1 (dark forest) and 4.3 (jungle). Units over 30 s took 41-47 % of the bots' time.
Tree-pass units had medians of 108-211 s. Units with a NAV trip had medians of 46-64 s, p90 138-450 s, and nearly always one trip (the cap of three does not bind).
NAV took 11-15 % of the bots' time. The other slow units spent half their time in cells and half in station walks. The rate falls steadily with depth: the late slow
cells are mostly ground (stone, grass, dirt), not trees. **Not met:** zero tree cells on every forest site within the limit, and the pace of a rock site. Two causes are
still open on the pit side. (1) The layer gate serialises the last region behind one slow unit (t8: 120 units pending, 1 leased). (2) Bots near the bed outside the box
fail 'too far from the station' because NAV ends 'stuck' and the lift is refused (survival).
**Runs b081g-b081k (2026-11-26/27 night) and what each changed.**

| Run (code) | What it showed | Change |
| :-- | :-- | :-- |
| `b081g` (4c9db61e) | stopped in its pit (the fixes below were ready) | |
| `b081h` (f56c4688) | the pit hand-over adopted 4 movement blocks of the pit; 71 cells left by the pit after 3 rounds: 4 pumpkins in no ledger, a birch tree | orphan pumpkins adopted by the build ledger (6d9b8886, a safety net); 075: trees (b4ad1672) |
| `b081i` (ed009df3) | a snowy taiga: 125 spruce cells left by the pit; sinks 163/163, no stranding at height; 4 bots shut in closed halls of the build ('no more cells, 1 543 cells') | 075's root fix (208176ae: any cell the station misses gets a NAV trip, then a blind mine); dig-out of a closed hall (e0d643bd); the order rule closesIn and a dig-out that prefers blocks the crew gets back (6f6d80c3) |
| `b081j` | no dry site in 30 draws around the nearest forest | (harness) |
| `b081k` (e0d643bd, a forest) | pit 1 190 s; my 6-min cap fired while 6 units were still at work (28 leaves left, decaying); then **6 257 of about 7 600 blocks placed in 128 minutes of placing**, the best run so far; sinks 2 395/2 395; 5 shut-ins dug out; 1 death; the tail held by 49 trapdoor scaffolds and 4 trapdoors 'no stance reaches it' under the slab floor over them | the cap at 15 min (157add02); placing under the feet (3047130b): standing on the block over a cell, its bottom face is clicked; the floating trapdoor's scaffold goes over it, in the opening of the slab floor, and the bot puts the trapdoor in under its feet (d6352a31) |
| `b081l` (6c3cc1bd) | stopped in its pit after 2 min for d6352a31 | |
| `b081m` (d6352a31, a forest) | pit round 1 5 295 s: the slowest units one leaf or vine cell for 370-650 s, and a tail of 16 min behind one leased unit (075: 6722aa58 bounds a cell's time; f98a9a0d lets a lease held while waiting expire); rounds 2 and 3 for 3 and 2 of the pit's own pumpkins; then **about 75 blocks a minute** placed over its first 40 minutes of placing (b081k: 49), 5 cells put in under the feet, sinks 709/709; but the first survey after the third round parked 12 cells of the build's own blocks as 'left by the pit' (slabs one under their layer, glass, a sticky piston, smooth stone over a retracted piston: its pistons had moved them), for good | a block whose kind is a blueprint item no terrain makes stays the crew's to dig and place again; terrain stays the pit's (b824af58). Stopped at minute 145 |
| `b081n` (b824af58) | stopped in its pit after 9 min for the machine rule below | |
| `b081o` (7eda0d59, a forest) | pit 189 s; about 75 blocks a minute, 1 812 placed by minute 34; no piston fired, no block landed off its cell, 127 clicks dropped on a clicked block that was gone; at minute 26 the crew stood still in stage prepare: 18 smooth stones over pistons placed unpowered were taken for the machine's other phase and dug, and those clears put the stage back to prepare | the other-phase rule only for a machine whose sources stand; a build block dug from a cell that stays empty is placing work (1d3ef6d0); a click waits a moment for the bot's own block before it (968060b3) |
| `b081p` (e4c41f31, a forest; the first build on 076's native physics, inventory and dig, the default on 1.21.1) | pit 1 533 s; blocks a minute per ten minutes of placing 57, 52, 34, 28, 22, 16, 22, 16, 4 while the supply trips' share of bot time rose from 0 to 55 % ('wait: a turn at the materials' 3 712 bot-s, the largest pause); read from the server: the chest held no smooth stone any more, a depot shulker box beside it 16 stacks that had dropped out of the depot list, so every trip read smooth stone as out (Bd4f: 17 trips for nothing); 765 parked at minute 117; no piston fired | every shulker box round the chest is the depot's again at each trip (6be997ee); a full pack puts what the trip does not ask for into the chest first (96cf14f1); `scripts/t26/pace_report.py` (b5a3a85e). Stopped at minute 117 |
| `b081q4` / `b081q5` (one frozen snapshot of e8c56323 in `/mnt/data/forgeaip-play/t26/snap-081`; world 4 native physics, inventory and dig (the 1.21.1 default), world 5 `NATIVE_PHYSICS=0 NATIVE_INVENTORY=0 NATIVE_DIG=0 NATIVE_INPUTS=0`; forest sites, a new seed each) | placing per ten minutes, native: 26, 58, 70, 63, 61, 50, 47, 16, 10, 17, 12, 2, 3, 6; mineflayer: 24, 89, 73, 54, 44, 52, 56, 36, 35, 18, 25, 28. Over their first 26 minutes of placing about 65 against 84 a minute, the walk failure rates alike (18 % and 16 % of searches failed). The native run's tail was its stock running out, read from the server: no smooth stone or redstone left in the chest and depot, 168 in all eight packs. Bd4g had fallen 39 blocks to its death with a full pack: it dug its pillar top and the bridge block under it while its position still showed it a block up; nobody went for the pack. Of 116 hand-overs 12 were taken back by the giver standing over its own toss and 6 left lying. No piston fired in either run; no block landed off its cell; the 60 s 'mover tick wait' stalls were one bridge tried every 3 s from a stance whose bed hid the support's side | the block the bot lands on is never dug, the walk-down waits for the landing; a dead bot's pack is picked up (36fe7261); a toss the asker does not get is taken back by the giver; the material ledger per item (2daab59d); a failed bridge is not planned again from the same cell for a minute (9c655532) |



**Machines built safely (orchestrator 2026-11-27, `src/build/machine.js`).** iron-farm-34 is one machine by the rule below: 7 353 cells, 48 sticky pistons facing up under
smooth stone, a redstone-block clock with two horizontal pistons, 24 redstone torches in a tower and one redstone block, no observers. In b081m 3 of the 12 cells left over
lay on a piston's push line (smooth stone at +2 over a retracted piston, glass at +3): the torches and the redstone block went in as soon as their support stood and powered the
half-built circuit. The other 9 lay on no piston line: blocks one cell off their own (slabs under their layer, glass and a piston beside theirs), most likely a click on a block
that was gone by then (the server puts the block into the clicked cell itself when that cell is replaceable).
- *Order*: a machine is a group of redstone parts within two cells of each other, with a margin of one and its pistons' push lines (13). Its power sources (redstone block,
  redstone torch, a lever that is on) are placed only when every other block of it stands; an observer only when the cell it watches stands. Every piston is placed with nothing
  powering it, and the survey builds the cells in front of it as the blueprint has them (the head's cell empty) until the sources stand; then the piston extends into the empty
  head cell and pushes nothing. Offline: no recipe of iron-farm-34 depends on a source (no deadlock); the tower's smooth stones over the torch cells take a scaffold beside.
- *Watch*: a piston of the build that fires and a cell that turns into `moving_piston` are counted, before any source stands (`stats.machine.moved` / `fires`, the progress
  line's `machineMoved`: the target is zero) and after (`movedPowered` / `firesPowered`: the finished machine running), each with the powered parts near it (`[machine]`).
- *Read-back*: a block that lands in one of the 26 cells round its own is logged with the click (`[misplaced]`, `stats.misplaced`); a click on a clicked block that is gone
  or that another bot is taking away is not sent (`stats.clickGone`, `clickGoneWhy`).




**Forest pace, second pass (TASK-075, 2026-11-27 02:20-04:30).** Changes on main, in order:
- Layer lookahead, ad485566 (Ledger option `lookahead`, pits 2): while a front unit is leased, bots take units up to two layers below, in columns whose rows above are settled.
- Canopy, a400cedf: after a NAV trip, every tree block of the box within reach goes, blind, from the top.
- NAV time split, baac9ac8 (`planCpuMs`, `planMs`, `moveMs`, then `sweepMs` and `waitMs`).
- A cell's time bounded at its root, 6722aa58: a tree block within reach is mined blind first. Every mine of a cell carries a 60 s deadline that env.exec passes to the router, the router to its travel, and NAV between steps. At most 120 s of NAV per unit. A caller with a deadline sweeps its movement blocks within 8, not 48.
- Leases renewed only while a worker works a claim, f98a9a0d. bt075u2: 8 bots waited 13 min behind one lease that nobody ran.
- The end pass descends a bot standing on its own pillar top, b43a9000.

Measured on 1.21.1:
- The slowest pit cell went from 403-912 s (b43a9000) to 49-86 s (6722aa58).
- NAV time on u1 adds up: planning 5 s (CPU 5.8 s), moving 333 s, sweeps 115 s, waits 1 s, unlabelled 17 s, out of 471 s. The planner's CPU is negligible in the pit (081's b081m: 11 s of 11 457).
- `bt075u1/u2/u3` (spruce / dark forest / jungle, stopped at 04:30 for the rerun on f98a9a0d): 426 / 0 / 45 tree blocks and 17 / 4 / 12 pumpkins in the box by server scan. u1 and u3 were stopped mid-pit. u2's pit was cut by 081's 15-min stall cap after the lease leak.

mine_b on 1.21.1 (3f110f6a plus lazily loaded later modules; worlds 1-3, x3):
- `mb075h` w1: 0 pumpkins, but the job hung for 54 min in the action layer's walk (`unit:plan` 60 s of every minute, the bot at y -28 under the pit, 51 levels below its layer). Cause open.
- `mb075h` w2: 0 pumpkins; one dirty layer (seals at x 17 hold back the lake in the box's wall).
- `mb075k` w3 (KILL_AT_END=1): the job finished by itself at 48 min, so the kill never fired (fixed: the kill now also comes in the job's own end). 1 pumpkin left: the bot's own pillar top under its feet (fixed in b43a9000). Not re-measured yet.

**Forest closing runs on f98a9a0d (`bt075v1/v2/v3`, 1.21.1, `LIMIT_MIN=60`, 2026-11-27 04:30-05:35), graded by server scan of the pit box (scripts/t26/scan.js).**

| Run | Cells | Budget (cells/7 x 1.5) | Pit | Tree blocks left |
| :-- | --: | --: | :-- | :-- |
| `bt075v1` old_growth_spruce_taiga | 6747 | 1446 s | round 1 1407 s (4.8 cells/s), round 2 one cell 564 s (night) | **0** |
| `bt075v2` dark_forest | 16699 | 3578 s | cut by the limit at 3638 s, 3765/4320 units | 193 (dark oak, oak, birch, 44 red_mushroom_block) |
| `bt075v3` jungle | 6624 | 1419 s | 4031/4032 units at 3598 s | 96 (95 bamboo, 1 oak_leaves) |

Not met: zero tree cells on all three, and forest pace of at least 0.8 of rock. What the runs show:
- The slowest cell is now 28-74 s on v1 and v3. On v2 some cells reached 167-482 s, which includes the canopy sweep's own mining (609 blocks).
- NAV's planner CPU is 0.3-6.4 s per run.
- Most of the lost time is outside cells and NAV, in station walks. The rate falls steadily as the pit reaches the terrain body under the trees, from 170-220 to 20-30 units/min. **Not the night guard:** an earlier note blamed it, but `scripts/t26/night_probe.js` showed the rule off on these Peaceful worlds (the service's RCON poll of the difficulty works: `isNight` false at 18118 on Peaceful, true at 18103 on Normal, world 1, 2026-11-27).
- The bamboo on v3 was not dug (cause open: bamboo is passable for the pit unless the job's `plants` asks for it).

**mine_b re-run (`mb075m` worlds 1-2, `mb075n` world 3 with `KILL_AT_END=1`; b7de5d7a; 1.21.1, Peaceful, x3, 2026-11-27 05:41-07:07): 0/3, pumpkins 3 / 3 / 1.**
- **w1:** the walk-planning hang came back. Pit1 stepped between 4,18,-42 and 4,17,-41 every 20 s for 25 min, with only `unit:plan` and `unit:walk` in the health line and no failure. The expert's station loop had no time bound. Fixed in c095edf7: a unit's stations end after 6 min, and a station that opened no cell is not chosen again.
- **w2:** 543 registered blocks (lake fills). The 5-min wrap-up ended with the job still running.
- **w1 and w2:** pumpkins left at varied heights (-12,-10,-39; -12,38,-39; -6,68,-42 / 13,65,4; 15,65,1; 15,6,9). The end pass did not finish within the wrap-up.
- **w3:** Pit3 was trapped from minute 18 at the bottom of a water pocket (water y 13-17 under stone at 18, Air -19, the breath reflex looping). Fixed in 071ea30a: the reflex digs the roof of the pocket. The kill came at the wrap-up, and the respawned bot could not reach the last pumpkin (10,12,1, in the pocket 57 levels down: 'stuck').

Also landed in this pass:
- b7de5d7a: bamboo is broken at its root.
- 278b220e: NAV's no-progress rule counts the climb toward a goal with a level. It covers the bed-side '8 segments without getting closer', and likely 076's move_a seed 7601 east-line stop, which gave up with the same message (not re-measured).
- f1e8f1e1: night_probe.js, showing the night rule is already off on Peaceful.

None of these is re-measured live yet.

**mine_b, deaths and recovery (TASK-075, 2026-11-27 07:00-10:35, 1.21.1, native physics default since 82f0d75d, Peaceful).**

| Run | Code | Result |
| :-- | :-- | :-- |
| `mb075p` w1 | 31058f02 | job finished at 36 min, 0 pumpkins, 0 deaths; one `sculk_vein` at y -35 kept a layer dirty → the pit spec takes `plants`, and mine_b asks for it (22a0e4d3) |
| `mb075p` w2 | 31058f02 | died in lava at minute 6 (three reflexes); keep_inventory false left only a pumpkin; then 'explore for cobblestone, gather cobblestone: missing_tool' for 20 min → the router ends an obtain at missing_tool (c4ee3f7c); the lava reflex flees up to 20 s (6ff19e67: lava costs about 1.1 s per block on the native physics, test) |
| `mb075q` w3 (KILL_AT_END) | 31058f02 | 1 pumpkin (2,-52,5, a pillar block) → the end phase reaches every temporary block by NAV (635b3955) |
| `mb075r` w1/w2, `mb075s` w3 | 22a0e4d3 | timeouts at 85 min; pumpkins 1 / 0 / 1; falls of 21 and 40 blocks in the dug pit (w1, w3); w1 respawned on its own pit floor at the world spawn with an empty pack → mine_b's setup: a tools chest (c4ee3f7c) and the respawn point beside it (97ac3537), world conditions like a player's base |
| `fg-on` / `fg-off`, `fg-trace` | 98c687bc+ | the fall guard on every work bot (98c687bc) held the pit bot 1192-1962 times and no unit was done; off: 8 units in 15 min. The stops are real: at 16,67,9, a hole 6 deep just outside the box, the walkers' paths cut past it. The guard is opt-in now (0a5ec9c7, setting `fallGuard`, `FALL_GUARD=1`) until the action layer's walk and NAV keep their paths off such cells |

move_a seed 7601 (`ma075s`, 97ac3537, Normal): 3/4. The east bot stopped again on the east line (688,71,7) after two deaths at night, and left 10 pumpkins at y 67. `scripts/t26/nav_probe.js` on Peaceful walked one bot 640,7 → 760,7 through the same zone in 34 s, so the stop is night survival, not a NAV move.

**Forest closing runs on 0a5ec9c7 / 3eaeb98c (`bt075w1-w4`, 1.21.1, native physics, Peaceful, fall guard off), tree blocks by server scan of the pit box.**

| Site | Cells | Budget (cells/7 x 1.5) | Pit | Tree blocks left |
| :-- | --: | --: | :-- | :-- |
| `bt075w1` old_growth_spruce_taiga | 7251 | 1554 s | round 1 4037 s (the last 2 units 30 min, a fern out of reach), round 2 8 cells | **0** |
| `bt075w2` dark_forest | 13229 | 2835 s | round 1 2618 s (5.05 cells/s, 0.72 of 7), round 2 5 cells 496 s: 3114 s | **0** |
| `bt075w3` jungle | 10473 | 2244 s | cut at 3620 s, 3510/4464 units | 1284 (unfinished) |
| `bt075w4` bamboo_jungle | 4755 | 1019 s | 081's stall cap after 15 min with 1 unit leased: 4210/4320 at 2958 s | 2 vines (bamboo: 0) |

Units over 30 s: spruce 102 (9798 s, median 68 s), dark forest 73 (4890 s, median 49 s), jungle 126 (18 221 s, median 77 s, p90 341 s, some cells 560-700 s), bamboo 63 (6089 s, median 61 s). NAV is 10-20 % of it, the planner's CPU 6-25 s per run. After these runs: every pit unit bounded to 6 min, the canopy sweep to 30 s (39e4917e). **Not met:** zero tree blocks on every site, and a pace of 0.8 of rock (dark forest 0.72; the others over budget).

**The fall guard for every bot (2026-11-27, 1.21.1, native physics, Peaceful; seed 474407178230372896, the seed where the guard had stopped the pit).** The guard was not wrong:
the movers asked for moves it rightly refused, or failed with and without it. Each stop is now recorded with who moved the body (`bot.__moveTag`, set by `runner.run` for every
command and move, and the walk's path node; `fallguard.js` episodes, mine_b `[guard]` lines; the fall reflex names the command too). What the trace found, in order:

| Cause | Evidence | Fix |
| :-- | :-- | :-- |
| NAV planned digs `mine` refuses: leaves at y 71 over a box top of 67 ('outside the work area'), the same plan made and refused 8 segments per goal | fg075c: the first 6 minutes of every run on the seed, guard on or off ('unit:walk still 60', 0 units) | `block.js refusal()`: one predicate for `mine` and NAV's `protectedFor`; a cell refused on a walk is not planned again on it (8ceaa45e) |
| A walk whose start cell is no planner node while the body stands on the edge of the next column nudged toward its own cell's centre, over the hole | fg075d guard on: 2 092 stops at -1.74,66,16.5; guard off: the same nudge is a fall (fg075e: 8 falls of 13-22 blocks in 6 min) | `motion.supportCell`: the walk starts from the cell that holds the body (1bb48a9d) |
| The walk on foot cannot reach a station two cells away when the bot is boxed in by the leaves of a tree it half took down | fg075h: `moveFail 'unreachable (cell 13,67,7)'` from 11,67,9; 13-14 'could not stand at the station' per run, on or off | the station walk goes once by NAV (dig, pillar, descend, bridge) before the corridor ladder (eb2f9c60) |
| A climbable cell (ladder, vine: BlockTags.CLIMBABLE) under the body holds it in vanilla; the guard did not count it, and the walk plans climb nodes | planner/guard comparison (no live case measured) | the guard counts it (7cee44f3) |

| Run (20 min at x3) | Code | Units at 18 min | Guard stops | Falls (reflex) | Pumpkins left (scan) | Station failures |
| :-- | :-- | --: | --: | --: | --: | --: |
| `fg-on` / `fg-off` | 0a5ec9c7 | 0 / 8 (15 min) | 1 192-1 962 / - | 0 / 6 | | |
| `fg075f` on / `fg075g` off | 1bb48a9d | 0 / 4 (16 min) | 171 / - | 5 / 5 | 0 / 2 | 13 / 14 |
| `fg075i` on / `fg075j` off | eb2f9c60 | 12 / 14 | 8 / - | 0 / 6 | 0 / 2 | 3 / 2 |
| `nm075a` native / `nm075b` mineflayer physics (`NATIVE_PHYSICS=0`), guard on in both | e1251fe7 | 14 / 15 | 589 (582 in one 10 s episode) / 7 | 0 / 0 | 0 / 0 | 3 / 3 |

The native-against-mineflayer pit pair of the morning (`mbab-native` / `mbab-mf`) was void (the guard on in both held the pit); the pair above replaces it: the same units with
either physics. The one long native episode was a walk settling onto its own goal cell 8,62,11, which the planner called standable and the guard did not hold (582 ticks, until
the walk's tick budget ended it); a guard episode now names the blocks under the body (9bf7f331) to find which block the two read differently.

The guard is on for every work bot again (`src/work/service/bots.js`; setting `fallGuard: false` or `FALL_GUARD=0` turns it off for an A/B). The remaining stops are single ticks
(a slide along an edge) and raw key holds of the recovery fixes (`sidestep`, `back_off`: forward held 0.8 s toward a cell checked one ahead), which the guard bounds.

**mine_b closing set 1 (2026-11-27 13:30-15:05, 1.21.1, native physics, guard on, Peaceful, 240 game min at x3; code e1251fe7 / cf4f7d85).**

| Run (world, seed) | End | Dirty layers | Pumpkins (scan) | Other temporaries | Deaths, falls | Cause found | Change |
| :-- | :-- | --: | --: | :-- | :-- | :-- | :-- |
| `mbc075a` w3 (-5730052918913428628, KILL_AT_END) | timeout 85 min, a wet box (1 666 fluid cells), wrap ran out | 85 | 0 | 512 rubble fills hanging over air (scan.js `HANG=1`), 1 556 registered `lake` | 1 (the kill) | the cell under a fill was dug by a later layer while the fill's own unit was given up | a fill directly over a cell goes first, or the cell stays closed (a2879008) |
| `mbc075b` w1 (4390586315330096192) | finished 60 min | 5 (lava at the bottom, seals kept) | 2 (x 17, y 31 and 20: outside the box, origin not recorded) | 23 seals holding lava back | 0 | not known | mine_b prints each leftover's history (bad43492) |
| `mbc075b` w2 (-6226881385077031126) | finished 44 min | 2 | 3 (2 fall-reflex blocks at -32,-49/-52,143; 1 at -17,22,153) | | 1 fall of 13 blocks with no command running | the end's NAV sweep fell after the cleanup and its reflex blocks stayed; the floor under the body may have been its own dig | the end runs again when its round placed movement blocks (14f29d6c); the pit never digs the body's support (f066c6df) |

Changes after set 1, in set 2 (code bad43492; all with tests that have negative controls): a fill block directly over a cell is dug first or the cell stays closed (a2879008);
the pit never digs the block that holds the body over a fall, also from the edge of the next column (`supportsBody` with the guard's own test, f066c6df); the end runs again
when its round placed movement blocks (14f29d6c); the tree pass reaches a column the walk cannot by one NAV trip (b57c1759). After set 2 had started: a cell's late steps (lift, bridge, descent and their mines, the unplug) end with the cell's 60 s (102f55ee); the tree pass mines a
low tree block in reach blind (8ca02513); a closed station away from the bot is reached by NAV (83ffdaca); the
breath reflex swims to the nearest air instead of only jumping (851a1880: `mbc075c` w2 drowned under a wet box after five jumping reflexes). Diagnostics: the slowest cell's
steps in the slow-unit log, the last command before a fall, the blocks under a guard stop, scan.js `HANG=1`, mine_b's history of every leftover temporary block.

**mine_b closing set 2 (15:07-16:35, code bad43492, same conditions).**

| Run (world, seed) | End | Dirty layers | Pumpkins (scan) | Fills left | Deaths | Cause found | Change |
| :-- | :-- | --: | --: | :-- | :-- | :-- | :-- |
| `mbc075c` w1 (-6203496559503448345) | timeout 82 min (the end's range check sent 40 units back: 'no station can reach' 6 band cells) | 105 | 2 (8 cells outside the box, y 27/31) | 0 | 0 | both placed by a NAV pillar in a cave; the walk run after it took the bot out of the tidy's reach, the end's sweep places nothing and could not get back | the first walk cell after a pillar/bridge/descent is its own step (31cbcc1b) |
| `mbc075c` w2 (8408650362352379667) | timeout 85 min, very wet (2 935 fluid cells) | 122 | 0 | 274 registered (the wrap keeps fills over undug ground) | 1: drowned at 14 min after five breath reflexes that only jumped | the reflex never swam sideways to air | the breath reflex swims to the nearest air (851a1880) |
| `mbc075d` w3 (1201687708277881827, KILL_AT_END) | finished at 54 min, killed in its end, end done after the respawn | 23 | 0 | 134 registered left by the hanging pass ('no standing column'); 79 rubble blocks over air | 1 (the kill) | fills over water that later ran off hang with no dig under them (the fill-above rule does not see them); one trip per block, 20 blocks in 2 min | clusters after each NAV trip, 400 blocks in 15 min (0fd60155) |

**mine_b closing set 3 (16:38-18:05, code 84892210).**

| Run (world, seed) | End | Dirty layers | Pumpkins (scan) | Fills left | Deaths | Cause found | Change |
| :-- | :-- | --: | --: | :-- | :-- | :-- | :-- |
| `mbc075e` w1 (903224742411829344) | finished at 52 min | 1 | 0 | 14 seals and lake fills kept (they hold water back) | 0 | | |
| `mbc075e` w2 (1733237499209969782) | 'finished' at 43 min with 64/64 units 'done', nothing dug after minute 14 | 109 | not graded: the end scan had 248 000 cells unloaded | 213 registered | 1: drowned in a pocket outside the box | after the death the bot walked 100+ blocks for cobblestone (mine refused 'outside the work area', the tools chest 'refused'), the box unloaded, and the expert's model read the unloaded cells as rock: every unit 'done' | a unit with unloaded cells walks back or fails as the bot's own (ac3cff35); an end scan with unloaded cells is no pass (bb127d36) |
| `mbc075f` w3 (6760809098413215353, KILL_AT_END) | timeout 85 min, a wet box; the wrap after the kill ran out of its 5 min | 30 | 3 (pillar blocks of the pit's rises and descents, registered) | 283 registered | 1 (the kill) | the blocks stayed 8-25 min out of reach of every later unit | after every unit the bot takes its own movement blocks within reach, stepping off its own block first (849e35e0) |

Over the three sets (nine new worlds, 1.21.1, native physics, guard on): no fall death and no lava death; three drownings on wet boxes (one before the breath fix,
one in a closed pocket after it); pumpkins left on 4 of 9 worlds (2, 3, 2, 3); those of sets 2 and 3 are traced to their placing command by the leftover history and their causes
changed since (set 1's pair at x 17 was placed before the history existed). Guard stops per world 0-1 on set 2 and 3. **Not met:** zero on all three worlds of one set; the wet boxes (lake fills kept or hanging, drowning, NAV 'stuck' into
a wet box) are the open part.

**Forest runs on 849e35e0 / 428d0965 (2026-11-27 17:30-18:40, 1.21.1, native physics, guard on, Peaceful, build_t `SITE_BIOME`, the pit stage only; the build stage was stopped).**

| Site | Cells | Budget (cells/7 x 1.5) | Pit | Tree blocks left (scan of the pit box) |
| :-- | --: | --: | :-- | :-- |
| `fr075b` old_growth_spruce_taiga | 5 081 | 1 089 s | finished 634 s (8.0 cells/s), stuck 0 | **0** (the box all air) |
| `fr075a` jungle (a mountain site, y 111-142) | 19 678 | 4 217 s | finished 3 593 s (5.5 cells/s), stuck 0 | **0**; 4 pumpkins in one column at -893,111..114,-883 (the build stage had started: not attributed) |
| `fr075c` dark_forest | 6 272 | 1 344 s | finished 1 800 s (3.5 cells/s), stuck 0 | 5 mushroom blocks (not in the pit's tree list), 20 bamboo, 1 pumpkin |

In the jungle the crew ran out of diamond pickaxes (two per bot in the supply: 'tool_held diamond_pickaxe' 27 times), and the slowest cells' time went to NAV trips
(139 s), pauses (69 s) and recovers (53 s), not to the late steps any more. **Not met:** the dark forest (mushroom blocks and bamboo left, 0.5 of rock pace).

**mine_b closing set 4 (2026-11-27 18:45-20:10, code main 6a1e7213, the harness ran the main checkout; same conditions as sets 1-3: 1.21.1, native physics, guard on, Peaceful, 240 game min at x3).**

| Run (world, seed) | End | Dirty layers | Pumpkins (scan, 0 cells unloaded) | Fills left (registered) | Deaths (server log) |
| :-- | :-- | --: | --: | --: | :-- |
| `mbc075h` w1 (4331971738747880703) | timeout 80 min, very wet (6 040 water + 116 lava cells in box and ring: an aquifer y 29-62 under the box) | 122 | **0** | 667 | 7 drowned |
| `mbc075h` w2 (-3225010002522430521) | timeout 80 min, wet (1 884 water) | 86 | **0** | 705 | 0 |
| `mbc075i` w3 (3038448690598417856, KILL_AT_END, a mountain box, spawn y 184) | timeout 85 min, killed in the end, the wrap ran its 5 min after the respawn | 69 | **0** | 0 | 1 (the kill) |

The first set with zero temporary blocks on all three worlds by the server scan, no fall and no lava death; the wet boxes are still the open part (seven drownings on w1, both wet
boxes timed out with their lake fills registered: the pit's intended terrain, contract point 5). The cause of the drownings: from the bottom of the aquifer neither the shore search
(14 cells) nor NAV (it swims only in the surface band) found a way, so the rescue answered 'stuck' and the bot sank again after every breath reflex. Changes after set 4, each with a
test and a negative control: the rescue goes up first from deep water or a closed pocket (`env.surface`, 6d607692; `scripts/t26/water_probe.js`: a pool 20 deep PASS in 4 s, a roofed
pocket PASS in 34 s, the code before FAIL 'stuck', `CONTROL=noop` FAIL); a pit worker gathers only what `mine` may break and goes back to its box for an item instead of exploring
away (f39cb329; mbc075e w2's 100-block cobblestone loop after its drowning); the pit's blind digs reach the action layer's 5.0 (5d2c4a9e; 081's b081u4 tail behind one leaf at 4.85);
the tree pass takes huge mushroom blocks and a bamboo stalk by its root, and a root under the box bottom by one NAV trip (1fd57956; fr075c).

move_a's 10 pumpkins on seed 7601 (`ma075s`) were a wild pumpkin patch: the same 10 cells (x 663-675, y 67) are pumpkins in an untouched world of that seed (scan.js). move_a now
grades only cells that turned into a temporary-block kind during the run (a block update seen by the bot, never a chunk load).

**Where TASK-081 stands (2026-11-27 12:30; Fabric 1.21.1 test worlds 4 and 5, iron-farm-34, 8 bots).** No run finished cell-correct, so the Done-when is not met.
- The best runs: `b081q5` (mineflayer) placed 7 332 of 7 608 blocks in 194 min of placing. The judge found 1 923 wrong cells; 1 512 of them are the 36 portals, never lit because the place stage never ended. The other 411: 141 smooth stone, 59 glass, 50 slabs, 26 obsidian, 24 torches and the redstone block (waiting for their machine, by the new rule), 23 repeaters, 18 beds, 14 wires, 8 pistons, 8 trapdoors, 5 comparators, plus 32 smooth stones one cell over their own in front of pistons.
- `b081q4` (native) judged 3 999 wrong (2 273 not placed).
- Temporary blocks left at the end: 1 pumpkin (q5), 9 pumpkins (q4).
- What stopped both is the stock. Every item runs at the blueprint's count plus 5 %, and both crews ran out of the items still to place. Read from the server in q5: of 81 repeaters, 53 stand, 5 are in the packs, none in the chest or depot, and 23 are unaccounted, with no death in that run.
- The leaks named so far, all addressed in code but not yet measured live:
  - a dead bot's pack (36fe7261)
  - a toss left lying (2daab59d)
  - a depot box lost from the list (6be997ee)
- The material ledger (2daab59d) names the rest in the next run.
- The pause table after (`b081q5`, placing minutes 45-240, 8 bots), against the before table (`b081a`, minutes 0-31):

| | before (b081a) | after (b081q5) |
| :-- | --: | --: |
| bot time in pauses over 0.5 s | 1 962 s of 14 880 (13 %) | 29 982 s of 93 120 (32 %) |
| cpu (planning) | 36 % of the pauses | 5 % |
| retry | 25 % | 34 % (plan after a failed walk 3 171 s, mover ticks 2 120 s) |
| waiting for another bot / the materials | (in other) | 26 % ('nothing to claim' 4 971 s: the stock out; the turn at the chest 3 611 s) |
| server | 6 % | 16 % |
| other | 33 % (unlabelled drive sleeps) | 19 % (the pit's last units during placing 5 254 s) |

The planning share fell from 36 % to 5 % of the pauses (fastblock, the flood's reach, the claim's runs). What is left is waiting for materials the crew no longer has, and retries after a walk that found no way.

### Round 2 (2026-11-27 afternoon): where the materials went, the end of the place stage, bodies stuck on partial blocks

Fabric 1.21.1 test worlds 4 (native physics, inventory and dig: the 1.21.1 default) and 5 (`NATIVE_PHYSICS=0 NATIVE_INVENTORY=0 NATIVE_DIG=0 NATIVE_INPUTS=0`), iron-farm-34, 8 bots,
supply = blueprint + 5 % (orchestrator: the margin stays; the leaks are found and closed). Every run starts from a frozen snapshot of main in `/mnt/data/forgeaip-play/t26/snap-081*`.

**The item watch (`src/build/items.js`, 54b7ed1e).** Every item entity that appears near the site gets a cause at its spawn and an end. The causes:
- a toss: a hand-over, or a drop;
- a dig whose drop missed a full pack;
- a death;
- popped: a block of the box turned into air without a dig of the crew; the log names what changed beside it;
- unknown.

The ends: picked up (and by whom), despawned, or merged. The material ledger (`[materials]`, every five minutes) splits the unaccounted items into four columns: on the ground, despawned,
dug out of the build without getting it back, and other. From 6eb412ce the ledger re-reads the chest every time a bot closes it (before, it read it only before the take).

| Leak, as the ledger and the server showed it | Run | Cause | Fix |
| :-- | :-- | :-- | :-- |
| 1 664 smooth stone and 2 levers 'other'; 'out of stock: lever'; read from the server: Bd5d carried a shulker box of 27 stacks of smooth stone in its pack, Bd4d three boxes of beds | `b081t5` (mineflayer inventory), `b081t4` (native) | a supply box taken out of the chest 'did not come out (another bot took it)' (3-4 times in every run, both modes) and was never put back or set down. In particular, a box that could not be set down went to `putBack`, which knew boxes only by the contents the client shows, and a slot of the pack shows none | boxes are told by name too (`supply.supplyBoxes`, 63ff8960): the supply's unless the blueprint builds with that kind of box. Used by the wait for a box out of the chest (by name, 1.5 s), `putBack`, the box that does not open and the end's repack |
| two stacks of smooth stone of a hand-over and a redstone despawned beside the giver ('took 0 back') | `b081u4` (native) | the asker had asked for more than its pack held (it got the pistons, glass and trapdoors); the giver's take-back did not find its own stacks | a toss gives no more than the asker's pack takes at that moment (`pool.room`). The take-back finds the stacks through the item watch too. Any build item lying 15 s is picked up by the nearest bot with room (`drive.recoverGround`, `stats.ground`) (92d7f71f) |
| a stack of 64 trapdoors and one of 64 smooth stone beside the chest, cause unknown | `b081u4` | most likely a split withdraw with a full pack left the stack on the cursor, and closing the window drops it | windows are closed with an empty cursor (`supply.closeSafe`) (92d7f71f) |
| 54 beds and 24 redstone 'unaccounted' for 10 minutes with nothing lying about | `b081r4` (857d85c1, no item watch yet) | the ledger read the chest only before the take, so pack-full deposits were missing from it | the chest is read after every use (6eb412ce) |
| glass short at the end of `b081q5` | `b081q5` | evacuations dug through the glass walls with no count: glass without Silk Touch is gone for good | an evacuation digs by the escape's rule: only blocks the crew gets back or has a spare of, then any; every block is counted (`stats.digOut`, `job.lost`, the ledger's dug column) (b194236e) |

**The end of the place stage (54b7ed1e).** An item that no container, no pack and no stack on the site holds any more parks its cells as 'out of stock: item' (`job.stock`, twice a minute).
The place stage can then end, and the late stage lights the portals. When the item comes back, its cells come back. Probe: a one-portal blueprint (`drivers-081/mkportal.js`,
an obsidian frame 16 x 5 around 14 x 3 portal cells), world 5, 3 bots: PASS, `lit` 1, the judge 0 wrong, in 2.7 minutes.

**The 32 smooth stones 'one cell above' in b081q5** are not misplaced. The blueprint has those sticky pistons extended (piston at +0, head at +1, stone at +2). `machine.js` builds the stone at +2 and leaves the head cell
empty until the machine's power sources stand. The sources were never placed (the stock ran out), so the pistons rested retracted, and the judge's rule for the retracted phase expects the
stone at +1. With the sources in, the pistons extend into the empty head cells.

**Bodies stuck on partial blocks (owner, watching b081r4 on world 4, 2026-11-27; 74d37e7e).**
- *What happened*: Bd4a stood at y 76.5 on a floating bottom slab, with air under it at y 75 and 74, read from the server. `feet()` put the feet into the slab's own cell, which is not free. The planner found no start ('no more cells, 1 cells' 49 times), and goto's answer was a jump and a new plan, over and over.
- *The feet*: a body on a partial block (slab, bed, repeater) has its feet in the cell over that block, and the block's top is the floor. A body on the edge of the block beside its cell stands on that block's column.
- *Moves from there*: a walk or drop off; a bridge that clicks the partial block's side at half its height. No pillar and no jump one higher, because from 0.5 the jump's peak stays under the cell over the feet.
- *No start*: when the planner finds no start and the body is on the ground, it does not jump. It logs `[move] no start` and the caller's escape takes the way out.
- *Beds and doors*: a two-cell block is not placed while a body is in its other cell. The server checks only the clicked cell against bodies and sets the bed's head regardless, which is how a bot was embedded in its own bed. The claim refuses such a stance (its own body or a crew member's stance), and the click is not sent while any body reaches into the cell (`stats.roomBody`).

**A column left by its bot (c062e27b, e8e9ba34).** `stats.columnsLeft` counts the blocks of columns a bot leaves standing, by why `unpillar` stopped. In b081t4's first 45 minutes, 50 of 80 such blocks
were 'a gap under it (pumpkin)'. The block under the bot was a released block of its own column that another bot had claimed to take away, so it read 'doomed'. The way down now reads that block as it stands.

**After the first pairs of round 2 (b081t, u, v: each stopped early for a leak found live).**
- *Out of stock*: an item is out only when the chest and the depot also hold none of it as last read. A trip whose pack filled before it reached the boxes no longer reports what those boxes hold as 'absent' (b5b79c85). In b081v4 (native), the 24 torch cells, the machine's power sources, were parked out of stock at minute 29 while the chest's boxes held all 26 torches.
- *Routes*: a walk's route stops holding the cells under it when the outermost walk ends. Before, it held them for 30 s, and the columns that other bots put up under it in that time could not be taken back by their placers (01b8347d). Of the 166 columns `_behind` left in b081t4/t5/u4, 107 had the reason 'a crew member on it or its route'.
- *Supply boxes*: a supply trip ends with no supply box in the pack (36e98e13). In b081w4/w5, bots carried boxes of glass, obsidian and beds for up to an hour, and the boxes came back only at the bot's next trip.
- *Clears*: a clear of the build's own block in the place stage is counted by what was dug and what its cell wants (`stats.clears`), and an item the crew does not get back goes into the ledger's dug column (3b02a0f9). In b081w4, 107 clears happened while 113 glass went missing with nothing on the ground. Glass dug without Silk Touch is gone.
- *Hot paths for TASK-082*, from a CPU profile of b081w5 (mineflayer physics, minute 100, 120 s, 64 % busy):
  - the builder's A*, `move.js plan0`: 49 % of all CPU, 77 % of the busy time;
  - inside the A*, the cell classification `View.raw` / `kind` / `fits` / `free`, with Map caches keyed by strings: about 25 %;
  - `tempCost` -> `touchesShape`: 7.7 %;
  - `deadly` / `nearLava` / `_lavaRegions`: about 5 %;
  - the claim's flood and the claim itself: 1.8 % and 1.5 %.
  Record: `/mnt/data/forgeaip-play/t26/out/b081-records/b081w5-profile.txt`.
- *The finishing pair*: `b081w4` (native) and `b081w5` (mineflayer), from `/mnt/data/forgeaip-play/t26/snap-081h` (b5b79c85), forest sites, `LIMIT_MIN` 240 + judge. At job minute ~107 they had placed 5 408 and 4 939 blocks, with no deaths. Their judges are read by the successor (the progress note in the knowledge-DB).
