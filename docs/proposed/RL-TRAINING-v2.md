# RL training v2: Crafter-style reward, skill-level actions, two-stage curriculum

Owner brief 2026-11-01 (`TASK-20261101-024` here, `TASK-20261101-030` in DPOD): the action layer works well enough
(SKILLS-v1: 560/560 flat, 0.93 on natural terrain), so train the policy at full scale, for up to one week, without the VPS
being restarted. Run 3 changes (8 bots, K = 64, population, speed): see "Run 3" below; tables here describe v1.2 unless noted. Reward after the Crafter benchmark; DPOD's Target T = the Ender Dragon is defeated; a Truck-derived model,
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
| Watching | `src/rl/live_board.js` -> `exchange/<base>.live.json`; `tools/train-dash` (Rust, std only) | per-bot page for the human watcher |

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

| `invalid` | a command that could not be executed, by its reason (owner 2026-11-01, after run 1) | **-0.1** precondition failures (unreachable, missing tool/item/materials, no station, invalid target/args, not visible); -0.05 stuck, timeout, not confirmed; -0.02 target lost; 0 for died, disconnected, cancelled, internal. Weight 1.0 in both stages |

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
scripts/train/restart.sh train-policy [train-dash]      # recreate with the running settings (exchange/.train-env) after a code change
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

## Watching (owner 2026-11-01)

