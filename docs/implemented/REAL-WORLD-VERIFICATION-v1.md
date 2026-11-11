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

## Results

(filled in below as each family is measured; every row names its world)

## Causes found and fixed

(see the bottom of this file)
