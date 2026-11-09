# MOE-v2: seeing the target, a movement expert and a stuck-escape expert, and a chain that does not repeat a failure (2026-11-09)

`TASK-20261109-046`, second part. The first part ([MOE-v1](MOE-v1.md)) learned the crafting experts almost perfectly and failed at the ore: `coal` 0.67, `raw_iron` 0.68 held-out, and a learned chain that reached the iron pickaxe in 3 % of `chain-placed` episodes against 43 % for the scripted chain. This document records the owner's explanation (the ore is simply not visible), what was built to test it, the pre-registered predictions, and what the numbers say. Nothing here ran on the real Forge server.

![MoE v2 architecture](../diagrams/moe-v2-architecture.svg)

(The picture is `docs/diagrams/moe-v2-architecture.svg`. Dashed lines are what an expert may see, solid lines are control flow, red is the stall reflex.)

## Why v1 failed at the ore: two causes, one of them a bug

1. **Visibility (the owner's hypothesis, 2026-11-09).** In v1 an expert saw a 9x9x5 block grid, a fan of 128 rays reaching 24 blocks, and a `mine` list limited to 10 blocks. Ore 6-16 blocks away, behind a hill, or underground was not in the observation at all; the one measurement in v1 that varied the distance (`raw_iron`, ore 2-6 blocks: 0.99, 6-16 blocks: 0.44, scripted solver 0.67 there) fits this. The scripted solver was hurt by the same limit, which is why the "ceiling" of the rule system (43 %) was low as well.
2. **A defect in the chain (found by tracing, 2026-11-09).** The router asked again every time an expert's 150-step budget ran out; with an unchanged pack it returned the same expert and the greedy policy repeated the same behaviour. Traces of the learned chain show `raw_iron` called up to six times in a row with an identical pack (6 x 150 = the whole 900 budget). The earlier guess "crafting tables are consumed and re-crafted" was tested and is false: `crafting_table` stays at 1 in the pack after placing.

## What was built

| Part | Where | What |
| :-- | :-- | :-- |
| Target scan | `tools/sim/src/scan.rs`, `obs.rs` | For five groups (`log`, `coal`, `iron`, `way` = the scenario's waypoint, `sky` = the standing cell on top of the nearest highest column) the 3 nearest cells within 4 chunks of the bot's chunk, hidden or not, as vectors; per candidate the progress it makes toward the nearest cell of each group; **scan moves** (`move_to` toward the nearest target of a group, to the reachable cell nearest to it, flagged in `cand_feat[7]`). Switched on by the scenario key `scan`; without it nothing changes. Privileged on purpose (owner 2026-11-09, the RL part is separated from research); the real bot has every block of its loaded chunks, so the same scan can be made from the client's chunk data. |
| Scenario keys | `scenario.rs` | `waypoint` (`dist`, `bearing`, `detour` N = the longest-walk of N candidates, `depth` = inside the rock under a walkable cell), `trap` (`shaft` or sealed `pocket`, 3-40 blocks under the surface; the waypoint is the cell the bot started from), `end.reach`. 33 Rust tests. |
| Relevance | `moe/features.py`, `catalog.json` | The router names the groups that matter for the expert it calls; the expert gets the 4 nearest cells **of those groups** (vector, distance, group) plus the progress column, and nothing of the others. |
| Skill experts | `catalog.json` | `move` (walk to the shown target: open ground 6-64 blocks, longest-detour of 12, a waypoint 4-12 blocks inside the rock so the way is dug) and `unstick` (out of a shaft or a closed pocket; precondition a pickaxe). Called at any time, make no item. Budgets 1.5 M and 1.2 M steps, stop at 0.99 / 0.985 over 200 episodes. |
| Router | `moe/rules.py`, `router.py` | Inputs now: pack, goal, blocks to the nearest log/coal/iron (65 = none within 4 chunks) and `stalls`. Rules: a target farther than 6 blocks sends `move` first; 2 stalls send `unstick`. XGBoost/LightGBM copy the rules (labels from the rules, never from counterfactual rollouts). |
| Chain | `moe/chain.py` | **Stall reflex**: a call that ended without a change of pack or a 3-block step toward its target is a stall; the next call samples from the policy instead of the greedy action; after two stalls `unstick` is called. `--greedy-stall` reproduces the v1 behaviour as a control. |
| PC runner | `scripts/moe/pc.sh`, `scripts/moe/pc/jobs.py` | Runs everything in WSL2 on the owner's PC without docker (probe, install, run, status, peek, pull, stop). |

## Protocol (fixed before any v2 expert was trained)

Held-out worlds `vps-s3`, `vps-s4`, 200 episodes per scenario, Wilson 95 % intervals, scripted-solver and uniform-random controls on the same scenarios, success = the simulator's own `outcome`, as in v1.

Positive controls measured before training (VPS, 60 episodes, scripted solver; the scan makes the tasks solvable):

| Scenario | Solver success | Commands | Note |
| :-- | --: | --: | :-- |
| `raw_iron` (ore 2-48 blocks) | 0.90 | 62 | v1, ore 2-16 blocks, no scan: 0.80 |
| `coal` (ore 3-48 blocks) | 0.95 | 31 | v1: 0.77 |
| `move` (open ground 6-64) | 1.00 | 2.2 | |
| `move-detour` (longest walk of 12) | 1.00 | 3.9 | the tiles have few obstacles; see limits |
| `move-dig` (waypoint 4-12 in the rock) | 0.95 | 8.7 | |
| `unstick` shaft / pocket | 0.65 / 0.63 | 66 / 68 | |

**Predictions.** P1 (visibility): with the scan the learned `raw_iron` and `coal` pass the v1 claim (Wilson lower bound >= 0.80 and above random) at ore distances 2-48, where v1 without the scan failed at 2-16; and match the solver. P2 (reflex): the learned chain with the stall reflex beats the same chain with `--greedy-stall` on `chain-placed`; the router kind (rules / XGBoost) does not matter, as in v1. P3: movement reaches >= 0.99 on open ground. If P1 fails the next suspect is the observation of the candidates and the reward shaping, not the amount of training.

## Results

(filled in below as the runs finish)
