# MOVE-v3: the learned cell-level walk, trained on the PC's GPU, in the work layer (2026-11-11)

`TASK:20261111-060`. One small policy walks a bot to a target cell with the full action set (walk, bridge, pillar, descend, dig, take its own block back, wait, step aside) instead of the chain waypoint router -> path calculator -> escape heuristics. Design and reasons: [RL-MOVE-v3](../proposed/RL-MOVE-v3.md); this file is what was built, what was measured and what is still open.

## Where things are

```
rl3/                     python (JAX) trainer, runs on the PC GPU (scripts/rl3/pc.sh) or the VPS CPU (scripts/rl3-py.sh)
  sim.py   gen.py   obs.py   env.py   ppo.py   cli.py      the simulator, its seven world generators, the observation, the batched env, PPO, `python -m rl3.cli train|eval|export|golden|scenarios`
src/experts/move3/       the runtime in plain JavaScript
  spec.js rules.js obs.js    the contract with the trainer; rules.js and obs.js are line-for-line ports of sim.py / obs.py (tests/golden_move3.json holds 21 simulator states with observation and mask)
  policy.js                  the MLP (models/experts/move3.json), greedy over the allowed actions
  view.js                    the bot's world model turned into cell codes (own / other bots' / staying blocks from work/bot/temps.js)
  walk.js                    the loop: observe, mask, decide, execute with the action layer's commands, judge by where the bot stands
  stats.js                   counters (health row `move3`)
scripts/work/move3_live.js   live harness on a real Forge server (the demo server)
```

