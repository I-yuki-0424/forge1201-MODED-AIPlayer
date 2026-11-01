# GoalWM: goal-conditioned policy with an explicit-state world model (2026-11-01)

The policy and learner of RL run 4 on (run 5 on: with batch plan generation, `Idea4_O01_D01_S11`), replacing SkillTruck ([MODEL-SKILLTRUCK.md](MODEL-SKILLTRUCK.md)). Code: DPOD branch
`botsystem/skills-v2`, `scripts/botsystem_goal_wm.py` (model), `scripts/botsystem_goal_ppo.py` (server + learner),
`scripts/botsystem_wm_pretrain.py` (offline pretraining + evaluation E1). MLflow model `Idea4_O01_D01_S10`, experiment
`side-botsystem`. Design review and the objections behind it: DPOD `docs/core/STATE.yaml` TASK-20261101-031. Side track:
nothing here counts toward a DPOD roadmap gate.

## Why it changed

The owner's review of runs 1-3 (2026-11-01): a single objective (survive, then the dragon) cannot be reached without hints,
and a model trained only for diamonds or only for the dragon is not the goal. Agreed design:

| Proposal | Kept as | Dropped, and why |
| :-- | :-- | :-- |
| Goal subdivision, "free values" | goal tokens over the player-readable goal space; unnamed dimensions are free; goals relative to the value at assignment | a hand-written goal tree (dragon -> portal -> eyes ...) would hand the tech tree to the policy |
| Hamiltonian NN as a feasibility calibrator | world model with an inventory-balance floor (a loss never exceeds what is held) + hindsight reachability R(s, g) | an HNN conserves a smooth scalar in canonical coordinates; inventory dynamics are discrete and non-conservative (DPOD physics benchmark: HNN lost on dissipative systems and did not extrapolate) |
| Hidden dimensions as physical state | every input token is a physical quantity; the world model predicts the next physical state | internal hidden vectors stay learned (literal coordinates would cost capacity) |
| Action: time, steps, inventory and state on success | predicted by the world model per candidate, fed to the policy | supplied by the environment, they would be the consequence of the action handed to the model (answer leakage) |
| Surroundings: surface / what is visible in front | `view_*`: first-hit ray image of the field of view, 16 x 8 rays, 24 blocks, block category + item id + distance | a full chunk dump includes ores behind stone (x-ray) |
| Batch generation of plans (owner, 2026-11-02: "all tasks needed to reach the goal are generated at once") | built at the goal level (run 5): a plan decoder generates the whole ordered list of goal-space dimensions (up to 8) for the task at episode start by beam search; the policy then reaches each step in turn | concrete commands are not pre-generated: the environment lists the candidates of the current state only, so a command sequence cannot be written before the states exist |

## Observation (env v2.0, `src/rl/skill_space.js`)

v1.3 fields unchanged, plus `view_cat`, `view_item`, `view_dist` (128 each), `killed` (kills this episode per entity type, /8),
`clock` (episode age in days /10, log1p(step)/10). `hello` adds `vocab` (id -> name; the learner names task goals, the policy sees
ids) and `view_shape`. Mine candidates now pass the command's own reach-and-visibility goal (L17).

## Model (per step)