The environment keeps a live board (`src/rl/live_board.js`) and rewrites `exchange/<base>.live.json` every second;
`tools/train-dash` (Rust, standard library only, read-only, five fixed GET paths, strict CSP) serves it with a page on
127.0.0.1:3021, routed to the tailnet by `tailscale serve --tcp 3021` like the game: **http://100.115.238.9:3021/**. Per
bot (BOT #n = Train n): the command running now and for how long, the last 20 commands with result, success rate overall and
over the last 200, per command the chosen share against the share a uniform pick among the offered candidates would give
(bias), failure reasons, distance moved over the window, the episode's return and nights. Warnings: failing >= 70 % of the
last 50+, one command >= 70 % of choices at >= 2x uniform, moved < 3 blocks over 100+ commands. Learner: entropy and reward
curves, last episodes with their `invalid` sum.

## Run 1 (2026-11-01 10:20-15:29 JST, base `train`): what happened

108,530 steps, 214 updates, 79 episodes; stopped by the owner. Findings, from `exchange/train-20261101T012004/events.jsonl`:

- Failures already rose from 12-53 % (first 10 min, untrained) to 70-81 % in the next half hour, i.e. within the first
  ~10 updates; afterwards 90-100 % on the bots that stayed connected.
- The long episodes were bots **trapped** in a pocket (6-8 candidates, nearly all failing in ~5 ms: `move_to:unreachable`,
  `mine:unreachable`, `mine:missing_tool`); Train0 episode 11 (8 nights, 18 k steps) and Train3 episode 22 (4 nights, 16.5 k)
  collected most of the survival reward of the run while trapped. Failing cost nothing (no time, no reward), and being
  stuck is safe, so the survival stage paid for it: DPOD's "do nothing is the best survival arm" again, found by the policy.
- So the model was not blind to the physical constraint; it used it. Not separable from run 1: whether it would have
  learned to avoid failing commands had they cost something. Run 2 tests that (term `invalid`, one tick minimum per step),
  and the page shows whether the remaining refuge is `wait`.
- Train1 and Train2 timed out at 12:02 (server: "Timed out") and were not replaced; fixed (a lost bot restarts the run).

## Run 2 (from 2026-11-01 15:54 JST, base `train2`): the traps, found on the page in the first minutes

- Pit: Train1 mined the two blocks under its feet (steps 24-25) and stood in a 1x1 hole two deep. `mine` offered only the
  nearest block of each type, which was the one underfoot (unreachable); the head-height wall block that makes a step out was
  never a candidate, and there is no pillar-up command. Fixed in the candidate list: never the block under the feet, and per
  type also the nearest block at head height or above (test: a bot in a pit is offered the step out).
- Water: Train2 chased a mob 80 blocks (`attack`, 702 ticks) into a stone hollow beside water; the action layer cannot swim
  (SKILLS-v1 limits), so every command failed. Not fixable in the candidate list; the **stuck cut** ends such episodes:
  200 commands under 10 % success within 2 blocks -> truncated (not a death), the bot is reset elsewhere
  (`episode_end.stuck`). Without it a trapped bot keeps collecting survival nights, as in run 1.
- Both traps are action-layer gaps (no climbing out, no swimming), visible in the grid observation; neither is a case of the
  model being unable to see the physical constraint.

## Run 3 (from 2026-11-01 17:54 JST, base `train3`): owner brief after watching run 2

The brief and what changed (TASK-20261101-025 here, TASK-20261101-030 in DPOD):

1. *Bot 0 keeps repeating impossible commands.* All bots share one policy; run 2's per-bot differences were terrain, and
   the commands were impossible because the list offered them: run 2 ended with 2,811 `mine:missing_tool` and 1,100
   `move_to:unreachable` among its failures (bot 2 chose `mine` 2,557 times at 4 % success). Since env v1.3 the list holds
   only what the action layer can carry out from where the bot stands (`skill_space.js`: a reachability flood over the
   planner's own moves, blocks a held tool harvests, stations in reach).
2. *Attacking a pig until it died: was that given in advance?* Yes. `attack` is one command of the action layer
   (`src/skills/commands/entity.js`): chase, swing when the weapon has recharged, until the server reports the death. One
   policy choice covers the whole fight; nothing about it was learned (run 2's longest attack streak was 5 commands).
3. *Repeating walk / dig / punch trees / place wood; diamonds with this architecture and size.* At update 11 of run 2 the
   entropy was 2.83, close to uniform over the candidates, and the list held up to 12 `move_to` and 11 `mine` against one
   `wait`: a near-uniform policy walks and digs ~70 % of the time by construction. Changes: a kind prior in the model
   (uniform over command kinds when untrained), `tunnel` (stair steps down and up, corridors: the way to diamond depth, and
   out of pits), and the owner's population idea as population-based training (greedy + cautious members, fitness on the
   unmodified stage return). The model's limits for diamonds are listed in [MODEL-SKILLTRUCK.md](../implemented/MODEL-SKILLTRUCK.md).
4. *Double the bots, spread apart.* 8 bots, each reset in its own sector of the region (a 3 x 3 grid; ocean sectors fall
   back on the whole region), bot view distance 5; the environment's CPU per step fell (L14: 60 % of it was building `Block`
   objects). Server: simulation distance 5, view distance 6.
5. *Ladders and swimming, carefully.* In the action layer, tested on the bot's own physics before going live, then 85/85 on
   the live server (SKILLS-v1.md, v1.1).
6. *Speed everything up by one factor.* `tools/tickrate` + GAME_SPEED (85/85 live at 2x and 3x on the test server). On the
   training world the factor is bounded by one server tick thread shared by all bots: 8 bots use 29-33 ms of the 50 ms tick
   at 1x, and measured live 1.5x fell to 20 of 30 ticks/s while 1.25x held 23.8 of 25 (95 % command success, 3.6 steps/s): run 3 runs at 1.25x (bots x speed is the budget, not either alone).
7. *Model summary in MLflow form.* [MODEL-SKILLTRUCK.md](../implemented/MODEL-SKILLTRUCK.md); every training execution is
   indexed into DPOD's MLflow store (experiment `side-botsystem`, `scripts/train/mlflow.sh`).

Found in the first minutes of run 3 and fixed: an ocean sector ended the run (no dry site in 30 tries); a bot reset onto a
tree top, cleared it and stood on a one-block trunk, waiting (L15).

## Run 3 shards (2026-11-01 19:31 JST)

Owner: about 16k steps in the first hour; speeding up backfires through lag, so parallelise (32 bots, 1.5 M steps per hour).
`scripts/train/up.sh --shards S` runs S servers, each with its own environment process (bot ids global, a copy of shard 0's
world, no host port), all feeding one learner (DPOD follows `<base>.current` and `<base>.s<i>.current`). Run 3 continues on its
checkpoint as 2 x 10 bots at 1x: **5.61 steps/s = 20.2 k/h** (8 bots at 1.25x: 3.63 = 13.1 k/h), 94 % command success,
mean command 62 ticks. The VPS is the limit: load ~12 on 6 vCPU, both servers 38-72 ms per tick, the learner 170 % CPU
while updating, swap +1.3 GB.

Arithmetic of the target: 1.5 M/h = 417 steps/s; a bot completes 0.4-0.5 steps/s (51-62 game ticks per command), so about
900 bots, i.e. ~90 server threads at ~10 bots each. Real Minecraft does not get there on any machine held; 32 bots (4 shards x
8) fit the owner's PC (8 cores, 48 GB) rather than this box.

## Not done

- The training run itself (owner's go-ahead).
- Reaching the End needs candidates the generator does not list yet: placing obsidian into a portal frame at chosen cells,
  lighting it (`activate` with `flint_and_steel` exists in the action layer but is not benchmarked), throwing eyes of ender,
  filling the end portal frame. Walking through a portal is `move_to`. As listed today, the dragon is out of reach; stage 2
  still raises the score through every other term. Extending the candidate list is the next step if the owner wants the
  dragon to be reachable in principle.
- Live measurement of the statistics decoding on Forge (registry sync of `stat_type`/`entity_type`), dawn/sleep detection and
  advancement grading: checked in the smoke run, see STATE.yaml.

## Owner review 2026-11-02 (watching run 4): "OK rewards mistakes", dirt farming

Knowledge: `forge1201aiplayersystem_rl_whatwrong_ilook.md`. Checked against the logs before changing anything:

- **Is OK rewarded?** No term pays success. Reward-v2 pays server statistics (mined, killed), advancements, nights and death,
  and charges failures (`invalid` -0.1 / -0.05), so OK means "not charged". Every command's OK is a server-confirmed effect:
  move_to position reached, place block present, craft/pickup/smelt count up, eat item consumed and food up, attack target
  dead, tunnel every cell's break confirmed and the bot in the new cell. Two loose ends, both earning nothing: `mine` is OK on
  the confirmed break even when the drop is lost (`drop_missed`, L15), and `wait` is always OK.
- **Tunnel "digs 3 and stops":** one tunnel command is one stair step by specification (head, body and floor-1 cells, then step
  in). The holes are the untrained policy: uniform over command kinds, it chose tunnel 13 % of run 4's first 17 k steps, each
  a single step in a random direction. That is exploration cost, not a judging error.
- **Dirt farming learned?** Not in the environment reward: unlisted blocks pay 0.002 x 0.7^(n-1) per type and episode, so
  4 x 1000 trivial blocks are worth less than one log (now a regression test). Run 3 (109 k trained steps) *reduced* dirt:
  mining dirt 17.1 % -> 8.5 % of steps, placing dirt 9.8 % -> 5.1 % (first vs last quarter, shard 0; shard 1 alike). The
  dirt you see is the starting distribution (the nearest blocks offered to `mine` are mostly grass and dirt).
- **Where the owner was right:** GoalWM's flat goal bonus (1.0 per reached goal, DPOD a74caba) paid "+1 dirt" five times a log
  and could be collected by place-then-mine or a tunnel. Fixed in DPOD: bonus = 0.5 x (1 - p) x 0.5^n, p = max(reach head at
  assignment, past success rate), n = repeats of the dimension this episode; 1000 trivial goals < one log (test). The
  `invalid` charge still makes always-OK commands relatively safe; kept (owner decision after run 1), watched.
- **Not done:** "pay for dirt only if a batch-generated plan uses it" needs plan generation, which the candidate-list
  environment cannot support yet (MODEL-GOALWM.md); as the owner noted, it could also misjudge.
- Also fixed on the way: an RCON or statistics timeout on a lagging server ended the whole run (train4 shard 0: 8 restarts in
  an hour, every bot reset); timeouts are now retried (ids matched, late replies dropped), RCON timeout 10 s.

## Run 6 (from 2026-11-02 14:38 JST, base `train6`): owner review of run 5

Owner (after 5 h / ~240 k steps of run 5): the bots still dig dirt, chop wood and place it; the crafting table is rare and a
tool was used once, so learning is worse than the numbers; the world is bumpy and the start area nearly empty; use ten given
sites, 20 bots in two groups of ten with the same seed and starts (pairs for self-imitation); show which goal each generated
plan was made for, and how.

**Why the numbers looked better than the behaviour** (run 5, 2,133 episodes, 266 k steps, `exchange/train5*`):

- 96 % of episodes ended in death (2,045), after 111 commands on average. Per episode the reward was achievements 3.11,
  kills 1.61, mined 0.42, survival 0.24.
- The achievements were nearly all tab roots: `minecraft:adventure/root` (1,877 grants), `create:root` (1,767),
  `story/root` (729, crafting table), `husbandry/root` (472, eat anything). Real progress was rare: `mine_stone` 114,
  `smelt_iron` 7, `upgrade_tools` 3.
- `adventure/root` is granted by *being killed* (criterion `killed_by_something`), so **every death paid +1.0** although
  `survival.death` is 0. `create:root` is awarded for free on joining, so every episode paid +1.0 for nothing. Together that
  is two thirds of the achievement term. Fixed in reward table v4: no achievement is paid in the step of a death (a kill
  still pays `adventure/root`; test with that control), and `create:root` is unscored.
- The goal proposer kept choosing "+1 dirt" (833 of 4,468 assigned goals). The p(1-p) weight favours a goal with p 0.83
  (w 0.14) over the hard ones (p near 0, w near 0.03). Plans are learned from hindsight orders of what bots happened to do:
  a "diamond" plan read `sand -> kill tropical_fish -> diamond`. Only 46 of 2,173 plans were completed (2 %); most ended
  with the bot's death. The policy did not learn the tech tree; it learned the cheap, always-OK loop plus free roots.

**Sites, pairs, a fresh world** (`config/train-sites.json`, env v2.1):

- Bot k of every shard starts every episode at site k (owner's ten coordinates; the decimals were dropped, which was one
  block off at five sites; the file now holds the measured standing cells). Bot k of shard 0 and bot k of shard 1 are a
  pair: seed 20261101, the same start, different worlds. When a site has been dug or built on, the reset takes the nearest
  dry standable cell in a fixed search order, so paired bots stay alike as long as their worlds are alike there.
  Measured: all ten pairs landed on identical cells in the first episode (`site_moved` events).
- `up.sh --fresh-world` archives the old shard-0 world (`/mnt/data/forgeaip/snapshots/train-world-20261102-143452.tar.gz`),
  removes every shard's world and generates the seed anew. Shards 1+ are copied from shard 0 *before any bot joins*.
  Earlier up.sh copied the world after shard 0's bots had started, so shard worlds were never identical.
- `--sites` pre-generates the ten sites (107 s) and records the ground under each in `exchange/pregen-20261101-sites.json`.
- `hello.start` = {site, pos, shard}. It is bookkeeping, never observed by the policy. The learner writes it to every
  episode record as `pair`, and the page shows each bot's partner and a pairs table.
- Not done: the self-imitation loss itself (which partner's actions to copy, and from when the two worlds diverge, since
  mobs and drops differ from the first tick). The pairs make it possible; the rule is the owner's to choose.

**Provenance on the page** (DPOD `goals.json`, `tools/train-dash` `/goals.json` and the `goals` stream event): each bot
card shows its plan: the target T and why it was chosen (owner task goal, or an archive dimension with its success rate),
what triggered the generation (episode start / the previous plan completed / a step expired / a step judged infeasible with
its R), the beam's log-probability and the other beams, R(s, step) of every step at generation, and the progress. It also
shows the goal now (source, p, the bonus it would pay, age of horizon) and the last five plans and eight goals with their
outcomes.

**Plans were never judged infeasible** (DPOD fix, 2026-11-02, found on the new board): the test "R(s, step) < --plan-tau =
physically too early" used max(R, the dimension's Laplace success rate), and an untried dimension's rate is
(0 + 1)/(0 + 2) = 0.5, so the test could never fire (run 5: 0 infeasible replans in 2,173 plans). It now tests the reach head
R alone (regression test with a negative control on the old code). The goal's price and proposal weight keep max(R, rate)
(owner rule). The board shows R per step.

**Learner restart replayed the whole run** (DPOD fix, 2026-11-02): a restarted learner read the run's message file from
the start and served every old observation. That answered steps the bots had already carried out with other actions, and
it would have trained on transitions it never chose (the first restart of run 6 replayed 18 k observations; stopped before
any update, checkpoint still at update 46). Earlier restarts mid-run (the run 5 crash fix) went this way. Now the first read
of a run keeps the hellos and, per bot, only the last observation, if no act answered it yet (test: 61 replayed steps on the
old code, 1 now). `scripts/train/restart.sh <service>` recreates a container with the running training's settings
(`exchange/.train-env`, written by up.sh). A bare `compose up` had recreated the learner and the page with base `train`,
which followed the dead run 1 and wrote 4 hello refusals into its files (removed).

**Server load:** with sites pre-generated to +-48 only, both servers ran at 104-140 ms per tick (budget 50), because bots
view +-80 blocks and generated terrain at the edge. Sites are now pre-generated as a 3 x 3 grid of views (+-176 blocks; 405-443 s
per shard on the live servers, `--max-tick 160`: a server with bots never gets under the default 40 ms). About 2,000 entities
per shard (about 600 hostiles over the ten separate areas, about 300-400 dropped items). Throughput over 15 min: 16.7 k
steps/h, against 19.3 k/h at the end of run 5.

**Learner:** GoalWM, initialised from run 5's encoder, world model, reach head, goal embeddings and plan decoder
(`exchange/pretrain/train5_u594.pkl`). The policy head starts fresh, since it was trained under the leaky reward.

## Run 7 (from 2026-11-02 18:03 JST, base `train7`): owner instructions 1-5 of 2026-11-02, rebuilt from scratch

Owner (after run 6): more bots did not mean more learning; one life per episode yields little; paired bots did different things;
use the PC from bot 11 on; never start in dug terrain. Implemented as instructed (env v3.0, DPOD `--goal-mode list`, S12):

1. **Groups.** VPS: 5 groups of 2 bots, each group its own server and world (same seed 20261101), its own clock and environment
   process (`scripts/train/up.sh --shards 5 --bots 2`). Game speed 2 (was 1). Heaps 1 GB per server: at 1.25 GB the box hit a
   global OOM that killed the learner (2.27 GB anon) at 18:10 and 18:15 JST; at 1 GB a server is 1.2-1.3 GB resident.
2. **Episodes of days.** An episode is `--days 3` in-game days for the whole group (clock set to morning at the start; it ends
   at the first observation past 3 x 24000 ticks, `terminated`, with the share of the episode gone in `clock[0]`, so the end is
   observed). Death: -2.0 (`death` term), play goes on from the respawn at the episode's site with an empty inventory; a trapped
   bot (stuck detector) is killed, so hiding pays nothing. Survival: +1.0 per dawn reached without a death since the last one
   (+1.5 slept). Progress: the progress list `src/rl/progress-list.json` (24 entries, easiest first: wood, planks, table, ...,
   iron pickaxe, bed, sleep, diamond, diamond pickaxe), judged by the environment from server statistics deltas (mined, crafted,
   used, picked_up, killed; `slept` from the dawn event), +1.0 per entry once per episode. In-game advancements are no longer
   read or revoked. Kills and mined blocks are not paid any more (reward v5). Goals: the learner gives the easiest entry not yet
   reached (DPOD `--goal-mode list`).
3. **Pairs do the same thing.** The two bots of a group are a pair (`start.pair`); both always pursue the same list entry; when
   either reaches it both move on; an entry that expires (150 commands) is skipped by the pair until it reaches something new.
   Self-imitation (Oh et al. 2018) on every goal-reaching trajectory: `-log pi(a|s,g) max(R - V, 0)` (+0.01 x value term), weight
   0.5; the pair shares one policy, so either partner's success trains both.
4. **PC.** `scripts/train/pc.sh up --groups 5`: 5 more groups (shards 5-9, bots 11-20) on the owner's PC (Forge 1.20.1 + mods,
   portable Node 20, servers on 127.0.0.1 only, `scripts/train/pc/supervisor.js` restarts what stops, a hidden logon start in the
   owner's startup folder). The learner runs there too (venv with the VPS's pinned jax 0.12.0.1): the VPS learner needed 396 s for
   its first update with 5 servers on the box (run 6: 42 s). `scripts/train/relay.py` (systemd user unit
   `forgeaip-train-pc-relay`) mirrors between the two `exchange/` directories what the other side reads.
5. **New site per episode.** `tools/site-finder` (Rust + vendored cubiomes, Minecraft 1.20 generation from the seed alone):
   20,000 candidates on a 640-block grid (any two 512+ apart), each in a tree biome with 7 of 8 points at 24 blocks also tree
   biomes, at most 30 % water/beach within 256 blocks (no island), approximate surface 63-110. Checked against the live server:
   12 of 12 predicted sites were the predicted biome type (forest/taiga/jungle/windswept, `locate biome`, distance 0). On
   arrival the environment counts logs within 16 blocks (>= 12), finds a dry cell on the forest floor and keeps 500+ blocks from
   the partner's site; rejected candidates are recorded too. Used sites per world: `exchange/sites/<vps|pc>-s<i>.json` (never
   reused, survives restarts). When a world's list is used up the environment exits 7 and the PC supervisor regenerates that
   world (on the VPS: `--fresh-world`); at about 2 sites per group per episode the list lasts months.