Wired in `env.travel` (`bot/env.js`): with setting **`move3`** on, a target within 48 blocks across and 30 levels is walked by `walk3` first; a farther target is refused at once (the chunk router's job); if the walk fails the chunk router, the old legs and the movement expert go on as before, so the learned walk can only add. The setting is in `settings` (API `POST /api/settings {move3: true|false}`), counters in every health row (`move3`: calls, ok, fail reasons, decisions, action failures, walks that had a failed action and still arrived = `recovered`, fell back and arrived).

## Interface (as in the proposal, with the changes the live harness forced)

- **Actions (19):** walk N/E/S/W (a cell: flat, step up 1, drop up to 3), bridge N/E/S/W (a block under the next cell, then onto it: the `bridge` move of `work/bot/bridge.js`, over air **or water**), dig N/E/S/W (feet or head cell of the neighbour), pillar, descend (the `descend` move), dig up, dig down, unlay (take one of its own blocks beside the floor back), wait, sidestep (spacing). Dig only takes the bot's own temporary blocks anywhere and natural blocks inside the pit box (`env.within`).
- **Observation (2,964 numbers):** an ego-centred patch 9 x 7 x 9 with five channels (solid, diggable, water, lava, other bot or other bot's block), the visit counts of the 9 x 9 columns (a memory), and 48 numbers: target vector and distances, pack, health, time since progress, last action, eight 12-block walkable rays, the two nearest bots. Nothing the bot does not see.
- **Mask:** the rules of `rules.js` decide which actions are allowed (the policy only chooses among them, and an action that just failed in this cell is left out for 4 decisions).
- **Reward** (sim): +1 arrival (minus 0.05 per own block left standing), -1 death, -0.01 per decision, -0.2 on another bot's block or placing next to another bot, +0.02 per block of progress in phase 1 (60 % of the updates), none in phase 2.
- **Policy:** MLP 2964 -> 256 -> 256 -> 19 (tanh), PPO + GAE, 1,024 envs x 128 steps, 500 updates (about 11 minutes on the shared RTX 3060 Ti with `XLA_PYTHON_CLIENT_PREALLOCATE=false`, `MEM_FRACTION 0.35`, `nice 10`, a pause file the owner can touch). The file is 4.4 MB (float32, base64).

## The simulator (rl3/)

A voxel world of 40 x 32 x 40 cells per environment (padded by 4), cell-level physics (standable = free feet and head, solid floor; walk / step up 1 / drop up to 3; falls of 4+ cost health by the vanilla formula, lava and the void kill; a place needs nothing but a free target cell, as the blind placements of `bridge` / `descend`), noise (a move that does not happen 3 %, a placement that misses 5 %, a dig that takes longer 20 %), and seven world generators from the failure geometry of the live logs: a leftover column over a dug pit (work 3-24 levels below), a ledge across a gap of void (3-14), the End entrance (platform, void, island 18-24 blocks away and up to 12 levels off), an open pit with walls and no road (bot at the rim), a wall across with one gap, a lake to bridge, a cliff to pillar up. A third of the worlds have a crowd (2-6 other bots moving, other bots' scaffolding). In recovery training (35 % of the episodes) the world hurts the bot once: scaffolding around it collapses, or it is moved to another cell nearby.

## Measured

### Simulator (held-out worlds, 1,400 = 200 per scenario, greedy policy, noise as in training)

Both policies below saturate the simulator (about 100 %; the first policy of the day, 99.6 % plain and 84 % recovery, did not and showed what the simulator lacked: swimming, and a bridge that steps onto its block). The simulator therefore cannot tell good policies from better ones: **the live harness is the measurement.**

### Live, real Forge server (the demo server), graded from the SERVER's position of the bot, not from its report: `scripts/work/move3_live.js`

The simulator's own worlds (28 of them: 7 kinds x 4, built with `/fill` from `python -m rl3.cli scenarios`, a pack of cobblestone and a pickaxe), one client at a time (four clients at once overloaded the server and corrupted the first runs: physics stalls, empty RCON replies). Arrival = within `near` + 1 across and `nearY` + 1 levels of the target by the server's position. Wilson 95 % intervals.

| | arrived | per kind (4 worlds each) |
| :-- | --: | :-- |
| **old chain** (chunk router, legs, movement expert; `env.travel` with `move3` off) | 12 / 28 = 43 % [26, 61] | cliff, lake, wall 4/4; column, gap, end, rim 0/4 |
| first learned policy (mv3), greedy | 23 / 28 = 82 % [64, 92] (twice) | column 4, gap 4, rim 4, lake 4, cliff 3, end 2, wall 2 |
| **shipped: mv4** (mv3 fine-tuned for 400 updates with the simulator's failure rates doubled, a small revisit penalty) | **28 / 28 = 100 % [88, 100]** | all seven kinds 4/4 |

mv4 per kind, median decisions / seconds of an arrived walk: column 13 / 11 s, gap 18 / 13, end 50 / 41, rim 26 / 20, wall 64 / 37, lake 34 / 21, cliff 40 / 18 (overall 32 decisions, 19 s). The old chain, where it succeeded, took 13 s (median). The policy's own computing is under 1 ms per decision (observation, mask and the 2,964 x 256 first layer together about 5 ms); a decision is 0.3-1 s of the action layer's work.

### Recovery after a failure (the owner's second condition): `PERTURB=1`

Once in every walk, between decision 6 and 30, the harness hurts the bot: **scaffolding collapses** (every cobblestone within 2 blocks beside and 3 below it is replaced by air: the bot falls) or **it is moved** (`tp` to another standable cell within 5 blocks, up to 4 below).

| mv4 | recovered and arrived |
| :-- | --: |
| displaced | 14 / 14 |
| scaffolding collapsed, bot survived the fall | 5 / 5 |
| scaffolding collapsed over an abyss or a long drop: **the bot dies** | 0 / 4 (a fatal fall cannot be recovered by any walk; the server respawns the bot far away) |
| **all injected failures that leave the bot able to act** | **19 / 19 = 100 % [83, 100]** |
| all injected failures, fatal falls counted | 19 / 23 = 83 % [63, 93] |

Reading: the 90 % condition is met for the failures a walk can recover from; it is not met if "failure" includes being dropped 20-40 blocks, which is not a movement failure but a death. Both numbers are given. In plain walks, 2 walks had a failed action on the way and both arrived (counters `recovered` / `withFail` in the health row measure this in production). The first policy's recovery was 17 / 17 survivable but only after two executor fixes found here (the walk from a lake: `rescueCell`; reflex waits).

### What the live harness found that the simulator could not (all fixed, each in a test or the harness)

1. **The support cell.** After a bridge or a dig the bot's feet cell can have no floor while the body rests on the edge of the next block (a few hundredths of a block): the policy saw "nothing under my feet" and waited for good (0/4 on some kinds). `supportCell` takes the standable cell the body overlaps most.
2. **A bridge that does not step.** The simulator's bridge only placed the block; the live `bridge` move places it and steps onto it. The policy had learned bridge + dig-down on the same cell and went round in circles live. The simulator now does what the move does (and the golden file was rebuilt).
3. **Bridging over water.** `bridge.js` treated only air as a cell to put a block into; over a lake it walked into the water. Water is replaced like air now (also for the pit's bridges).
4. **Reflexes** (a fall, lava) take the body and stop a command with `cancelled`; that is no cancel of the caller: the walk waits for the reflex and counts a failed action.
5. **Physics stalls** (`no physics tick for 3 s`, a lagging server) are not disconnects: the walk waits for the tick.
6. **Loops.** A deterministic policy in a state it never saw goes round in a circle (bridge east, take it back, bridge east ...): the same action in the same cell a third time is left out for 10 decisions; a failed action is left out for 4. A sampling temperature (`o.temperature`, `TEMP=` in the harness) exists, was not needed with mv4 and is off.
7. **Nothing allowed but waiting** (in a lake): after two such decisions the action layer's walk takes the bot to the nearest cell it can stand on.

## Wiring and safety

`env.travel` (every long walk: rejoin, container, station, the operator's `move_to`) tries `walk3` first when the setting `move3` is on (default on since the deploy of 2026-11-11, switchable on the Automation settings API): a target within 48 blocks across and 30 levels; a farther one is refused at once, a failed walk goes on to the chunk router, the old legs and the experts, so the learned walk can only add. `nearY`/`near` of the caller are capped (3 / 4) so that the policy walks the way it was trained; the caller's own arrival rule still applies. Counters in every health row (`move3`: calls, ok, refused, fail reasons, decisions, action failures, walks with a failed action, recovered, fell back and arrived, planning ms, tool ms). The policy file is checked against the code (`policy.js` throws on a different observation or action count and `defaultModel` then gives null: no learned walk, no message), the rules and the observation against the simulator's golden file (tests/test_move3_pure.js).

## Not done / open

- **Detours that need exploring** (a U-trap that opens away from the target, a wall with a gap 40 blocks away, a maze) are what the 9 x 9 patch, the visit memory and the eight rays can only partly see; the policy was not trained on them beyond the one wall with a gap, and a long walk still belongs to the chunk router. The learned walk does not replace the router for 100-block walks.
- The simulator is saturated: further improvement needs harder worlds (more kinds, deeper abyss work, fluids that flow) and live runs, not more PPO on the same ones.
- All 28 live worlds are the simulator's own generators rebuilt with `/fill` (the simulator was built from the pit's failure geometry, but they are not the End pit). The production counters (`move3` in the health row) are the measurement there, and no A/B on the running pit was made (a restart resets the stranded bots, as in ROUTE-v1).
- Falls that kill (a collapse over a long drop) are not recoverable; the reflex and the bed/respawn logic of the work layer are what comes after one.
- The 4.4 MB policy file is float32 base64 in git; a retrain adds another one (use `git lfs` or quantise before the next).
