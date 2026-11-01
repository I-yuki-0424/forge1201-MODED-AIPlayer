# SkillTruck: what each part is and how it works (2026-11-01)

The policy and learner of RL training v2 ([RL-TRAINING-v2.md](../proposed/RL-TRAINING-v2.md)), written for re-evaluating
and rebuilding the model. Code: DPOD branch `botsystem/skills-v2`, `scripts/botsystem_skill_truck.py` (model) and
`scripts/botsystem_skill_ppo.py` (server + learner). In MLflow it is model `Idea4_O01_D01_S08` (runs `train`, `train2`) and
`Idea4_O01_D01_S09` (with the kind prior, run `train3` on), experiment `side-botsystem` (see "MLflow" below). Side track:
nothing here counts toward a DPOD roadmap gate.

## The loop in one paragraph

Every bot runs one command of the action layer at a time (`move_to`, `mine`, `tunnel`, `attack`, ... 1 tick to 60 s).
When the command ends, the environment (`src/rl/run_skill_env.js`) sends an observation that lists up to K = 64 concrete
commands the bot can carry out from where it stands (the candidates). The server answers with the index of one; the bot
runs it; the reward of that step arrives with the next observation. One RL step = one command, so steps have different
lengths (`dt_ticks`); the discount is per second of game time.

## Input: the observation (environment side, `src/rl/skill_space.js`)

| Field | Shape | What it is |
| :-- | :-- | :-- |
| `grid` | 405 | block category (11 classes: air, soil, stone, log, leaves, planks, liquid, ore, sand, other solid, unloaded) of a 9 x 5 x 9 box around the feet (y -2..+2) |
| `self` | 20 | health, food, saturation, level, armour, air, on ground / in water / in lava / sleeping, time of day (sin, cos), night, rain, dimension (3), height y/128, heading (sin, cos) |
| `inv_item`, `inv_count` | 36 each | item id and count/64 of each inventory slot |
| `ent_type`, `ent_feat` | 8, 8 x 5 | the 8 nearest entities within 16: type id; dx, dy, dz /16, distance, is-player |
| `progress` | 119 | what the advancement and statistics screens show: 110 advancement flags, 7 notable-kill flags, nights survived /10, nights slept /10 |
| `cand_cmd`, `cand_item`, `cand_ent` | 64 each | per candidate: command kind (13 incl. padding), the block/item it is about, the entity it is about |
| `cand_feat` | 64 x 8 | per candidate: dx, dy, dz, distance (/16), count/64, in reach, night, held |
| `cand_mask` | 64 | which of the 64 slots hold a candidate |
| `last_reason`, `dt_ticks` | 1, 1 | how the previous command ended (ok or one of 16 reasons) and how many ticks it took |

