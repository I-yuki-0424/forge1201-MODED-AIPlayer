# PIT-LAKE-v1: the pit's lake fill, the water countermeasure for bodies of water inside the box (2026-11-16)

`TASK-20261114-063` (owner 2026-11-16: "address the water countermeasure"). A body of water met by the pit's dig is replaced by blocks as a whole, column by column from the shore, before the cell next to it is dug; water deeper than the arm reaches is reported at once instead of being tried for an hour.

## Why the per-cell water rule was not enough

The pit's water rule (`pit.js` `seal`, `sealPlan`) fills the fluid next to the cell it is about to dig and then digs the cell. That is right for a seep, a spring or the edge of a pond, and wrong for a lake: a lake refills from its own sources (a bucket takes one source and its neighbours make another), so it can only be **replaced**, and the bot cannot stand over water. Everything further than the arm's reach (about four blocks) from the rim is never reached. The T26 `mine_b` on a coast chunk showed it: seed `8573729881198107154` holds an enclosed lake of about 110 cells per layer, ten layers deep, inside rock (`scripts/t26/mine_b.js` scan of layers 56-62 of the chunk 48..63 x 48..63); the old runs got 1 of 12 units done in 38 minutes (`mnb-a`) and 2 of 12 in 80 minutes (`cmp-expert-a`).

## What it does (`src/work/jobs/pit_lake.js`, hooked at the top of `handle` in `pit.js`)

1. When `handle(cell)` finds fluid in the cell or in a horizontal neighbour, the whole connected body (6-neighbour, inside the box plus the one-cell ring around it, from the box bottom to one above its top, at most 4,000 cells) is collected.
2. A **station** is chosen: a standable cell (`skills/world.js standable`) from which the most still-fluid, supported cells are within 4.0 blocks of the eye with a clear line (coarse march over solid cells), minus a soft cost for the walk. The walk is `goToStation` (lift, bridge, pillar, descend as for any station).
3. From there the cells are placed **farthest first**, re-reading after every block which cells now have a solid neighbour (`env.exec('place', {fluid: true}, {raw: true, maxTicks: 160})`: no router walk, 8 s at most per block). The blocks are plain blocks, not registered temporaries: the dig takes them out like stone (the expert model treats registered temporaries as rock).
4. **Column-complete order**: a cell is placed only when every fluid cell below it in its column is already solid. A block laid over unfilled water hides the water beneath from every ray (placing needs a clear line to a face) and nothing under a finished platform can be filled again. The platform therefore grows only over finished columns. (The first version filled the top layer first and failed exactly there: 60 of 252 cells, then "no standing place reaches the water".)
5. The result: `ok` when no fluid of the body is left, else the reason: `missing_item` (the pack ran out; the per-cell rule goes on and the next call continues), `too_deep` (no standing place reaches the bottom of what is left; `detail.columnDepth` is the measured depth), `unsupported`, `unreachable`, `timeout` (80 stations), `cancelled`/`died`. The caller never fails the unit for it: the old per-cell rule still runs afterwards. `PIT_LAKE=0` turns the pass off (A/B runs), the unit result carries `detail.lake` {calls, filled, stations, ms, left, reason}.

## Limits (measured, not hoped)

- **Depth.** Reach is four blocks and the order must be column-complete, so a column is fillable only if its bottom cell is within the arm of a place the bot can stand on (the shore, then the top of its own finished columns): about **two layers** of water beyond the rim. A deeper lake is finished at its rim and reported `too_deep`; its middle stays water. That is a property of the method, not of the code: nothing that places blocks from above can fill a deep lake bottom-up.
- Two tools would reach deep water and neither is in the T26 kit: **falling blocks** (sand or gravel placed into the top cell of a column fall through the water to the bed, so a column fills from the bottom without reaching it), and **placing while submerged** (a bot that can breathe under water: respiration, water breathing, a turtle helmet). Both are decisions for the owner (a sand/gravel stack in the `mine_b` kit; or a re-roll of spawn chunks with a lake deeper than two).
- Lava is a fluid for `isFluid` and is filled the same way; no test yet.

## Measured

