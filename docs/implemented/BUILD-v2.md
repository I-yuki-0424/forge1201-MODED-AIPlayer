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
