# RL training v2: Crafter-style reward, skill-level actions, two-stage curriculum

Owner brief 2026-11-01 (`TASK-20261101-024` here, `TASK-20261101-030` in DPOD): the action layer works well enough
(SKILLS-v1: 560/560 flat, 0.93 on natural terrain), so train the policy at full scale, for up to one week, without the VPS
being restarted. Reward after the Crafter benchmark; DPOD's Target T = the Ender Dragon is defeated; a Truck-derived model,
inference on demand; the owner's two-stage proposal (survival first). Code only: **the training run has not been started.**

## Parts

| Part | Where | Role |
| :-- | :-- | :-- |
| Reward table | `src/rl/reward-v2.json` | every number below, one file; the learner receives it in `hello` |
| Advancement table | `modpack/forgeaip-create.advancements.json` (`scripts/rl/advancement-table.sh`) | 212 advancements of the mod set with parent and `steps` |
| Reward engine | `src/rl/crafter_reward.js` | scores progress events, keeps per-episode counts, builds the progress vector |
| Progress events | `src/rl/progress.js` | graded by the server: statistics, advancements, time of day, sleep, death |
| Action space, observation | `src/rl/skill_space.js` | up to K = 48 concrete commands per step from client-side state |
| Environment | `src/rl/run_skill_env.js` | N bots in one process, DPOD file API v1, one episode = one life |
| Model | DPOD `scripts/botsystem_skill_truck.py` | SkillTruck (Truck derivative) |
| Learner | DPOD `scripts/botsystem_skill_ppo.py` | on-demand server, asynchronous PPO, curriculum, checkpoints |
| Operation | `docker/world-server/compose.yaml` (`train*`), `scripts/train/{up,down,status,hold}.sh` | training world, restart safety, reboot hold |

## Reward (unit: 1.0 = one Crafter achievement)

Every term comes from what the server sends the player, never from the bot's own prediction: the statistics the Statistics
screen shows (`client_command 1` -> `statistics`), the advancements packet, the day clock, the death event. The environment
sends the five terms unweighted in `reward_terms`; the learner weights them by curriculum stage.

| Term | Rule | Values |
| :-- | :-- | :-- |
| `survival` | at dawn, for a night the bot lived through from its start (a night joined late does not count) | awake 1.0, **slept in a bed 2.5** (in bed when the night was skipped; `playersSleepingPercentage 1`, so one sleeping bot skips it) |
| `kills` | statistic `killed:<entity>`; n-th kill of a type in an episode = base x class x 0.5^(n-1) | passive x1.0 (no multiplier), hostile x1.0, **neutral x0.25** |
| `notable` | replaces `kills` for these types; bosses never decay | enderman 5, iron golem 5, blaze 8, wither skeleton 8, elder guardian 25, **wither 100, ender dragon 100** |
| `mined` | statistic `mined:<block>`; n-th block of a type = tier x 0.7^(n-1) | **unlisted (dirt, stone, sand, ...) 0.002**; logs 0.2, copper/clay 0.3, coal/zinc 0.4, quartz/nether gold/glowstone 0.6, iron 0.8, redstone 1.0, gold/lapis 1.2, obsidian 1.5, diamond/emerald 3.0, ancient debris 5.0 |
| `achievements` | advancement granted (once per episode; the reset revokes all) | `steps` = depth in the advancement tree, itself included; tab roots chained to the advancement that opens them (Nether root <- enter the Nether, End root <- enter the End). Craft a table 1, stone 2, iron 4, diamonds 6, Nether 7, End 9, **kill the dragon 11**, elytra 14. Recipe unlocks excluded. Create's tab is a display chain, not prerequisites: flat 1.0 each |

Why the decays: without them the cheapest return is farming one passive type or one log (place and mine again); with them
farming one type is worth at most twice its first kill (blocks: 3.3 times).

Interpretation flagged for the owner: "no multiplier for ordinary friendly mobs" was read as class weight 1.0 (the same as
hostile), and "low for neutral" as 0.25. Both are one line in `reward-v2.json`.

## Target T and the progress space

The progress vector (sent as observation `progress`, 119 numbers) is what the player can read on the advancement and
statistics screens: one flag per vanilla advancement (110), one flag per notable type killed this episode (7), nights
survived / 10 and nights slept / 10. T lives in the same space and is the learner's, not the environment's:

- stage `survive`: nights = 1, slept = 1 (ten nights, all slept), everything else 0;
- stage `dragon`: `end/kill_dragon` = 1 and the ender-dragon kill flag = 1, everything else 0.

