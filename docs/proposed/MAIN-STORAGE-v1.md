# MAIN-STORAGE-v1: the owner's 196 716-block water-base main storage as a later build target (TASK-20261126-083, deferred)

The owner's optional, deferred request of 2026-11-26: build the main storage `water-base-main-storage.litematic` (a large structure with
advanced circuitry, parts under water, an order of placement that matters) with about 20 bots, the filters in its containers right, the
bots carrying and using shulker boxes, aiming at 6 hours. This file holds the offline analysis of the blueprint and what has to exist first.

## The blueprint (read offline, 2026-11-26)

File: `/mnt/data/forgeaip-play/schematics/owner-20261126/water-base-main-storage.litematic` (copied from the owner's PC instance
`Fablic1.21.1\instance\schematics\main-storage\`; 532 355 bytes, sha256 `2400b6b8...1ee9c0d0`, equal on the PC). Not committed: the repo is
public. Litematica v7, data version 3955 (1.21.1), author Seia_Y, 5 regions, enclosing box 163 x 72 x 339, volume 726 401.

| Measure | Value |
| :-- | --: |
| non-air blocks | 196 716 (426 block types) |
| water cells / waterlogged blocks | 10 689 / 3 461 |
| observers / hoppers / droppers / sticky pistons / pistons | 25 709 / 13 795 / 10 412 / 10 143 / 1 014 |
| repeaters / comparators / redstone wire / redstone blocks / wall torches | 9 565 / 5 922 / 6 217 / 3 652 / 3 098 |
| powered / activator rails, note blocks | 7 294 / 547, 7 083 |
| slime / honey blocks (moving machines) | 1 493 / 1 400 |
| block entities | 13 795 hoppers, 10 412 droppers, 7 448 chests, 5 922 comparators, 2 202 barrels, 1 171 dispensers, 529 shulker boxes, 120 signs, 2 ender chests, a beacon, a conduit |
| materials as shulker boxes (27 stacks of 64) | about 114 boxes for the blocks alone |

Container contents: 4 413 item stacks are named; 4 413 of them are the filter sea pickles named `╚═Dummy═╝` (e.g. hopper 12,25,8: slot 1
17 pickles, slots 2-4 one each: the usual sorter filter). Plain `sea_pickle` 25 741 in all. The contents also hold stock that is not part of
any machine: 158 277 white shulker boxes, 11 801 white concrete, thousands of farm goods, and one-off named items (player heads named
"Sapphire Gem", "I demand a refund - Xisuma", a "ConCorp Vault Key"): the blueprint was saved from a world with the storage in use. Five
white stained glass named `;;;;f1lt3r;;;;;` are filters too.

## Decision taken by the orchestrator (the owner may override)

Required contents = the filters only: every renamed sea pickle (`╚═Dummy═╝`, with its exact name, slot and count), the renamed glass
filters, and the plain items in the same filter slots of a sorter. The stock (the shulker boxes, farm goods and named curiosities) is not
part of the build: it cannot be gathered in survival (player heads) and filling it would be a supply test of 160 000 boxes, not a build.

## What has to exist first (why it is deferred)

1. A build that finishes at all: TASK-081 (iron-farm-34, about 7 600 blocks) has not passed the judge yet.
2. Pace: 196 716 blocks by 20 bots in 6 hours is 27 blocks per bot per minute. The best Overworld crews placed about 8 per bot per minute
   (hb7/hc1, 2026-11-25). The harness is CPU-bound (SPEED-v1: planner 60 %, block reads 23 % of busy CPU with 8 bots): 20 bots need the
   Rust core of TASK-082, and probably bots over several processes.
3. Order for machines: 25 709 observers and 10 143 sticky pistons fire on block updates while being built; slime and honey machines move.
   The builder needs a machine-safe order (for example power sources and observers last per machine, pistons placed retracted with nothing
   to push), and a check that nothing moved after each part (the server reads the cells back).
4. Under water: 10 689 water cells and 3 461 waterlogged blocks: placing in water, sealing and refilling in the right order (the pit's lake
   fill and `pour` exist; the build's water stage is to be checked at this scale).
5. Contents: 076's `set_contents` and litematic block-entity Items (in progress for the Nether side); the renamed pickles need anvil-named
   items in the supply (the harness gives them; naming by anvil is a later survival step).
6. Shulker boxes: the supply already unpacks boxes from chests (supply.js); carrying them on the bot, setting them down at the stance and
   taking from them there is new, and is what makes 114 boxes of material reach a 163 x 339 site.
7. Twenty bots on one site: the crew rules of BUILD-v2 (sectors, lanes, the shared pool) were measured with 8 per crew.

Start: after 081 and 082. First step then: a part of the blueprint (one region, e.g. `east-block`, 67 x 29 x 29) as the test target.
