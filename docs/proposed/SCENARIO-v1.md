# SCENARIO-v1: isolating why the agent does not get past iron (2026-11-04)

Owner brief 2026-11-04: run the next training under conditions that isolate why the agent cannot get past the iron tier. Premise: the agent starts
with 1 stack of stone, 2 stone pickaxes, 1 stack of sticks and 5 crafting tables; iron is always a cluster of 3 or more blocks; no enemies at the
start; every reward unrelated to iron is off; enough steps and episodes to tell the results apart; the PC's resources may be used. **A**: in front of
the iron, with a furnace and fuel in the pack. **B**: a furnace already placed and loaded, the iron relatively close. **C**: the furnace 50 blocks
away, the iron directly in front. And: build it general, because later isolation runs will turn other rewards off or start from other conditions.

## What came out first: the iron pickaxe could not be chosen

Before any training, a scripted solver (`tools/sim/tests/smoke_policy.py ... iron`, which sees only what the policy sees: the inventory and the
offered candidates) was run as the positive control that DPOD's rules ask for before a null result. It mined and smelted in 97 % of episodes of
scenario A and then **crafted the pickaxe in 0 of 32**, holding 3 ingots, 64 sticks and a placed table.

Cause (`docs/LESSONS.md`-grade, also in the knowledge-DB, `LLM-records/2026-11-04-forgeaip-rl-craft-candidates-...`): the craft candidates were the
craftable results "not held first, then alphabetical", cut to a quota of 6 (`src/rl/skill_space.js` `craftable()` + `QUOTA.craft`; the simulator mirrors it
in `tools/sim/src/obs.rs`). With cobblestone and sticks in the pack 21 recipes are craftable; the six shown were `bucket, cobblestone_slab,
cobblestone_stairs, cobblestone_wall, furnace, heavy_weighted_pressure_plate`; `iron_pickaxe` was the 11th. The command existed, but the policy
could not choose it. This is the same effect that PLATEAU-v1 saw as "an iron-pickaxe craft candidate was offered in 0 of 1,090 steps" and read as
"no sticks"; the real environment had the same code, so the PC runs runa-rund and every earlier run were exposed to it.

Fix (commit 73c1a488): the lists are cut after all of them are known, and `craft` takes every slot the other commands leave free (K = 64 is never
exceeded, `wait` stays; the order inside the list is unchanged, so no goal knowledge enters the list). Reproducers, each failing on the old code:
`tools/sim` `the_iron_pickaxe_is_offered_when_it_can_be_crafted_however_much_else_can_be`, `tests/test_rl_v2_pure.js` (fails with exactly
`bowl,bucket,chest,cobblestone_slab,cobblestone_stairs,cobblestone_wall`). The scenario knob `craft_slots: 6` restores the old rule (control file
`iron-a-craft6.json`).

Positive control, 45-60 s per scenario on real tiles (scripted solver, no learning):

| Scenario | Craft rule | collect_iron | smelt_iron | craft_iron_pickaxe |
|---|---|---:|---:|---:|
| A | old quota (6) | 31/32 | 31/32 | **0/32** (Wilson 95 % upper 10.7 %) |
| A | fixed | 30/30 | 30/30 | **30/30** |
| C | fixed | 30/31 | 30/31 | **30/31** |
| B | fixed | 17/28 | 16/28 | 5/28 |

B is low for the solver only because the iron is 10-16 blocks away, outside the candidate window (`mine` offers blocks within 10), and the solver has
no search behaviour; it shows that the chain works at that distance when the ore is found, not a ceiling.

A second simulator difference found on the way: `smelt` burned the first fuel in slot order (so a pack with tables and sticks ahead of the coal burned
two tables per three ingots) and counted a crafting table as fuel; the real command takes the fuel that needs the fewest items and a table is no fuel
(`gui.js`). Fixed in 5f57b016 with a reproducer.

## The scenario spec (general part)

`forgeaip-sim run --scenario FILE` (also `scripts/train/pc/wsl-sim.sh up --scenario NAME`). One JSON file describes how an episode starts and what pays;
unknown keys, items, blocks, progress entries, empty ranges and a `pre_done` without `score` are errors (a typo must not silently run another
condition). Schema `v: 1`:

| Key | Meaning |
|---|---|
| `id` | name, `[A-Za-z0-9_-]`; copied to the `hello` message (`start.scenario`) and to every episode's record |
| `kit` | items given at the start, in order (`{"stone_pickaxe": 2, ...}`; counts above a stack fill further stacks) |
| `on_death` | `empty` (default, the game's rule) or `kit` (the kit comes back after a death; the placed blocks stay) |
| `hostiles` | multiplier of the hostile spawn rate; `0` = none, default `1` |
| `craft_slots` | override of the craft candidate slots (control for the 2026-11-04 defect); default: all the other commands leave free |
| `place[]` | `id`, `block`, `size` (n or `[lo,hi]`: a connected cluster), `mode` `surface` (an outcrop on the ground, at least two blocks from the start) or `buried` (inside solid rock, `depth` below the surface), `dist` (horizontal blocks from the start, `[lo,hi]`), `bearing` (degrees from the start's heading, `[lo,hi]`, default all round). The start heading is random per episode, so "in front" is not one world direction. A placement must be walkable from the start (the walker's own flood, up to 80,000 cells); otherwise the site is rejected and another tile/site is tried |
| `reward.score` | progress entries that pay (default: all) |
| `reward.pre_done` | `"unscored"` = every entry not in `score` is shown as already reached from the first observation (so the learner's pair goals skip them), or a list of entries; never paid |
| `reward.weights` | weights of the reward terms (`survival`, `death`, `progress`, `invalid`), laid over every stage of the reward table |

Per episode the simulator writes into each shard's `events.jsonl` a `scenario` row (heading, start, what was placed where and its distance) and, at the
end, an `episode_end` row (steps, deaths, final inventory, the entries reached with the step of the first time); step rows now name the crafted /
smelted / eaten item. `tools/sim/scn_report.py` turns these into the per-condition tables below (reach per entry with Wilson 95 % intervals, median
step, learning curve in blocks, which furnace the first smelt used, the crafts that consume iron).

Not built (extension points, none needed by A/B/C): a start tick or weather, starting hunger/health, scenarios on the real Forge server (the real
environment has its own start code; only the candidate fix is shared), per-entry reward weights other than 0/1.

## The three conditions as run

Common (all three files in `tools/sim/scenarios/`): kit = 64 cobblestone, 2 stone pickaxes, 64 sticks, 5 crafting tables, 8 coal; iron = one connected
cluster of 3-5 `iron_ore` blocks on the surface; `hostiles 0`; `on_death kit`; 1-day episodes; **paid: collect_iron, smelt_iron, craft_iron_pickaxe,
craft_iron_sword, 1.0 each** (the other 20 entries shown as reached, nothing else pays: survival, death and invalid-command terms weigh 0).

| | Furnace | Iron |
|---|---|---|
| A `iron-a` | a furnace item in the kit | 2-3 blocks away, within 15 degrees of the heading |
| B `iron-b` | placed 3-5 blocks from the start, any direction | 10-16 blocks, any direction |
| C `iron-c` | placed 49-51 blocks away, any direction | 2-3 blocks away, within 15 degrees of the heading |

Decisions I took where the brief left room (all changeable in the files):

1. **"Loaded with fuel"** (B): the `smelt` command loads the furnace itself from the inventory and refuses (`missing_materials`) when the pack has no fuel,
   whatever the furnace already holds. A furnace "loaded" in advance changes nothing for the policy, so the kit holds the fuel (8 coal) in all three.
2. **The premise gives every run 64 cobblestone**, so in B and C the bot can also craft and place its own furnace (table + 8 cobblestone) instead of walking.
   Both routes are legitimate; the report counts which furnace the first smelt used (`scenario` = the placed one, `own` = placed by the bot).
3. **"Enemies"**: none at the start and none spawn (`hostiles 0`), and a death returns the kit, so the question is not confounded by survival.
4. **Rewards**: the learner's goal bonus stays on; with the other entries shown as reached it can only be paid for the four iron entries.
5. **Episode length** 1 in-game day (about 370-440 commands) instead of 3: the chain needs about 20 commands, and it gives 3 times the episodes per step.
6. **Which policy**: all three runs continue the plateau policy of run `runc` (checkpoint with its optimiser, same learner settings, lr 7.5e-5, entropy 0.03, GPU), 2 M
   new steps each (about 4,500 episodes). That is the same agent that stalled, now under the isolated condition. A fresh network is reported as the chance baseline.

## Baselines before training (zero-shot, 150 episodes, VPS CPU, `scripts/train/scn-eval.sh`)

Fixed generator, no learning. `runc` = the plateau policy; `rand` = an untrained network.

Episodes reaching each paid entry (share, Wilson 95 %); `route` = furnace of the first smelt, `scenario` = the placed one, `own` = placed by the bot. The A / `runc` run
was left running and has 449 episodes (the evaluator then had no stop rule; fixed afterwards, 150 requested for the others).

| Scenario | Policy | collect_iron | smelt_iron | craft_iron_pickaxe | craft_iron_sword | route of the first smelt |
|---|---|---:|---:|---:|---:|---|
| A | plateau (`runc`) | 305/449 (67.9 %, 63.5-72.1) | 163/449 (36.3 %, 32.0-40.8) | **3/449 (0.7 %, 0.2-1.9)** | 5/449 (1.1 %) | own 163 |
| A | untrained | 63/160 (39.4 %, 32.1-47.1) | 47/160 (29.4 %, 22.9-36.8) | 0/160 (0-2.3 %) | 1/160 | own 47 |
| B | plateau | 44/154 (28.6 %, 22.0-36.2) | 7/154 (4.5 %, 2.2-9.1) | 0/154 (0-2.4 %) | 0/154 | scenario 5, own 2 |
| B | untrained | 28/156 (17.9 %, 12.7-24.7) | 16/156 (10.3 %, 6.4-16.0) | 0/156 (0-2.4 %) | 0/156 | scenario 15, own 1 |
| C | plateau | 92/150 (61.3 %, 53.3-68.8) | 16/150 (10.7 %, 6.7-16.6) | 0/150 (0-2.5 %) | 0/150 | scenario 11, own 5 |
| C | untrained | 66/157 (42.0 %, 34.6-49.9) | 26/157 (16.6 %, 11.6-23.2) | 0/157 (0-2.4 %) | 0/157 | own 19, scenario 7 |

Reading (zero-shot, no learning): (1) the plateau policy finds and mines the ore well when it is in front (68 % in A, 61 % in C) and clearly better than an untrained network,
but turns it into a pickaxe in under 1 %, although the same interface lets the scripted solver do it in 100 %. (2) Where the iron goes: in A, 155 `iron_nugget` crafts in the 163
episodes that smelted (about one per episode; 1 ingot -> 9 nuggets), 15 shovels, 13 shears, 9 hoes, 6 shields; at the end of those episodes 144 of 159 held no ingot. Three ingots
are exactly one tool, so one wrong craft ends the chain. The untrained network does the same (43 nugget crafts in 47 episodes), so this is the shape of the craft list
(many cheap iron recipes next to one that matters) and not something the plateau policy learned. (3) Distance: when the furnace is 50 blocks away (C) the plateau policy
walked to it in 11 of its 16 smelting episodes, and smelts less often than in A (10.7 % vs 36 %); in B, with the iron 10-16 blocks away, it reaches the ore in 29 %.

## Reading rules (written before any training result)

Metric: share of episodes reaching `craft_iron_pickaxe`, over the last fifth of a run, Wilson 95 %.

1. **Learns the chain when the preconditions exist**: last-fifth rate >= 50 % and its lower bound above the upper bound of the same scenario's zero-shot rate. Then the plateau
   was about the states (the pack, the furnace, the ore being there), not about what the policy can learn.
2. **Does not**: the upper bound of the last fifth stays below 20 % after the 2 M steps, or overlaps the zero-shot interval. Then the limit is in the policy or its
   learning signal, and the per-episode diagnostics decide what to look at next (iron sinks: ingots spent on other iron crafts; entries reached but not repeated).
3. Between the two: reported as partial, no claim.
4. **Distance** (A vs B vs C): a difference counts only when the intervals do not overlap; the `furnace of the first smelt` split says whether the bot walked back or built
   its own, which are different answers to "does it plan the trip".
5. A run whose first block already equals the zero-shot rate and whose curve is flat is stalled in the sense of TRAIN-STATUS-v1; the TRAIN-STATUS verdict itself counts all 24
   entries and is not meaningful here (20 of them are pre-reached), use `scn_report.py`.

## Operation

```
scripts/train/iron-runs.sh up | status | report [--blocks 5] | down        # three runs on the PC (WSL2, GPU learner, 8 shards each)
scripts/train/scn-eval.sh --scenario iron-a --base zs-a-runc --ckpt <runc.pkl> --ckpt-steps 2001782 --episodes 150    # zero-shot on the VPS
python3 tools/sim/scn_report.py exchange <base> [<base> ...]                                                          # tables
```

The PC's supervisors pause every process 12:00-18:00 JST (owner rule 2026-11-02); `up` was scheduled for 17:55 JST (user timer `forgeaip-iron-launch` on the VPS) so that no
process sits idle on the GPU in the owner's hours. State: STATE.yaml `TASK-20261104-032`.

## Results

**Training was stopped by the owner at 18:23 JST (2026-11-04), about 15 minutes in, to free the PC and move the server. There is no training result.**
What was learned before that:

- 18:00-18:13: three concurrent runs hit `RESOURCE_EXHAUSTED` on the 8 GB GPU at the first update (30 % share each, also with `--enc-chunk 48`): the learner stayed alive but never updated
  (the supervisor does not notice). Two runs at a 38 % share work (the earlier configuration); `iron-b` was to start when one of the two finished. Not started.
- Iron-a and iron-c ran ~33,000 steps each (88 and 91 episodes, 9 and 8 updates): paid-entry rates are the zero-shot ones within noise (A: collect 72 %, smelt 43 %, pickaxe 1/88;
  C: 76 %, 32 %, 1/91). Nothing can be concluded; the numbers are in `docs/results/iron-isolation-2026-11-04/`.
- The reading rules above stand unchanged for whoever resumes.

To resume (same settings, from the plateau checkpoint, wave 1 then B):

```
scripts/train/scn-runs.sh up iron-a,iron-c --ckpt docs/results/iron-isolation-2026-11-04/plateau-runc.checkpoint.pkl --ckpt-steps 2001782 --budget 2000000 --seed 61
scripts/train/scn-runs.sh up iron-b      --ckpt <same> --ckpt-steps 2001782 --budget 2000000 --seed 61 --gpu-fraction 0.38     # after one of them is DONE
```

Data in git, `docs/results/iron-isolation-2026-11-04/`: per base the compact episode records (scenario placement + episode_end rows), the reports of the six zero-shot evaluations
(`zs-*.report.txt`), the partial training report and records, and `plateau-runc.checkpoint.pkl` (the plateau policy, 17 MB, the baseline of every comparison). Not in git: the simulator tiles
(833 MB, regenerate with `forgeaip-sim export`), the raw `events.jsonl` files, the partial iron-a/iron-c checkpoints (17 MB each, ~2 % of a run).

## Owner decision table (2026-11-04 night, applied unattended, owner away ~12 h)

Outcome of the A/B/C runs (PC part `iron-X-g`, last fifth of the run, Wilson 95 %; `high` = pickaxe rate >= 50 % with the lower bound above the zero-shot upper bound (reading rule 1),
`low` = upper bound < 20 % (rule 2), anything between = partial, no row applies); the owner's text, verbatim in meaning:

| Result | Verdict | Direct solution |
|---|---|---|
| A is also high (pickaxe reach rate rises sharply) | The candidate truncation bug is the main cause, and retraining resolves it. | Mix it into normal starts to check, and audit the presentation rates of other categories. |
| A stays low (around 2/436) | The problem is in the policy's selection (ingots turned into nuggets and similar). | Remove the incorrect iron tool crafts from the candidates, or suppress them. Add positive examples of the pickaxe as teacher data or as seeds for self-imitation. |
| A high, B low | Recognizing the furnace's location and using it is weak. | Add "move to the nearest furnace" to the candidates. Put the furnace's location in the observations. |
| A and B high, C low | Return over long distances is not maintained. | Add a return action to the candidates. Extend the teacher data until the return. Add an intermediate reward (approaching the furnace). |
| A, B and C all high | The layout of the environment (scarcity of iron, distance to the furnace) is the main cause at normal starts. | Teach building a new furnace near iron at normal starts (craftable with 64 stone). Adjust the material allocation at the start. |
| Gathering high, smelting low | Fuel or smelting action choice is weak (the simulator consuming the wrong fuel may have affected learning). | Recheck fuel handling, increase positive examples of smelting. |
| Smelting high, pickaxe low | Craft selection error (nuggets and similar). | Narrow the craft candidates, organize the rewards. |

If no row applies: use own judgment, fix the cause found, and try the main (normal-start, full-game) training so the time is used. Constraints that stay: no answer leakage or oracle at inference
(DPOD CLAUDE.md), so a fix must be a rule of the interface (candidate set, observation, reward) that holds identically at evaluation, never a scripted solution fed at run time.


## Presentation audit at normal starts (2026-11-05, owner table row "A is also high": audit the other categories)

The simulator now counts, per episode (`episode_end.audit`), how often a command list was cut by its quota and how often a command that matters was on the list but behind the cut.
Zero-shot `runc` on the plain game (`scenarios/normal.json`, 121 episodes, 41,861 decision steps), quotas as of 2026-11-04:

| list | cut in | hidden behind the cut |
|---|---:|---|
| place (quota 3, pack-slot order) | 35.7 % of 29,404 steps | crafting table 42.2 % of the 11,109 steps it was offered, furnace 15.8 % of 8,479 |
| smelt (quota 2, slot order) | 9.3 % of 3,778 steps | raw iron 55.6 % of 27 |
| eat (quota 2) | 3.2 % | - |
| craft (since 73c1a488: takes the free slots) | 0.0 % | - |
| mine / move_to / attack / tunnel / activate | <= 0.5 % | - |

The same defect as the craft cap, in two more lists, and it only shows in packs with many placeable stacks (normal starts; the kit scenarios hold 3-4 types, iron-c crafts a furnace
and so can reach 4). Fix (simulator `obs.rs` and `skill_space.js`, identical): place quota 8, smelt 6, eat 4; stations (crafting table, furnace) listed first in place, raw ores first in smelt, the
rest in slot order. Reproducers that fail on the old code: `scenario::tests::the_furnace_the_table_and_raw_iron_are_offered_however_full_the_pack_is` and
`tests/test_rl_v2_pure.js` "place lists the crafting table and the furnace ...". Same audit after the fix (127 episodes, 43,084 steps): hidden 0.0 % everywhere, place cut 0.1 %, smelt 0.1 %;
the unchanged `runc` policy reaches smelt_iron in 3 of 127 episodes (0 of 121 before). Caveat for the running A/B/C runs: they use the old binary; their kits make the place cut rare (A: 3 types) but iron-b/c can reach 4.


## Outcome of the A/B/C training runs (2026-11-05, 2 M steps each from `runc`, PC GPU; A and C ran 86 k / 77 k steps on the VPS CPU first)

Pickaxe reach, last fifth of the run (Wilson 95 % lower bounds in the text; zero-shot A 0.7 %, B 0 %, C 0 %): **A 57 %** (lower bound 54 %), **C 73 %** (70 %), **B about 38 %** and flat (not
50 %). Rule 1 ("learns the chain when the preconditions exist") holds for A and C. Collect and smelt reach 98 % in A and C; in B collect is 67 % and 97 % of those smelt.
Owner table: A high and C high -> "the candidate truncation bug is the main cause". B is low, but not for the table's reason: B's furnace is 3-5 blocks away and used (scenario furnace in 1,051 of 1,204
smelting episodes); what fails is reaching the ore 10-16 blocks away when it is not in front (A and C put it within 15 degrees of the heading). `move_to` offered only world-axis headings (8 at 6 blocks,
4 at 16), the view is relative to the facing, and `mine` reaches 5 blocks, so a seen ore had no action that points at it. A policy trained only on the iron scenario forgets the early chain (normal starts:
wooden pickaxe 100 -> 13 %, stone 99 -> 6 %, collect_iron 14 % -> 0 of 128): the main training starts from `runc`, not from these checkpoints.

Changes made on this finding: (1) presentation quotas and order (previous section); (2) approach candidates: the nearest seen block of each type beyond the mine range (the view's own first-hit rays),
rarest types in view first, at most 6, as `move_to` to the nearest standable reachable cell beside it with that block's item type (JS `skill_space.js` and `obs.rs`, tests
`an ore seen 12 blocks ahead ...` / `an_ore_seen_12_blocks_ahead_is_offered_as_a_move_with_its_item`, both also check that an ore behind the bot is not offered). Runs: `main1` = `runc` continued at normal
starts with change (1) only (the control); next `iron-b-ap` = scenario B from `runc` with (1)+(2), 2 M steps, compared with `iron-b-g`.

Positive control for (2), scenario B, same worlds and seed (505), the scripted iron solver of `tools/sim/tests/smoke_policy.py` (it sees only the inventory and the offered candidates), ~250 episodes each:
`iron` (falls back to random moves when no iron is minable) collect_iron 60.6 % [54.3, 66.5], pickaxe 27.6 % [22.4, 33.5]; `iron-ap` (takes the approach candidate for iron when offered) collect_iron
73.7 % [67.9, 78.8], pickaxe 40.5 % [34.6, 46.7]. So the interface change helps B by about 13 points of reach, not by more: the ore is offered only when it is inside the 110 degree field of view and
not hidden, the rest still needs turning and walking around. `iron-b-g` (learned, no approach candidates) reached 67 % (that is above the scripted random-walk fallback, below the scripted approach).

## Normal starts after 2.5 h of the three runs (2026-11-05 08:40 JST) and the iron-sink mask

At 2.4-3.0 M steps beyond `runc` (blocks of 60 episodes, collect_iron / smelt_iron / pickaxe):
`main1` (plain normal starts, presentation fix only, 3,169 episodes): 25 % / 11 % / 1 of 3,169, flat over all blocks (0.31 0.17 0.23 0.30 0.21; smelt 0.11 0.09 0.11 0.13 0.13): **the presentation fix alone does not move the plateau**. `normal-ap`
(VPS CPU, plain normal starts + fix + approach, 364 episodes): 27 % / 12 % / 0, flat. `normal-kit` (A/B/C materials, no furnace, natural iron, fix + approach, 2,284 episodes): the only one still rising,
collect_iron 0.13 -> 0.30 and smelt_iron 0.07 -> 0.19 across the blocks, first pickaxes (4 of 2,284, 0.01 in the last block). With the materials the policy builds its own furnace every time it smelts (267 of 267).
Where the iron goes (episodes that smelted): normal-kit 502 `iron_nugget` crafts (one ingot each) against 215 ingots rebuilt, ingots held at the end 0 in 250 of 270; main1 887 nugget crafts in 363 episodes.
At normal starts there are only one or two ingots per episode, so one nugget craft ends the chain (the zero-shot finding of the first section, now at the real start).

Owner table row "smelting high, pickaxe low" (narrow the craft candidates): a craft that burns iron (recipe uses iron_ingot, iron_nugget, iron_block, raw_iron, raw_iron_block) is not offered unless its result has a
progress entry (`iron_pickaxe`, `iron_sword`). One rule in both implementations (`skill_space.js` `ironSink`, `obs.rs` `iron_sink`), identical at evaluation; the crafts stay legal, they are just not on the list.
Tests: `candidates: crafts that burn iron without a progress entry are not offered` and `crafts_that_burn_iron_without_a_progress_entry_are_not_offered`.
Experiment: `normal-kit` stopped at its checkpoint and forked into `kit-ctl` (simulator build with fix + approach) and `kit-mask` (+ iron-sink mask), same seed 81, same checkpoint, both to 7.0 M absolute steps on the PC GPU;
the difference between them is the mask alone.