1. **Encoder** (goal-independent): 81 grid columns, own state + clock, 36 inventory, 8 entity, progress, kills, last outcome,
   32 view patches (2 x 2 rays each), 64 candidates, CLS; 2 pre-norm blocks, d 64, 4 heads (Truck's sizes).
2. **Goal**: up to 2 tokens (kind: item / kill / adv / night; id; log1p delta; progress so far; age). Each reads the encoded
   tokens by cross-attention; their mean enters the GRU (width 256) and a bilinear goal term on every candidate.
3. **World model** per candidate, from its encoded token: success probability, log duration, change of the 20 own-state
   numbers, change of every inventory count (floored at -held, straight-through gradient) and every kill count.
4. **Policy logit** = Truck's (token + bilinear memory) + goal term + u . stop_gradient(p_ok, log dt / 5, predicted goal gain),
   with the kind prior. One value head.
5. **Reach** R(s, g) = P(goal reached within 32 commands | encoded state), hindsight-labelled.

## Plan generation (run 5 on)

- **Decoder**: from the encoded start state and the task dimension T, an autoregressive head over the goal-space dimensions
  (end token + items + entities + advancements + night; their goal embeddings are the output table). Beam width 4, at most 8 steps.
- **Training** (hindsight, no tech tree written by hand): every episode yields the order in which dimensions were first raised;
  from anchor states every 64 commands, the target is that order up to a dimension raised later (its T). Own replay ring and
  the auxiliary optimiser.
- **Use**: a bot's episode starts with a plan (50 % for an owner task goal, else for an archive dimension); each step becomes the
  current goal, with T as a context token. A step whose reach R(s, step) < 0.02 is physically too early: replan (at most 4 times an
  episode). 30 % of goals stay archive-proposed (exploration).
- **E1 v2** (held-out `train3-s1`, `result_v2_plan.json`): next-step accuracy 0.407 vs a bigram 0.327 (484 test plans, 1190 train).
  The example plans are not yet task-specific (the same first steps for every task): 1190 sequences from runs 1-4 hold little
  more than the order of the first trivial raises. The decoder keeps training online in run 5.

## Reward changes (owner review, 2026-11-02)

- Goal bonus = b0 (1 - p) 0.5^n: scaled by difficulty p = max(R, archive success rate) and halved for each earlier reach of the
  same dimension in the episode, so thousands of trivial results stay below one log (test `test_owner_rule_goal_bonus`).
- Reward-v2 `mined.tool_multiplier` 1.25: a block mined with the proper tool earns 1.25x (owner shaping, not learned).

## Learner

- Goals: proposed from the archive of dimensions some bot actually raised, weighted p(1 - p) by R (intermediate difficulty;
  too-early goals are rarely proposed); 20 % owner task goals (a night survived, a diamond held, the dragon killed); 15 % two-token
  goals. Reached: +1 bonus, next goal; dropped after 150 commands.
- Reward = reward-v2 terms under the `dragon` stage weights (all 1.0) + goal bonus. Task fitness = the same without the bonus
  (`return_task` in episodes.jsonl).
- PPO as SkillTruck's (asynchronous, semi-MDP GAE, stored behaviour log-probs). The world-model/reach loss trains on a 12,000-
  transition replay ring with its own Adam and clip, once per PPO minibatch (the policy gradient stays on-policy).
- Offline pretraining on runs 1-3, v2 on runs 1-4 incl. the plan decoder (E1, held-out shard `train3-s1`): `docs/experiments/2026-11-01_botsystem_goalwm_pretrain/` in DPOD.

## Positive controls (DPOD `tests/test_botsystem_goal.py`)

- World model on synthetic physics: success AUROC 0.999, gained-item top-1 0.969, predicted inventory never below zero.
- Goal-only reward over the real file API ("+1 of item X"): goals reached per assignment 0.09 -> 0.26 (chance 0.125, ceiling ~0.8)
  in 97 updates; the policy's weight on the predicted goal gain rises (> 0.1).
- Two defects found by these controls and fixed before any run: a hard inventory floor stopped all gradient for items not held,
  and the summed world-model gradient under the policy's 0.5 clip never left the marginal.
- Plan decoder on two hidden chains: teacher-forced accuracy 1.000, beam reproduces both.
- Archive bookkeeping: wins never exceed tries (run 5 crashed on this at its first proposals; fixed before any update).

## E1 (offline, held-out shard)

| | v1 (runs 1-3) | v2 (runs 1-4, plan) | baseline |
| :-- | --: | --: | --: |
| success AUROC | 0.866 | 0.836 | 0.641-0.653 |
| duration MAE (log1p) | 0.285 | 0.290 | 1.90 |
| gained-item top-1 | 0.697 | 0.948 (copy gates) | 0.946 lookup |
| reach AUROC | 0.920 | 0.951 | 0.866 |
