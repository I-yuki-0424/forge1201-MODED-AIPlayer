# MOE-v1: many small experts with prerequisites and a gradient-boosted router, trained on the VPS (2026-11-09)

`TASK-20261109-046`. The owner's design notes of 2026-11-08 (knowledge-DB `LLM-records/2026-11-08-forge1201-moded-aiplayer-design-notes-2026-11-08-dpod-split-moe-router-bot.md`) move the RL part from DPOD into this repository and change its shape: one small model per item or action ("E", an expert), each with prerequisites, a router that reads the pack and the goal and decides which experts to call in which order, rule hardcoding fully allowed. This document records what was built, how it is checked, and what the numbers say. Code: `moe/` (Python; machine learning is the exception to Rust-first), `scripts/moe/`, and a change of the Rust simulator in `tools/sim`. Nothing ran on the PC.

## What was built

| Part | File | Job |
| :-- | :-- | :-- |
| Catalogue | `moe/catalog.json`, `moe/catalog.py` | 12 experts. Per expert: the item it `makes`, its `needs` (prerequisites), `goal`, `max_steps`, and the standardised start distribution it is trained on (kit ranges, junk it must ignore, ores placed around the start). Checked on load: unknown keys, a need nothing makes, two makers of one item, bad ranges are errors. |
| Expert policy | `moe/policy.py`, `moe/features.py` | One network per expert, ~40 k parameters: a context vector (self, clock, pack over the core items, block-category histograms of the 9x9x5 grid, what the 128 view rays see, entities, last result) and one row per offered command (the simulator lists K = 64); the score of a command is a small network over `[c_k, c_k * h]`, the value comes from `h`. The `progress` field (which milestones were reached) is not an input, so an expert cannot read the task off it. |
| Learner | `moe/ppo.py`, `moe/train.py` | PPO, GAE with an exact bootstrap at the cut, Adam. Reward = +1 at success, -0.2 at death, -0.003 per command, plus potential-based shaping on the number of goal items held (does not change which policy is best). Stops when the last 200 episodes reach 97 % success (at least 30 k steps) or at the step budget. |
| Rules | `moe/rules.py` | The requirement graph as code: which expert to run next to get `amount` of `item`. A better tool stands in for a worse one (`equivalent`). |
| Router | `moe/router.py` | XGBoost and LightGBM over (pack counts, goal one-hot, amount) -> expert id or `done`. Trained on 30,000 sampled states labelled by the rules (sparse random packs, the experts' own start kits, one-short / exactly / one-over at every threshold, with junk), evaluated on 8,000 other states. Labels never come from "which expert would succeed here" (counterfactual branching of the environment, DPOD review 2026-11-06). |
| Chain | `moe/chain.py` | Router + experts as one policy: ask the router, play the chosen expert until its goal is held or its `max_steps` is spent, ask again. |
| Simulator | `tools/sim/src/scenario.rs`, `run.rs` | New scenario keys: `end` (`have` items incl. the families `#log`/`#planks`, or a progress `entry`; `max_steps`, `max_ticks`, `die`) so an episode ends at the goal; `kit` counts as `[lo, hi]` drawn per episode; `outcome` (`success`/`timeout`/`died`/`days`) on terminal observations and `episode_end` rows. 27 Rust tests. |
| Controls and orchestration | `moe/solvers.py`, `moe/evaluate.py`, `scripts/moe/*.sh` | Scripted solver (positive control), uniform random (negative control), Wilson 95 % intervals, shard launcher (`--network none`, read-only, `--cpu-shares 256` so the owner's servers win under load). |

The 12 experts, in the order of the chain: `log`, `planks`, `stick`, `crafting_table`, `wooden_pickaxe`, `cobblestone`, `stone_pickaxe`, `furnace`, `coal`, `raw_iron`, `iron_ingot`, `iron_pickaxe`. Every craft belongs to the expert of its result, so no expert calls a crafting expert. The furnace expert ends holding a furnace; the iron expert puts it down.

## Protocol (fixed before any expert was trained)

1. **Held-out worlds.** Experts train on the tiles of worlds `vps-s0..s2` and are scored on `vps-s3`, `vps-s4` (other terrain, other start sites, other seeds). The start distribution is the same by design (an expert is the specialist of one standardised start); what is held out is the world.
2. **Controls on the same scenario and worlds.** A scripted solver that sees only the pack and the offered commands (positive control: a scenario it cannot solve says nothing about a learner) and a uniform-random policy (negative control).
3. **Claim per expert.** The expert passes when the lower end of the Wilson 95 % interval of its held-out success is at least 0.80 and above the upper end of the random control. It matches the solver when its interval overlaps the solver's.
4. **Router.** Held-out agreement with the rules and latency; then end to end in the chain: rules + scripted experts, rules + learned experts, XGBoost + learned experts, LightGBM + learned experts, on `chain-placed` (coal and iron ore placed on the surface) and `chain-natural` (a plain start).
5. Success is the simulator's own `outcome`, not the policy's belief.

## Results

Round 1 (2026-11-09, 03:46-04:19 JST, 12 experts, VPS CPU, no PC). Tables below are generated by `python -m moe.report`; `coal` and `raw_iron` are round 1 (see round 2).

### Experts

| Expert | Parameters | Steps to criterion | Train time | Held-out: learned | scripted solver | uniform random | Commands (learned / solver) |
| :-- | --: | --: | --: | :-- | :-- | :-- | :-- |
| `log` | 40642 | 36869 | 197.6 s | 0.97 [0.94, 0.99] | 0.98 [0.94, 0.99] | 0.28 [0.21, 0.36] | 6.3 / 6.1 |
| `planks` | 40642 | 32775 | 162.2 s | 1.00 [0.98, 1.00] | 1.00 [0.97, 1.00] | 0.76 [0.69, 0.82] | 1.0 / 1.0 |
| `stick` | 40642 | 36871 | 166.5 s | 1.00 [0.98, 1.00] | 1.00 [0.97, 1.00] | 0.38 [0.31, 0.46] | 1.0 / 1.0 |
| `crafting_table` | 40642 | 40964 | 185.9 s | 1.00 [0.98, 1.00] | 1.00 [0.97, 1.00] | 0.38 [0.31, 0.46] | 1.0 / 1.0 |
| `wooden_pickaxe` | 40642 | 77837 | 406.3 s | 0.99 [0.96, 1.00] | 0.99 [0.96, 1.00] | 0.01 [0.00, 0.05] | 2.3 / 2.2 |
| `cobblestone` | 40642 | 40963 | 196.1 s | 0.97 [0.94, 0.99] | 0.90 [0.84, 0.94] | 0.19 [0.13, 0.26] | 8.7 / 22.0 |
| `stone_pickaxe` | 40642 | 65546 | 338.8 s | 0.99 [0.96, 1.00] | 0.99 [0.96, 1.00] | 0.03 [0.01, 0.07] | 2.3 / 2.2 |
| `furnace` | 40642 | 53250 | 236.5 s | 0.97 [0.94, 0.99] | 0.99 [0.96, 1.00] | 0.11 [0.07, 0.17] | 2.7 / 2.2 |
| `coal` | 40642 | 300000 (budget, not solved) | 1596.8 s | 0.86 [0.81, 0.90] | 0.87 [0.80, 0.91] | 0.10 [0.06, 0.16] | 17.2 / 18.2 |
| `raw_iron` | 40642 | 300000 (budget, not solved) | 1565.7 s | 0.75 [0.69, 0.81] | 0.82 [0.75, 0.87] | 0.07 [0.04, 0.13] | 34.2 / 27.4 |
| `iron_ingot` | 40642 | 53257 | 254.6 s | 0.98 [0.95, 0.99] | 0.99 [0.96, 1.00] | 0.03 [0.01, 0.08] | 5.1 / 4.4 |
| `iron_pickaxe` | 40642 | 69637 | 329.8 s | 0.99 [0.96, 1.00] | 0.99 [0.96, 1.00] | 0.05 [0.03, 0.10] | 2.3 / 2.2 |

### Router

| Router | Held-out accuracy | sparse / kit / threshold / threshold+junk | Latency per call | Model size | Fit time |
| :-- | --: | :-- | --: | --: | --: |
| xgb | 0.9970 (n=8000) | 0.994 / 1.000 / 1.000 / 0.995 | 349 us | 1.56 MB | 5.5 s |
| lgb | 0.9976 (n=8000) | 0.995 / 1.000 / 1.000 / 0.997 | 112 us | 3.69 MB | 5.2 s |

### Chain

| Scenario | Router | Experts | Episodes | Goal reached | Mean commands | Experts' goals reached (episodes) |
| :-- | :-- | :-- | --: | :-- | --: | :-- |
| chain-placed | rules | solver | 60 | 0.47 [0.35, 0.59] | 491 | log 59, planks 59, stick 59, crafting_table 59, wooden_pickaxe 59, cobblestone 58, stone_pickaxe 58, furnace 34, coal 30, raw_iron 43, iron_ingot 33 |
| chain-placed | rules | net | 60 | 0.02 [0.00, 0.09] | 894 | log 58, planks 58, stick 58, crafting_table 58, wooden_pickaxe 58, cobblestone 58, stone_pickaxe 57, furnace 3, coal 4, raw_iron 16, iron_ingot 1 |
| chain-placed | xgb | net | 60 | 0.00 [0.00, 0.06] | 900 | log 58, planks 58, stick 58, crafting_table 58, wooden_pickaxe 58, cobblestone 58, stone_pickaxe 57, furnace 2, coal 8, raw_iron 16 |
| chain-placed | lgb | net | 60 | 0.00 [0.00, 0.06] | 900 | log 58, planks 58, stick 58, crafting_table 58, wooden_pickaxe 58, cobblestone 58, stone_pickaxe 57, coal 9, raw_iron 16 |
| chain-natural | rules | solver | 60 | 0.15 [0.08, 0.26] | 698 | log 58, planks 59, stick 59, crafting_table 59, wooden_pickaxe 58, cobblestone 57, stone_pickaxe 57, furnace 13, coal 8, raw_iron 19, iron_ingot 12 |
| chain-natural | rules | net | 60 | 0.02 [0.00, 0.09] | 895 | log 59, planks 59, stick 59, crafting_table 59, wooden_pickaxe 59, cobblestone 59, stone_pickaxe 59, furnace 1, raw_iron 3, iron_ingot 1 |
| chain-natural | xgb | net | 60 | 0.02 [0.00, 0.09] | 895 | log 59, planks 59, stick 59, crafting_table 59, wooden_pickaxe 59, cobblestone 59, stone_pickaxe 59, furnace 1, raw_iron 3, iron_ingot 1 |
| chain-natural | lgb | net | 60 | 0.00 [0.00, 0.06] | 895 | log 59, planks 59, stick 59, crafting_table 59, wooden_pickaxe 59, cobblestone 59, stone_pickaxe 59, coal 1, raw_iron 3 |


**Reading.** 11 of 12 experts meet the pre-registered claim (Wilson lower bound >= 0.80, above random); `raw_iron` (0.75 [0.69, 0.81]) does not, and `coal` passes only barely. Both ran to the 300k-step budget without reaching the 97 % stop criterion. `cobblestone` (8.7 commands) beats the scripted solver (22).

**Chain.** With scripted experts the chain reaches the iron pickaxe in 47 % of `chain-placed` and 15 % of `chain-natural` episodes (the ceiling of the rule system). With the learned experts it is about 2 % / 2 %, whichever router is used (rules, XGBoost, LightGBM give the same): the chain gets through the stone pickaxe in almost every episode and then spends its budget in `raw_iron`. Cause tested: `chain-placed` puts the ore 6-16 blocks away, the expert was trained on 2-12. Held-out, `raw_iron` on ore 2-6 blocks away: 0.99 (solver 0.99); on 6-16 blocks: 0.44 (solver 0.67). An expert is only as good as the start distribution it was trained on (DPOD review, point 2).

**Round 2 (started, not finished).** The catalogue now widens the ore distances (coal 3-16, raw_iron 2-16), raises the `raw_iron` budget to 150 commands and adds an "approach the visible ore" shaping term (`approach`). Round 1 is archived in `runs/r1/`. `coal` and `raw_iron` have NOT been retrained and the chain has NOT been rerun with them: `scripts/moe/train-all.sh --par 2 coal raw_iron`, then `scripts/moe/chain-all.sh`.


## What this does not show

- **Not the real game.** The simulator is more lenient than the Forge server (SIM-RUST-v1 section 10: mining 2.8x too fast, placements never fail, 5x too safe). Success rates here are rates in the simulator.
- **Placed ores.** In the standardised starts of `coal` and `raw_iron` the ore is put on the surface 3-12 blocks away. These experts therefore do not show that a bot can *find* ore; finding is the job of a movement expert, which v1 does not have. `chain-natural` shows what happens without the help.
- **No monolithic control.** Whether many small experts beat one goal-conditioned model on the same starts and the same total steps (the M1 control of the DPOD review) was not run. Nothing here supports "the split is better", only "the split works".
- **The router copies the rules.** Its agreement with the rules measures how well boosted trees represent the IF-THEN graph; it cannot make a better decision than the rules.
- **Movement and stuck-escape experts** (called at any time, notes 2026-11-08) and the experts for killing mobs, breeding, smithing are not in v1.
- **Transfer to the real action layer** (`src/rl`, `src/skills`) is not wired: the experts read the simulator's observation, which mirrors `skill_space.js`; running them against the Forge server is the next step.

## Run

```bash
scripts/moe/test.sh                      # 16 unit tests, no simulator
scripts/moe/baseline.sh EXPERT [N]       # controls on the held-out worlds
scripts/moe/train-expert.sh EXPERT       # train, then evaluate on the held-out worlds
scripts/moe/train-all.sh [--par 3]       # all 12
scripts/moe/router.sh                    # train and evaluate both routers
scripts/moe/chain.sh chain-placed xgb net 60
python -m moe.report /mnt/data/forgeaip/moe/runs      # the tables above (inside the moe-venv container)
```

Setup once: `docker volume create moe-venv` and install `jax==0.12.0.1 jaxlib optax==0.2.8 numpy==2.5.4 scipy xgboost lightgbm` into it with `python:3.12-slim`; `docker build -t moe-py:1 -f scripts/moe/Dockerfile scripts/moe` (adds `libgomp1`). Files go to `/mnt/data/forgeaip/moe` (`MOE_ROOT`).