First hour: all 20 bots stepping on both machines; sites 82-151 logs; tree counts of the same site differ between worlds of one
seed (55-87 logs at 640,-640: feature placement depends on chunk generation order). Open: the VPS servers still log "can't keep
up" when a group generates terrain for new sites (24-99 s stalls during the first episodes, while a DPOD test suite also ran);
measured at 19:27 JST (no test suite running): the VPS servers reach 23-39 of 40 ticks/s at speed 2 (effective 1.2-1.9x).
Throughput 36,129 steps in the first ~45 min (~48k/h; run 6 ~20k/h); the PC learner keeps the queue near 15 segments.

## Run 7 stopped, run 8 prepared (2026-11-02 23:30 JST, owner instructions 1-5)

**Run 7 result** (stopped by the owner after 4.55 h: 220,776 steps, 435 updates, 164 episodes, 48.6k steps/h): progress per episode
7.56 / 7.65 / 8.33 of 24 entries (first / middle / last third; stalls at `collect_stone` and the stone pickaxe, best episode 14, no bot
ever slept), deaths per episode 18.4 / 17.0 / 10.4 (death term -36.7 / -33.9 / -20.8, so the return counted deaths), 18 % of assigned
goals reached, policy entropy 2.27-2.46 (uniform over ~23 candidates is 3.1), `wait` 25-38 % of commands (bias +5 over uniform),
clipfrac 0.26-0.40. The learner took 22 s per 458 steps (~20 steps/s) and was already close to the limit of the generation rate
(13.5 steps/s). The VPS ran at load 19 on 6 vCPU with 3.9 GB swap (released afterwards: `swapoff -a && swapon -a` through the broker).