The candidates are built from client-side state only and, since v1.3, only from commands the action layer can carry out
from here: targets the walker reaches (one flood over the planner's moves per step), blocks a held tool harvests, stations
in reach. Quotas per kind: move_to 12, mine 11, tunnel 12, craft 6, attack 4, place 3, and 1-2 for the rest, wait always.

## The model (per step)

1. **Tokens** (194 per step, width d = 64): 81 grid-column tokens (the 5 heights x 11 categories of one column, one-hot,
   through a dense layer, plus a learned position per column); one token each for own state, progress, target T (the
   learner's goal in the progress space) and the last outcome (reason embedding + log dt); 36 inventory tokens (item
   embedding + count) and 8 entity tokens (type embedding + features), masked when empty; 64 candidate tokens (command
   embedding + item embedding + entity embedding + features), masked when padding; one CLS token. Each token also gets a
   learned type embedding (9 types).
2. **Transformer**: 2 pre-norm blocks, 4 heads, MLP 4d, attention bidirectional over all valid tokens (so every candidate
   sees the grid, the inventory, the other candidates).
3. **Memory**: a GRU (width 256) takes the CLS output and carries h across the steps of an episode (reset at its end).
4. **Policy readout**: logit_k = w . token_k + (W h) . token_k / sqrt(d) for each candidate k: the first term scores the
   candidate from the current step, the second lets the memory re-rank it. With the kind prior (S09) each logit gets
   - log(number of offered candidates with the same command), so an untrained policy is uniform over command kinds first and
   over targets within a kind second. Padding gets -1e9.
5. **Value**: one linear head on h per curriculum stage (the reward changes meaning at the stage switch).

| Part | Parameters | Share |
| :-- | --: | --: |
| GRU memory | 247,296 | 47 % |
| item embedding (1,955 items incl. Create) | 125,120 | 24 % |
| transformer blocks | 100,096 | 19 % |
| own state, progress, target, dt, feature projections, CLS, types | 18,560 | 4 % |
| readout (logit + bilinear) | 16,513 | 3 % |
| grid columns | 8,768 | 2 % |
| entity embedding (125 types) | 8,000 | 2 % |
| command and reason embeddings | 1,920 | < 1 % |
| value heads (2) | 514 | < 1 % |
| **total** | **526,787** | |

## The learner (`botsystem_skill_ppo.py`)

- **On demand**: each observation is answered as it arrives (one forward pass for what arrived in the same 10 ms poll);
  bots never wait for each other or for training.
- **PPO, asynchronous**: segments of 32 transitions per bot; 16 segments make one update (3 epochs x 4 minibatches, clip 0.2,
  entropy 0.01, value 0.5, Adam 3e-4, global norm 0.5). Behaviour log-probs are stored, so actions taken with parameters one
  update old are corrected by the ratio (`staleness_mean` in the log).
- **Semi-MDP returns**: discount gamma_s^(dt/20) with gamma_s = 0.999 per second; GAE lambda 0.95; rewards divided by a
  running std of returns per stage.
- **Curriculum** (owner's proposal): stage `survive` (target: ten nights survived and slept; survival weight 1, other terms
  0.1) until nights survived are stable over 3 blocks of 100 episodes, or 600,000 steps; then stage `dragon` (target: the
  Ender Dragon killed; all weights 1).
- **Population** (since run 3, `--population M`, owner's greedy + cautious idea): M members with their own parameters,
  optimiser, return scale, entropy coefficient and per-term reward multipliers; bot i acts for member i % M. Member 0
  `greedy` = the stage weights as given; member 1 `cautious` = invalid x3, survival x2, kills x0.5. Every 20 updates of each
  member (once each has 20 finished episodes) members are ranked by the return under the **unmodified** stage weights; the
  worst takes the best's parameters and settings, each multiplied by 0.8 or 1.25 (population-based training, Jaderberg et
  al. 2017).
- **Checkpoint** after every update, atomic; a restart resumes it (version 2 holds the members).

## Reward (environment side, `src/rl/reward-v2.json`)

Six terms, sent unweighted; the learner weights them by stage (and member): `survival` (a lived night 1.0, slept in a bed
2.5), `kills` (per type, decaying 0.5^(n-1); neutral mobs x0.25), `notable` (enderman 5 ... wither and dragon 100),
`mined` (dirt/stone 0.002 up to diamond 3.0, ancient debris 5.0; decaying 0.7^(n-1) per type), `achievements` (advancement
depth in the tree: crafting table 1, stone tools 2, iron 4, diamonds 6, Nether 7, End 9, dragon 11), `invalid` (-0.1 for a
command that could not be carried out, -0.05 stuck/timeout/not confirmed). Every term is graded from what the server sends
(statistics, advancements, time of day, death), never from the bot's own prediction.

## Known weak points (for the rebuild)

Observations, not measurements of alternatives:

- **Half the parameters are the GRU** (247 k of 527 k) and a quarter the item table, most of whose 1,955 rows a bot never
  sees; the part that looks at the world (columns + transformer) is about 110 k.
- **No map beyond 4 blocks**: the grid is 9 x 5 x 9 around the feet; anything further (ores 10 blocks away, the way back to a
  table) exists only as candidate features or in h. Depth is one number (y/128); finding diamonds needs knowing the depth.
- **The action set is the environment's list**: what a bot can try is what the generator lists (nearest of each kind). The
  model cannot ask for "the third-nearest iron ore" or "dig straight toward y = -58"; long plans are chains of local choices.
- **Credit over long chains**: diamonds need wood -> table -> wooden pickaxe -> stone -> stone pickaxe -> furnace -> iron ->
  iron pickaxe -> depth, dozens to hundreds of commands; the only signals on the way are the small `mined` and the
  `achievements` steps, multiplied by 0.1 in stage 1.
- **Data**: about 3 steps/s for 8 bots (run 3, first minutes); one million steps is about four days.

## MLflow

`scripts/train/mlflow.sh` indexes every training execution in `exchange/` into DPOD's local store (`mlflow_local/`,
experiment `side-botsystem`, one run per base: parameters under DPOD's official names, final metrics and at most 50 points
per curve, per member `m<i>/`; command shares and success rates; failure reasons). `scripts/train/mlflow.sh --ui` serves
the UI on 127.0.0.1:5005 only (it has no authentication; reach it with `ssh -L 5005:127.0.0.1:5005` to the VPS);
`--ui-stop` stops it (it takes about 0.8 GiB).
