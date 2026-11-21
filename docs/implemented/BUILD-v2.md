# BUILD-v2: the structure builder rewritten from scratch (creative crews, flight, placement into the air)

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
