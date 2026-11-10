# PIT-EXPERT-v1: the open-pit mining expert, a station planner trained on the PC's GPU (2026-11-11)

`TASK:20261111-060`. For a chunk the system assigned, the expert decides where the bot stands and how deep it digs from there, so that one movement digs as many blocks as possible and the bot does not dig itself into a hole; it also digs the leftovers of earlier units that stand above the band within reach. The pit job runs it as the method **`expert`** (setting `pitExpert`, default for new pits once switched on).

## What it replaces

The tile sweep (`method: 'sweep'`, `pit.js` `stationsOf`) cuts a chunk into 5 x 5 tiles, stands in the middle of one tile, digs that tile's cells of ONE layer and moves on: 16 stations per layer, 16 cells per station, whatever the chunk looks like. The arm reaches 4.05 blocks from the eye, which is two layers below the feet and 3.9 across; a tile uses a quarter of it.

## How it works

- **Unit = a band of two layers of the whole chunk** (`planPit` method `expert`: `layers` = bands, `rows` = 1; `unitCells` returns the band's 512 cells, top layer first; the layer gate, `checkLayer`, the audit and the final sweep work unchanged, per band). The ledger holds one unit per chunk and band; chunks (or lanes) are the assignment the system makes, the expert works inside it.
- **Model (`src/experts/pit/model.js`, a port of `rl3/pitsim.py`):** the chunk as 16 x 16 x 6 cells (band 2, open space with leftovers above), the heightfield of what can be stood on (the cell above the top block; a water top cannot), the walk (step up 1, drop up to 3), the reach (a sphere of 4.05 from the eye, the block under the feet is never dug, depth 1 or 2 layers below the surface).
- **Candidates:** every column and depth with something to dig and a walk to it; the 64 best by cells minus 0.35 x walking distance are shown to the network with 17 numbers each (cells, water cells, distance, height step, share of the best, depth, edge distance, how much is left, is-it-here, level, position, what the second layer adds, **how many columns the bot can still walk to after the dig**, a bowl flag, what is left after) and 8 numbers of context.
- **Network (`models/experts/pit.json`, 31 KB):** one MLP 25 -> 64 -> 64 -> 1 scores every candidate (shared weights, permutation-invariant); the best allowed one is taken. Trained with PPO over the candidate softmax on the simulator, 500 updates, 1,024 chunks x 40 stations, about 25 minutes on the shared GPU.
- **Execution (`src/work/jobs/pit_expert.js`):** the walk to the station is `goToStation` (lift, bridge, pillar, descend are all there); it then digs every cell of the dig set, top layer first, nearest first, with `handle` (the water rule, retries, the pit's own failures) and blind mining (the server checks only the distance), picks up the drops, and asks again. A station that cannot be reached is not tried again, nor its neighbours within 3 columns; six in a row end the unit with the walk's reason. Bedrock, fixtures, the kept road, trees out of reach and unloaded cells are never dug (they are `ROCK` in the model). Without the network file the first candidate (greedy order) is taken.

## Measured

Simulator, 1,024 held-out chunks (fresh or half dug, leftovers, pockets of air, water and rock), same chunks for all three, time = digging 0.6 s per block + 1.5 s per station + 0.28 s per block walked + 1 s per move + 4 s per water cell, leftover 10 s per cell, stuck 30 s:

| plan | seconds per chunk and band | stations | cells per station | left | stuck |
| :-- | --: | --: | --: | --: | --: |
| tiles of 5 x 5 (the old order, but with the full arm: an upper bound of the old method) | 383.3 | 18.4 | 25.0 | 0 | 0 |
| greedy (most cells for the least walking, the same candidates) | 371.1 | 15.5 | 29.5 | 0 | 0 |
| **the network** | **354.2** | 15.9 | 28.9 | 0 | 0 |

What this says, plainly: **most of the gain is the geometry, not the learning.** Standing where the arm reaches the most (two layers deep, 3.9 across) needs about 16 stations for a band; the real tile sweep needs 32 for the same band (16 per layer) and digs 16 cells per station, so cells per movement go from 16 to about 29, a factor 1.8. The trained network beats the greedy choice by 4.6 % of the time (371.1 -> 354.2 s, 1,024 chunks) and the old order by 7.6 %, and never strands the bot in the simulator's chunks (stuck 0 for all three; an earlier version, trained when the bot could start on a one-way pillar, showed 0.3 stuck per chunk for the greedy plan: the bowl features were added after that). A chunk the real tile sweep would need about 435 s for by the same cost model is dug in about 354 s (-19 %; computed, not measured live).

### Live (the demo server, real Forge, real bots, graded from the server's blocks): `scripts/work/pit_live.js --method expert`

Same arena for both methods: two chunks (32 x 16) four layers deep (two bands) in a stone block in the sky, water planted in the ring and inside the volume, two bots, a lane per bot, graded from the server (nothing may be left in the volume, the ring seals must hold):

| | units (stations) | blocks per station | wall time | result |
| :-- | --: | --: | --: | :-- |
| tile sweep (`--method sweep`) | 128 | 16 | 861 s | PASS |
| **expert** (`--method expert`, network pit3) | 4 units, 64 stations (16, 17, 15, 16 per chunk and band) | **32** | **621 s (-28 %)** | PASS, 0 failed units, 6 seals placed, planning 0.7-0.9 s per unit |

The first live run of the expert found a real bug the fake world could not: a water seal inside `handle` walks the bot away from its station (placing needs a face to stand in front of) and the next cell is then 9 blocks away ("too far to dig"). The unit runner now goes back to the station before each cell and once more after a failure (a test builds exactly this). With the fix both bots finished their bands without a failed unit.

## Not done / open

- The learning gain over greedy is small; the network sees 64 candidates and no future. A planner with lookahead (or the full 3-D choice of where to dig a bowl and leave a ramp) is the next thing, not built.
- A chunk whose lanes are narrower than 16 or clipped at the box edge is modelled with rock beyond its edge; the network never saw such shapes in training (the simulator's chunks are always 16 x 16).
- The leftover pass of the final sweep (`pit_sweep.js`) still reopens whole bands; a leftover single block costs a band's worth of stations again (the expert then digs only the cells that are left, from the few stations that reach them).
- Not verified on the production End pit (a running job keeps its own method; a new pit gets `expert` when the setting `pitExpert` is on).