The prerequisites of the dragon kill are deliberately **not** set in T: writing the advancement chain into the target would
give the policy the tech tree as an input (DPOD's P5 class of hand-specified knowledge).

## Action space and observation

One RL step = one command of the action layer on a target the bot can perceive. The environment lists at most 48 candidates
from client-side state only (loaded blocks, entity list, inventory, recipe book), each as command + item/block + entity +
8 features (offset, distance, count, in reach, night, held); the policy returns an index (DPOD wire form: one `select`
component `candidate`, n = 48; spec hash `3d35ee58...`, equal on both sides). The enumeration is generic, nearest of each
kind, not a plan: move_to (8 headings at 6 blocks, 4 at 16), mine (nearest exposed block of each type within 5), attack
(nearest mob of each type within 16), pickup, craft (results craftable now, 2x2 or with a table within 16), smelt (furnace-book
inputs when a furnace and other fuel are there), place (stations, beds, torches, building blocks next to the bot), activate
(beds first, doors, levers), equip (armour), eat (when not full), wait (40 ticks; how a sleeping bot passes the night).

Observation fields: block categories in a 9x5x9 box, 20 own-state numbers (health, food, saturation, level, armour, air,
ground/water/lava/sleeping, time of day, night, rain, dimension, height, heading), the 36 inventory slots (item ids and
counts), the 8 nearest entities (type ids and offsets), progress, the candidates, the last command's outcome reason, and the
ticks it took (`dt_ticks`, the semi-MDP step length).

## Model: SkillTruck (Truck derivative)

Truck (`src/model/epa_policies.py::TFGRUArm`): per step a Transformer over tile tokens and action-candidate tokens, a GRU over
the CLS embedding, logits read from the candidate tokens. Carried over unchanged: d 64, 2 layers, 4 heads, GRU width 256,
pre-norm blocks, bidirectional attention over the candidate set. Changed: 81 grid-column tokens instead of 63 tiles; tokens
for own state, last outcome, progress and target T; masked inventory and entity tokens; 48 candidate tokens built from
embeddings instead of 17 fixed ones; the memory re-ranks candidates through a bilinear term (Truck's Dense(h) over 17 actions
has no fixed action set to address here); one value head per stage. About 0.4 M parameters (most in the item embedding).

## Learner, inference on demand

A bot asks for an action only when its previous command has ended (commands last 1 tick to 60 s), so bots step at their own
pace; the server answers whatever arrived in one poll with one forward pass. PPO runs in a second thread on segments of 32
transitions (16 segments per update, 3 epochs x 4 minibatches, clip 0.2, entropy 0.01, Adam 3e-4, global-norm clip 0.5);
the bots never wait for an update. Behaviour log-probs are stored, so actions taken with parameters one update old are
corrected by the ratio (`staleness_mean` in `train_log.jsonl`). Discount per step gamma_s^(dt/20) with gamma_s = 0.999 per
second (a horizon of about one Minecraft day); rewards are divided by a running std of returns per stage (bosses are 100).

## Curriculum (owner's proposal)

Stage 1 `survive`: T = survive, weights survival 1.0, all other terms **0.1**. Stage 2 `dragon`: T = dragon, all weights 1.0.
Switch when the last three blocks of 100 episodes have mean nights survived within 10 % of their common mean and that mean is
at least 1 night; or, if that never happens, after 600,000 stage-1 steps (the reason is logged as `stage_switch`). Each stage
has its own value head and return scale; segments of the old stage are dropped at the switch.

Two decisions here deviate from a literal reading and are open to the owner:

- The 0.1 weight in stage 1 is not 0 because DPOD's TASK-20260927-009 found "do nothing" to be the best survival-only arm;
  a pure survival stage converges to hiding, which carries nothing over to stage 2. Set `stages.survive.*` to 0 for the
  literal version.
- DPOD's earlier "two-stage" attempt (TASK-20260927-009/010) was a world-model + heuristic setup, not an RL curriculum, so its
  failure is no evidence either way for this one.

## Operation

```bash
scripts/train/up.sh --bots 3 --learn 0 --base smoke     # owner-watched test run: the policy acts, never learns
scripts/train/up.sh --bots 4 --learn 1 --base train     # the training run (one week)
scripts/train/status.sh [base]                          # containers, holds, per-bot command success, rewards, learner
scripts/train/down.sh                                   # learner first (last checkpoint), then the build world comes back
```

- The training world (`forgeaip-train`, volume `forgeaip-world_train-data`, seed 20261101, survival, normal, structures on)
  takes the build world's place on 127.0.0.1:25567, so the owner watches it over the same tailnet route
  (100.115.238.9:25565, op: `/gamemode spectator`, `/spectate Train0`) and no new listener exists. `up.sh` snapshots and
  stops the build world and the LLM bot first (memory: the box cannot hold both 4 GiB servers); `down.sh` restores them.
- Episodes start at a random site of the pre-generated region (|x|, |z| <= 512, `bench_lv2.js --pregen 1`, L10).
- No reboot: a schedule entry on resource `vps` until 2026-11-08 04:00 (rootwatch defers its daily reboot for any
  schedule entry on the VPS) and, while the learner runs, `forgeaip-train-hold.timer` renewing `maint-hold forgeaip-train
  480` every 30 minutes. Daily apt/security updates wait for the same period.
- Restart safety: all three containers `restart: unless-stopped`; an environment restart is a new run id that the learner
  follows through `exchange/<base>.current`; the learner checkpoints after every update and resumes on start.
- Throughput estimate (not measured at scale): commands average a few seconds, so 4 bots give roughly 1-2 steps/s,
  0.1-0.2 M steps per day, about 1 M in the week. That is Crafter's usual budget; whether it reaches the dragon is the
  experiment, and the honest prior is that it does not.

## Not done

- The training run itself (owner's go-ahead).
- Reaching the End needs candidates the generator does not list yet: placing obsidian into a portal frame at chosen cells,
  lighting it (`activate` with `flint_and_steel` exists in the action layer but is not benchmarked), throwing eyes of ender,
  filling the end portal frame. Walking through a portal is `move_to`. As listed today, the dragon is out of reach; stage 2
  still raises the score through every other term. Extending the candidate list is the next step if the owner wants the
  dragon to be reachable in principle.
- Live measurement of the statistics decoding on Forge (registry sync of `stat_type`/`entity_type`), dawn/sleep detection and
  advancement grading: checked in the smoke run, see STATE.yaml.
