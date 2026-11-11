# REAL-WORLD-VERIFICATION-v1: the only accepted way to measure movement, escape and mining (2026-11-11)

`TASK:20261111-061`. A rate for the movement policy, the stuck escape or the pit counts only when it was measured on a disposable copy of the owner's play world with random starts and targets and graded from the server. Everything else is a smoke test.

## Why this exists

MOVE-v3 and PIT-EXPERT-v1 reported "28/28 live worlds" and "621 s against 861 s". The owner then issued a pit command on the play world (End, `j37`/`j38`) and the bots finished no unit: 0 done, 20 failed per minute, 4 forced kills a minute. The numbers were measured on the simulator's own generators rebuilt with `/fill` (MOVE-v3, "All 28 live worlds are the simulator's own generators") and on a stone block in the sky (pit arena): worlds with a floor under everything, no void, no real terrain, built from the same assumptions as the thing being tested. A policy trained on a world and graded on that world's rebuild measures the world, not the policy.

## The standard

1. **World.** A copy of the running play world: its `level.dat` seed, its generated chunks, its mods (`/mnt/data/forgeaip-play/real`, container `forgeaip-real`, `127.0.0.1:25572`, peaceful like the play world, same pinned image, same `mods/`). Terrain outside the explored area is generated from the same seed. Fresh random-seed worlds with the same mods are an allowed extra, never a replacement.
2. **Trials.** Random start and target columns drawn by a seeded generator (the harness's, not the world's), natural terrain only (water, lava, ice, leaves and logs rejected as a floor; caves for the escape family), distances 20 / 40 / 80 / 150 blocks. One client at a time (parallel clients overload the server and corrupt runs).
3. **Equipment.** What the production bots carry: a pickaxe, 64 cobblestone, food. Setting `teleport` off, `move3`, `experts`, `router`, `pitExpert` on: the production settings, the production `env.travel` / `env.expertEscape` / `env.recover` / `WorkService` pit job.
4. **Grade.** From the SERVER: `data get entity <bot> Pos` (arrival within 3.5 blocks across and 3.5 levels, alive), or the blocks left in the pit volume. The bot's own "ok" is recorded next to it (`said_ok_but_not_there`), never used as the grade.
5. **Negative control.** `CONTROL=noop` (the bot stands still): must score 0. A grader that passes a bot that does nothing is broken.
6. **Report.** Rate with the Wilson 95 % interval; the lower bound is what is claimed. State the world with every number.
7. **Targets** (owner 2026-11-11): movement >= 80 %, escape from a stuck position >= 90 %, pit/strip-mining failures of the stuck kind (`unreachable`, `stuck`, `died`, `not_confirmed` as a share of unit attempts) <= 10 %.

A mismatch between a harness rate and the live counters (`health.jsonl`, `forced.jsonl`, `problems.jsonl` of the console) is a harness bug until shown otherwise. Example from the first day: the first version of `real_move.js` walked down through an ocean into a cave and graded trials that started 30 blocks under the surface; the 3/8 it gave was half harness, half real, and only the rewritten probe (`lib.js standCell`) is used.

## The harness (`scripts/real/`)