**Changes for run 8** (the order of the owner's list):

1. **Reward v6**: death -2.0 -> -0.25 (`src/rl/reward-v6.json`; the lost inventory is the real penalty). Env `skills-v3.1`.
2. **Learner on the PC's GPU.** jax has no native-Windows CUDA wheels; the supported route is WSL2 with the Windows NVIDIA driver.
   The PC has no WSL yet (checked 2026-11-02: `wsl -l` reports it is not installed; Windows 11 Pro build 26300, virtualisation
   enabled in firmware, RTX 3060 Ti 8 GB, ~1.9 GB used by the desktop). **Owner, once, in PowerShell started as Administrator:**
   `wsl.exe --install -d Ubuntu-22.04`, reboot, finish the Ubuntu first-run setup. Then `scripts/train/pc.sh gpu-setup` (untested)
   builds a Python 3.12 venv with `jax[cuda12]==0.12.0.1` there, checks that jax sees the GPU and writes `C:\forgeaip\gpu.json`; the
   supervisor starts the learner inside WSL from then on (`XLA_PYTHON_CLIENT_PREALLOCATE=false`, 50 % memory fraction) and falls
   back to the CPU venv while the file is absent. The unofficial `winjax` package claims native Windows CUDA; not used (unverified
   binary plugin, Python 3.13 only).
3. **Rust simulator**: design only, `docs/proposed/SIM-RUST-v1.md`.
4. **Quiet hours.** `scripts/train/window.sh check` (user timer `forgeaip-train-window.timer`, every 5 min, started by `up.sh`)
   pauses both machines between 12:00 and 18:00 JST and resumes afterwards; the PC supervisor also pauses by itself in that window
   and while `C:\forgeaip\PAUSE` exists (`pc.sh pause|resume`), stops everything gracefully (servers `stop`, learner checkpoint after
   every update) and runs its children at below-normal priority. A reboot or crash is covered by the same restart rules as before.
5. **Teacher, then self-imitation.** DPOD `scripts/botsystem_teacher.py` (wood and stone tier only, reads only the policy's inputs)
   executes with probability 0.3 x level and labels every step it has an opinion on (behaviour cloning, weight 0.5 x level, also on
   the policy's own states). The level fades by 0.97 per update once the policy, acting alone, picks the teacher's candidate at
   >= 55 % (EMA) and never rises again; 0 below 0.02. Self-imitation is unchanged. "Merging/pruning of pairs" is read as: pairs in the
   bottom quarter by progress per episode feed no self-imitation data (the shared buffer is the merge point); to be confirmed by
   the owner. This is hand-specified game knowledge and counts toward no DPOD gate; run 8 results are labelled "with teacher".

Not started: run 8 waits for the WSL install (a CPU-learner start is possible but would repeat run 7's learner limit).
