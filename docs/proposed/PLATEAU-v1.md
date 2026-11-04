# PLATEAU-v1: where the PC runs stop making progress, and why (2026-11-04)

Question (owner, after the runs of 2026-11-04 had finished): is the plateau still there, at which instruction does it begin, and is the cause that the
behaviour is never reached, reached with a probability too low to be learned, or something else? Nothing has been training since 02:43 JST (no learner or
shard process on the PC or the VPS), so the plateau is exactly the one in RL-TRAINING-v2.md: 13-14 of 24 progress entries per episode in runb, runc and rund.

Method (`tools/sim/entries.py`, `iron.py`, `ingots.py`, run on the PC over the observation and action files of runc, 2.0 M steps, 1,971 episodes; runb, 1,492
episodes, for comparison): per progress-list entry and per third of the run: the share of episodes that ended with it done; the share of episodes in which a
candidate that would achieve it was **offered** at least once; the share of such offers the policy **took**, against what a uniform choice among the offered
candidates would give; and the share of takes after which the entry was done on the next observation. (An entry that is never offered cannot be learned by any
policy; one that is offered but taken at the uniform rate has not been learned.)

## 1. Where it begins

Last third of runc (runb is the same within noise):

| Entry | Reached | Offered (episodes) | Taken / uniform | Success after taking |
|---|---:|---:|---:|---:|
| collect_wood ... craft_wooden_pickaxe, collect_stone | 0.95-0.99 | 0.85-1.00 | 6-21x | 0.7-1.0 |
| craft_stone_pickaxe / sword | 0.73 / 0.79 | 0.77 / 0.89 | 12x / 5x | 0.59 / 0.80 |
| craft_furnace, place_furnace | 0.88, 0.85 | 0.93, 0.86 | 7x, 2.7x | 0.27, 0.97 |
| eat_food | 0.57 | 0.65 | 3.3x | 0.69 |
| collect_coal, craft_torch | 0.74, 0.39 | 0.73, 0.40 | 4.8x, 4.8x | 0.41, 0.94 |
| defeat_hostile | 0.59 | 0.94 (43 steps per episode) | 1.5x | **0.20** |
| **collect_iron** | **0.26** | 0.33 | **1.6x** | 0.38 |
| **smelt_iron** | **0.07** | 0.08 | **1.4x** | 0.96 |
| **craft_iron_pickaxe** and everything after it | **0.00** | **0.00** | - | - |

The average of the reached column is the 14 of the plateau. The learned preference (taken / uniform) falls steadily with distance from what the scripted teacher
demonstrates: the teacher's coverage ends at craft_torch (`botsystem_teacher.py`: "the wood and stone tier ... everything above is left to the policy"), and from
collect_iron on the policy takes the right command only 1.4-1.6 times as often as chance. **The plateau begins at the iron tier: collect_iron (instruction 17 of 24)
is the first entry below 0.3, craft_iron_pickaxe (19) is the first that is never reached, in any of ~4,000 episodes of the three finished runs.** Over the three
thirds of runc the soft entries creep up (stone pickaxe .64 -> .73, eat .45 -> .57, torch .27 -> .39, iron .16 -> .26): that is the +1.8 of its progress curve;
nothing above smelt_iron ever moves.

## 2. Why: the iron chain, link by link (runc, 1,971 episodes)

| Link | Episodes | What limits it |
|---|---:|---|
| went below y = 50 / below y = 30 | 70 % / 37 % | depth is not the limit |
| iron ore offered to `mine` at least once (exposed within reach) | 31 % | **availability**: the candidate list offers only exposed ore; the bot digs down in most episodes but does not find ore |
| collected iron | 23 % | when ore is offered, 74 % of these episodes take it |
| ... held fuel whenever it held raw iron / ever saw a smelt candidate | 11 % / 12 % of all (49 % / 55 % of those with iron) | raw iron is held for 217 steps on average before smelting; fuel is held on 54 % of them, a furnace in reach (a smelt candidate) on **7.2 %** |
| smelted iron | 7 % | the furnace stands at the start base (placed in 86 % of episodes), the iron is found elsewhere: it needs a trip back or a new furnace (8 cobblestone), a plan the policy has no example of; once offered, smelting is taken (1.4x) and succeeds (0.96) |
| held 3 or more ingots | **1 %** (21 episodes) | an iron pickaxe needs 3 ingots = 3 ore, 3 smelts |
| of those, held 2 sticks | **1 of 21** (2 steps) | the sticks were spent on the stone tools earlier and not made again |
| an iron-pickaxe craft candidate offered | **0 steps** of 1,090 | no sticks (and a table in reach) |

