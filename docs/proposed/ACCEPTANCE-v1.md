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

## Not claimed

Nothing in this document has been measured yet. Rates from the simulator are never evidence (CLAUDE.md, verification standard).