| What | Result |
| :-- | :-- |
| `tests/test_pit_lake_pure.js` (fake world, in `npm test`) | shallow 6x6x2 lake filled 72 of 72 from the shore inwards in several stations, nothing shadowed; supply of 100 for 160 cells: filled 100, `missing_item`, 60 left, nothing shadowed; 6x6x7 lake: finished near the rim, `too_deep` with `columnDepth` 7, under 20 placements, nothing shadowed; no fluid at the seed: nothing; a sealed pocket: reported, not looped on |
| live smoke `lake-b` (seed -8223826995433110289, expert, pond planted by command, box = the pond's layers; NOT evidence) | pond 8x8x2, `PIT_LAKE=1`: **PASS in 480 s** (169 + 11 water cells, exact server comparison); `PIT_LAKE=0`: not finished after 12 minutes (163 registered temporaries, one unit stuck). Pond 6x6x6: both settings stuck after 12 minutes (too deep, as predicted) |
| natural chunks, `cmp4-*` (equal boxes, Peaceful, lake fill on) | seed 4461664185924705895, 7 water cells in the box: sweep PASS, expert FAIL (5 lake-fill blocks left at the box edge: the filled cells at z 30-31 were not dug afterwards because the units that owned them were parked "could not stand at the station"; open). Seed 8573729881198107154: the world-spawn chunk holds almost no water (1 ring cell), both PASS. The enclosed lake of that seed (110 cells x 10 layers) lies in the chunk 48..63 x 48..63, which is not the spawn chunk: not measured with the lake fill |

## Found on the way (all fixed, each with a note in the commit)

- The water rescue swam to the shore with the plain `move_to` and ended `stuck` again and again in a pond; it now uses NAV (`env.navFree`, the same walker with the operator-only cancel; the unit cancel also fires on drowning, which is exactly when the rescue runs).
- **No night rule on Peaceful** (`nav/shelter.js setDifficulty`, polled by the service over RCON because mineflayer does not know the difficulty on 26.1). The peaceful T26 tests waited out whole nights in a shelter; "`place` hanging 8-10 minutes" and "`fix:return` 6 minutes" in the health rows were a bot standing still.
- `mine_b` took the box from where the bot joined (random around the spawn): two runs of one seed compared different chunks. It is now the chunk of `bot.spawnPoint`. Its top is the top of the **terrain** (tree blocks do not count): a 150-leaf canopy over the spawn chunk of seed -8223826995433110289 set the top and neither pit method removes aerial trees (by design, `aerialTree`).

## Layered rule (owner 2026-11-17: unlimited depth) - my reading of the instruction, built and under test

The owner's method: call the level to dig Y; the level the bot walks on is Y-1. Liquid at Y-1 is replaced by temporary blocks first (and in the neighbouring range, where the liquid spans into it, blocks are placed to stop the inflow); when Y is done, Y-1 becomes the new Y and is dug together with the temporary blocks; the new Y-1 is treated the same, as often as needed. A water source that shows up later is removed; a partition that failed is placed again; forgotten temporary blocks are cleaned up as for movement.

What that means in the code (`pit.js` `lakeFill` + `floorFill`, `pit_lake.js` options `slab` and `exact`, `PIT_LAKE_MODE=body` = the old whole-body fill for A/B):

1. **The level and its floor.** When a cell has fluid in it or beside it, the water at the cell's level `y` and at `y-1` (the floor) is replaced over its whole extent (the box plus the one-cell ring, which is the partition against the neighbouring range): `fillLake` with `slab {lo: y-1, hi: y}`, still from the shore inwards and column-complete, but only two levels thick, so the depth of the lake no longer matters (the old whole-body fill gave up at about two levels, `too_deep`).
2. **The floor under every opened cell.** After a cell is dug (`handle`), the block under it is the floor the bot will stand on when this layer is the one being dug. Water there is replaced (`floorFill`: `fillLake` with `exact` and `slab {y-1, y-1}`) against a neighbour, seen through the hole the dig made. A floor cell without a neighbour to place against or without a line to it is kept in `plan.floorPending` and tried again after the next opened cell nearby (about 6 blocks, at most 12 per call, 600 kept).
3. **Registered temporary blocks.** The blocks are `temp: 'lake'` (new kind in `bot/temps.js`, `HOLDS_BACK`: only taken when no fluid lies beside or above). The pit model (`pit_expert.js buildModel`) treats a `lake` block as SOLID, not ROCK: the next layer digs it with the rest ("dig it out together with the temporary blocks"). What is left at the end goes through `cleanHanging` / `cleanLakeBlocks` / the seal pass of the job's cleanup, as before.
4. **Water that gets in anyway** is the old per-cell rule's business (`seal` after the dig: the source is filled, the cell dug again; `checkLayer` sends a unit back whose cells hold water or blocks). Nothing new there.

Not decided by me, to be seen in the runs: whether a floor cell in the middle of a lake can always be laid (it needs a neighbour that is already a block and a line of sight through an opened cell; the pending list is the answer to the order problem, not a proof).

## Open

- The lake-fill blocks are plain blocks that nobody owns: when the unit that should dig them is parked they stay (seed 4461, 5 blocks). Register them with a `lake` kind that the expert model does not treat as rock and that `cleanTemps` takes at the end, or let the final sweep (`pit_sweep.js`) count them as wrong cells again.
- Deep lakes (above) and **tree canopies / floating leaves** (below): in the spawn chunk of seed 4461664185924705895 every layer from 69 to 84 keeps 2-30 leaf and log blocks (the ground under them was dug away; `aerialTree` then calls them out of reach). A canopy pass with the NAV pillar (a standing cell in the air next to the leaf, built from the ground) is the next piece; not built.