## 3. Answer

It is neither of the two clean cases. By link:

1. **collect_iron, smelt_iron: reached, but rarely, and not because the probability of choosing them is low** once they are on offer (given offered, 74 % and 90 % of the
   episodes get them). The limit is whether the state ever offers them: ore exposed within 5 blocks in 31 % of episodes; a furnace within reach and fuel on hand in 7 % of
   the steps in which raw iron is held. That is an exploration / long-horizon planning limit (go to the ore, come back to the furnace, or carry 8 cobblestone and fuel
   to place one at the ore), and since the policy's learned preference for these commands is 1.4-1.6x chance, it has not learned that either.
2. **craft_iron_pickaxe and everything beyond it: never reached.** The entry is never even offered in the data (3 ingots in 1 % of episodes, 2 sticks in 1 of 21 of
   those). There is no positive example to learn from; no change of learning rate or entropy can fix a signal that does not exist. runa, runb, runc and rund (lr 3e-4
   to 7.5e-5) all end at the same place.
3. **Something else, two parts.** (a) The instruction scheduler: a pair is given the easiest entry neither partner has reached and entries expire after 150 commands;
   in runc the most assigned instruction is eat_food (4,241 of 20,857 assignments, reached 11 %), then craft_stone_pickaxe and craft_torch; collect_iron was assigned 1,901
   times and reached while assigned 50 times (2.6 %), so the time budget of an episode (about 1,900 steps) goes mostly to the soft entries before iron. (b) Fighting:
   defeat_hostile is offered in 94 % of the episodes, 43-70 times per episode, taken at the uniform rate, and succeeds in 0.20-0.27 of the takes (the bot dies or the mob is
   lost; the simulator's fights are gentler than the game's, SIM-RUST-v1 s12): half the episodes never get it.

## 4. What this suggests (for the owner's decision; none of it is implemented)

- The wall is a **credit and availability** problem at depth of 5+ chained steps, not a learning-rate problem. More steps with the same learner will keep adding the soft entries (+1-2) and nothing beyond.
- The cheapest tests, each answerable with the tools of this repository: (i) extend the scripted teacher through the iron tier and see whether the policy then takes
  those commands (the policy-side question: with demonstrations, is the probability learnable?); (ii) start episodes from checkpoints / inventories that already hold 3 raw iron or 3 ingots, a
  table and sticks (do the last links learn when they are offered?); (iii) offer `place furnace` and `craft` candidates that carry the needed materials to wherever the ore is
  (an action-set question: the chain needs a return trip the candidate list does not suggest).
- Whether this is the design's limit or a matter of data is not decided by these runs.

Files: `tools/sim/entries.py`, `iron.py`, `ingots.py` (usage in their docstrings); raw numbers `~/x/entries_runc.json` on the PC; checkpoints `/mnt/data/forgeaip/pc-runs-20261104/`.

## Addendum 2026-11-04: a cause this analysis missed (see [SCENARIO-v1](SCENARIO-v1.md))

The finding "`craft_iron_pickaxe` is never offered" (section 2, last row) was read as "no sticks and no table in reach". A scripted solver given everything (3 ingots,
64 sticks, a placed table) was **still never offered the pickaxe**: the craft candidates were cut to 6 in "not held first, then alphabetical" order, and with stone in
the pack `iron_pickaxe` is the 11th of 21 craftable results (`skill_space.js` and the simulator alike). So part of the "never reached" is a defect of the candidate list that
no learning rate could have changed, and the 0.00 for `craft_iron_pickaxe` and everything after it says nothing about the policy. The same applied to any late-alphabet recipe
in a full pack (the stone tier was less exposed because few recipes are craftable that early). Fixed in 73c1a488; the numbers above are left as measured.