| File | What |
| :-- | :-- |
| `/mnt/data/forgeaip-play/real/{up,down,rcon,refresh,reset}.sh`, `compose.yaml` | the test server (outside the repo, like the play folder). `refresh.sh` re-copies the play world (save-off, flush, copy, save-on); `reset.sh --make-pristine` / `reset.sh` return it to a stored state for A/B runs |
| `scripts/real/run.sh <script> NAME=value ...` | runs a script in the node image on the test server's network, repo mounted read-only (`REPO=` another checkout for an A/B against an older commit) |
| `lib.js` | RCON, a production-settings `WorkService`, `standCell` (the top block of a column through the bot's own view), `wilson` |
| `real_move.js` | movement: `DIM=overworld` random columns; `DIM=end START_BOX=100,0,100,0 TARGET_BOX=64,0,95,31` the entry platform to real standable cells of the pit's volume; `CONTROL=noop` |
| `real_escape.js` | `FAMILY=cave`: natural cave/ravine cells 10+ blocks under the surface, escape to the surface; `FAMILY=recorded`: the cells where live bots were recorded stuck (`problems.jsonl`), escape to the entry platform |
| `real_pit.js` | the owner's End pit job through the same `WorkService` the console uses, `BOTS` bots for `MIN` minutes, verdict from the console's own health rows and from the blocks left in the box |

## Results (world of every row: the copy of the play world, seed -4765240900510629830, 2026-11-11)

**Pit (End box of j37/j38, expert method, 4 bots arriving 12 s apart, 10 minutes, same world state each run):**

| code | station walks that could not stand | units ok / attempted | stuck-type unit failures | deaths | forced pushes | cells dug |
| :-- | --: | --: | --: | --: | --: | --: |
| unfixed `499c84b1` | **88 %** (499/567) | 3 / 172 | **95 %** (164/172, Wilson [91, 98]) | 26 | 17 kills + 6 falls | 330 |
| fixed (this task) | **7 %** (10/136, [4, 13]) | 25 / 26 | **4 %** (1/26, [1, 19]) | 0 | 0 | 540 |
| fixed, 6 bots, 15 min | 9 % (15/160, [6, 15]) | 35 / 38 | 5 % (2/38, [1, 17]) | 5 | 1 kill | 1,308 |

Pooled over the two fixed runs: station walks 25/296 = 8.4 % [5.8, 12.1]; units 3/64 = 4.7 % [1.6, 12.9]. The target (<= 10 %) is met by the point estimates; the upper bound of the station rate is just above it. The five deaths of the 6-bot run are the platform's crowding (see open issues).

**Movement (random start, random target, grade = the server's position within 3.5 blocks, alive):**

| family | result |
| :-- | :-- |
| overworld, natural terrain, 20 / 40 / 80 / 150 blocks, two runs of 20 and 24 (seeds 21, 77) | **41/44 = 93 % (Wilson [82, 98])**; within 20 blocks at the end 44/44; "said ok but not there" 0; the three failures: a 50-level cliff, a target 3.5 blocks off, one "no leg of any length" |
| End, entry platform to real standable cells of the pit volume, world cleaned of bridges before every trial | with the learned walk alone: 13/16 = 81 % (Wilson [57, 93]); **with `voidnav`: 21/24 = 88 % (Wilson [69, 96])**, within 20 blocks 24/24, arrival on the exact cell; the failures are targets 7-32 levels BELOW the platform (no bridge or pillar goes down) and two plans that ended 0.1-0.3 blocks short |
| negative control (`CONTROL=noop`) | 0/3 |

**Escape (no server moves, production code `env.expertEscape` / `env.travel`):**

| family | result |
| :-- | :-- |
| cave: natural cave / ravine cell 8-30 blocks under the surface of a random column, escape to the surface within 90 s | 17/20 = 85 % (Wilson [64, 95]); by depth 8-14: 8/8, 15-24: 6/7, 25-39: 3/5; the failures timed out while still climbing |
| cave, 10-70 blocks deep (first, unrealistic band) | 2/9 in the nine trials seen (42-70 blocks down is not a bot in a hole: it was stopped and the band narrowed) |
| recorded: the cells where live bots were recorded stuck (3,001 distinct cells in `problems.jsonl`, End pit neighbourhood), escape to the entry platform | 18/20 = 90 % (Wilson [70, 97]); first arrival median 8 s, 18 of 20 within 63 s; the two failures were cells 50+ blocks from the platform |
| negative control | 0/3 |

**Against the owner's targets:** movement >= 80 %: met (overworld 93 %, lower bound 82 %; End pit 88 %, lower bound 69 %); escape >= 90 %: recorded cells 90 % (lower bound 70 %), shallow caves 85 % (point estimate below the target); stuck failures while mining <= 10 %: met by the point estimates (4-9 %), the upper bound of the pooled station rate is 12 %. The lower bounds of the End and escape rows are below their targets at n = 20-24: more trials with `scripts/real/run.sh` are the way to tighten them. The 10-70 block cave band and the first, contaminated End run are in the history of this file only as the reasons the harness changed.

## Causes found and fixed (in the order they were found, each with its evidence)

All on the pit job of console job j37/j38 (End, box 64,0,95,31, top 70, bottom 1, expert method) run on the copy. The box holds 71,680 cells; 2,886 are end stone, almost all of it a body at y 18-33, 16-30 levels under the entry platform (y 49), plus a few ledges; the rest is void.

| # | Cause | Evidence | Fix (commit) |
| :-- | :-- | :-- | :-- |
| 1 | The pit expert's model (and the simulator it was trained on) treats an empty column as ground at the band's level. True in a ground pit, false over a void | 52 of 60 distinct failed live station targets were cells of air over air; unit test reproduces "could not stand at the station" | stations need a real block under the feet; hop to the best floored station when the model's walk reaches none; only the blocks a station stood on are accepted as left (48052deb) |
| 2 | `goToStation` bridged only on the bot's own level, only from more than 3 blocks away | bots stopped 1-3 blocks short of the station on their own bridge | over a void the learned walk takes the exact cell, the ladder is the fallback (26c9755b) |
| 3 | Fragments no floor reaches ended the unit at once ("N cells left, no station can reach them", 8 retries in 50 s) | unit rows with 0 stations and 30-50 ms | footing stations: an air cell within 8 blocks of a standable cell, bridged to; the bot's own bridge blocks (and every bot's, from the shared list) are not ore (367cf527, voidnav commit) |
| 4 | `pickup` steered straight at an item over a drop and walked off the rim | 4 deaths in one run, all right after `dig` / `collect_drop` | an item with nothing solid within 3 cells under it is not chased (entity.js) |
| 5 | The console's "push a bot that does nothing" forced a FALL on bots that were digging (their feet do not move for minutes, a pit unit takes minutes), over the void: certain death | 4 of 5 deaths in a run coincide in time and place with a forced fall of the same bot (`forced.jsonl`: still 30 s, errFor 0, act unit) | a bot that keeps starting action-layer phases is not still; nothing is pushed into an abyss (9c8bd776) |
| 6 | The learned walk's `dig_down` is valid for any fall the bot survives (the simulator's pits always have rock under them); over islands it dug the ledge under its feet and fell 12-20 levels, then spent its 60 decisions climbing back | a traced walk (`trace_walk.js`): `dig_down`, 8 `wait` ticks while falling, y 39 to 19; every failed station walk ended below its station | `dig_down` only for a drop of three blocks or less, in `walk.js` (not `rules.js`: that is the simulator's golden contract) |
| 7 | The learned walk's choice of moves over islands: it wandered and gave up (`stuck: 60 decisions without getting closer`) on 40-55 % of the station walks; the moves it uses (bridge, pillar, walk) worked every time they were traced | all 18-20 failed walks of a run carry that reason, on level targets as well | `voidnav.js`: A* over walk / bridge / pillar, run with the action layer's own commands, replanned from where the bot stands; ahead of the learned walk for void dimensions (this branch) |

Also found, not caused by the code: the first versions of `real_move.js` walked through oceans into caves, `real_pit.js` counted 0 blocks left because `fill` is capped at 32,768 blocks, a first End run was contaminated by the bridges of earlier trials, and four bots teleported onto the 5 x 5 platform in one tick push each other off it (7 deaths in 6 minutes against 0 with one bot). Each is fixed in the harness or reported as a measured property.

## What is still open

- Crowding on the End platform: bots arriving together push each other into the void (production sends 24 bots through the gate). Staggered arrival (12 s) cut it; nothing in the code spreads them.
- `forced kill` after 60 s of unit errors still kills a bot that is moving (it costs the inventory and a trip through the gate); only the forced fall was changed.
- A station whose floor is a block the bot itself will dig (the last block of an island) is accepted as left on purpose: the unit says so (`skipped`, `floating`).
- The learned walk (move3) is unchanged for every dimension with a floor; its overworld result is 18/20 on the copy.
