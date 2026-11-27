# CI-v1: two CI layers, GitHub Actions on every push and a live regression suite on test world 9, with a per-commit history in the work console (TASK-20261125-080)

While the Litematica builder is the focus, one part can stop working after another is changed (pit, movement, tags); the owner asked (list 5, Medium 2) for CI over the
parts that are not the focus, to see harmful side effects and unintended improvements. Two layers do it: unit tests on GitHub, and a live, server-graded suite on the VPS.

## 1. Unit layer: GitHub Actions (`.github/workflows/ci.yml`)

| What | When | Where |
| :-- | :-- | :-- |
| `npm ci` + `npm test` (every file of `tests/suite.txt`) on Node 20, then `bash -n` over `scripts/ci/*.sh` and `scripts/t26/*.sh` | every push to `main`, every pull request | `ubuntu-24.04` runner |
| `cargo test --release` in `tools/sim` | the same | the same |

The repository is **public**: no self-hosted runner, no secrets, a read-only token, actions pinned by commit. scip-neo4j indexes the repo by its own workflow and is not touched.
Status: `gh run list --branch main` (green on every main commit since `c788e373`).

## 2. Live layer: the regression suite on test world 9 (`scripts/ci/`)

| File | Role |
| :-- | :-- |
| `plan.txt` | the tests, in order: name, script, fixed seed, wall-minute cap, arguments |
| `regress.sh` | one run: a clean checkout of the commit, every test of the plan on a NEW world of its fixed seed, then one test again on a random seed; never into 03:00 JST |
| `trigger.sh` | when to run (cron every 15 minutes) |
| `history.js` | the run into the record and the change against the previous run, both ways |
| `tags.js` | the tags test (supply and storage by tag), new with this task |

**Where it runs.** Test world 9 only (`forgeaip-w121-9`, watcher `forgeaip-w121-dev-9`, harness `live-w121-9-<pid>`; the slot table of docs/proposed/OWNER-LIST-5.md), Fabric 1.21.1
(the current profile). The code under test is a clone of the GitHub repository in `/mnt/data/forgeaip-play/ci/repo`, checked out detached at the ref (default `origin/main`) and
cleaned; the main checkout is never used or changed (its `node_modules` is mounted read-only, as for any worktree). The test-world scripts of that commit run the worlds, so a
broken `up.sh` shows as a failed run too. After the run the world volume is purged (the host's disk was 91 % full on 2026-11-27).

**The tests** (each at the profile's game speed for that test, docker/tw/fabric-1.21.1.json `speed`; graded by the test itself from the server):

| Test | Script | Fixed seed | Shortened from the T26 standard | What it guards |
| :-- | :-- | :-- | :-- | :-- |
| move_a | `scripts/t26/move_a.js` | -3948922381433624433 | 500 blocks instead of 2000 (`DIST=500`) | the long walk, 4 bots, Normal |
| move_b | `move_b.js` | 7909747904445256419 | no | out of a cave |
| mine_b | `mine_b.js` | 8573729881198107154 | the top 8 layers (`DEPTH=8`) | the pit job, its tidy, temporary blocks |
| tags | `scripts/ci/tags.js` | 1082013240725284109 | (new) | supply by tag (`take_tool` from `tools`, `take` from `free` past a nearer decoy), storage by tag (the pit's upkeep `put_away` into `ore` / `trash` / `any`) |
| place_a | `place_a.js` | -4868116279633443435 | no | bridges |
| place_b | `place_b.js` | -1779212649668294440 | no | a small build job |
| place_c | `place_c.js` | 8905895637385764084 | 15 game minutes (`LIMIT_MIN=15`) | a Litematica blueprint through Syncmatica (it does not finish today: the record is its trend) |
| build_t | `build_t.js` | 1910909542698516191 | the sorter cell (`tests/fixtures/sorter-cell.litematic`), 2 bots | the short build: the survival crew of the console's construct job on natural terrain |
| container_b | `scripts/native/container_b.js` | 5477162645604014481 | `TOTAL_MIN=10` | 076's container contents (`set_contents` into the owner's 61 filter containers); needs the blueprint copy in `/mnt/data/forgeaip-play/t26/out/bp-076/` (not in the public repo) |

Fixed seeds make a commit-to-commit comparison an equal box; the **random repeat** (one test per run, in turn by the number of recorded runs, or `RANDOM_TEST=name`) keeps the
suite from fitting its seeds. The shortened tests are a regression signal, not the owner's evidence: T26 STANDARD numbers still come from `scripts/t26/suite.sh` (three new worlds).

**When.** `trigger.sh` from coder's crontab (`*/15 * * * *`, `CRON_TZ=Asia/Tokyo`, through `kvs-run forgeaip:ci-trigger`, run-log job `forgeaip:ci-trigger`) starts a run when
a new `main` head (read with `git ls-remote`) has stood still for 30 minutes (a burst of pushes is one run of its last commit) and the last run ended an hour ago or more; and
nightly at 21:xx JST when no run started in 20 hours. It never starts in 02:00-06:00 JST, and `regress.sh` skips (and records as skipped) every test that could not end before
03:00 by its cap. One run at a time (`flock` on `/mnt/data/forgeaip-play/t26/out/ci/lock`). A full run takes about 1.5-2 hours of one world (one Minecraft server, 4 GB cap, plus one
harness container); the other slots are not touched.

By hand: `scripts/ci/regress.sh` (`REF=origin/<branch>`, `LABEL=word`, `TESTS="tags place_a"`, `RANDOM_TEST=name|none`), best through
`kvs-run forgeaip:ci-regress --trigger manual -- ...`. A labelled run is compared with main's last run but never becomes the baseline.

**Holds.** The cron trigger has no schedule API, so a run's own entry is its run-log record (`forgeaip:ci-trigger` / `forgeaip:ci-regress`, a long "running" run while it
goes). Runs never overlap the 03:00-06:00 maintenance window, which is what a hold protects; a run started by hand inside a session is covered by that session's `schedule_add`
hold, as the first runs were (`sch_tnhtCvGRGQQjStQe`).

## 3. History and the console page

`/mnt/data/forgeaip-play/t26/out/ci/`: `history.jsonl` (one line per run: id, commit, subject, per test verdict / trials / seconds, `worse`, `better`), `runs/<id>.json` (every
test with seed, speed, failures and its change against the baseline), `report-latest.txt`; the logs and the tests' own JSONs in `out/ci-<id>/` and `out/ci-<id>-fixed|random/`.

**Change both ways.** For each test the baseline is the same test of main's previous run: the rate is `worse` / `better` / `same`, the time is compared when both passed (changed
beyond 25 % and 30 s); a test with no result counts below every rate. A run lists what got worse AND what got better.

**Console page "CI"** (`public/work/page_ci.js`, `src/work/web/routes/ci.js`): the runs newest first, one column per test (red = worse than the run before, green = better); a click
shows the run's tests, seeds, failures and the values before. Read-only: `GET /api/ci/runs`, `GET /api/ci/run/<id>`, from `WORK_CI_DIR` only, behind the console's session, Host,
proxy-header and Access checks (no new listener, nothing new reachable from outside); run ids match a closed pattern; symlinks out of the folder are refused
(`tests/test_ci_route_pure.js`). The 1.21.1 consoles mount the folder read-only (`docker/tw/creative.yaml`, `survival.yaml`: `/mnt/data/forgeaip-play/t26/out/ci:/ci:ro`,
`WORK_CI_DIR=/ci`).

## 4. Results

Fabric 1.21.1, test world 9, server-graded by the tests; every number with its run and seed.

**The tags test alone** (development, world 9 seed 2203264275787308638, 2026-11-28 00:30 JST): 2/2 (supply: pickaxe from `tools`, 16 torches from the farther `free` chest, the
nearer decoy untouched; storage: 32 raw iron + 20 coal in `ore`, 64 gravel in `trash`, 8 pearls in `any`, nothing left); `CONTROL=noop` on the same world 0/2.

**First suite, run `1128-0034-c788e373`** (main `c788e373`, 2026-11-28 00:34-01:32 JST, 58 minutes for ten tests on one world): 6 of 10 passed.

| Test | Seed | Speed | Result | Notes |
| :-- | :-- | :-- | :-- | :-- |
| move_a (500 blocks) | -3948922381433624433 | x1 | FAIL 3/4, 705 s | MvW9 died twice and stopped 19 blocks short ("no move gets the bot any closer") |
| move_b | 7909747904445256419 | x3 | FAIL 0/1, 16 s | Cave9 killed by a mob at the start in the cave (Normal); it then stood at the surface after the respawn, which the death fails |
| mine_b (top 8 layers) | 8573729881198107154 | x3 | PASS 1/1, 149 s | |
| tags | 1082013240725284109 | x1 | PASS 2/2, 27 s | |
| place_a | -4868116279633443435 | x4 | PASS 4/4, 23 s | |
| place_b | -1779212649668294440 | x3 | PASS 1/1, 98 s | |
| place_c (15 game min) | 8905895637385764084 | x1 | FAIL 0/1, 971 s, 571 of 1 514 cells wrong | timeout, as every place_c run so far (TEST-WORLDS-T26: 0/3); the wrong-cell count is its trend |
| build_t (sorter cell, 2 bots) | 1910909542698516191 | x1 | PASS 1/1, 95 s, 0 wrong cells | |
| container_b | 5477162645604014481 | x1 | PASS 1/1, 221 s | 61/61 containers exact |
| move_a, random repeat | 7770586999566846290 | x1 | FAIL 2/4, 396 s | MvE9 and MvS9 died three times each near the spawn |

The movement failures are deaths on Normal (the class the T26 results already list for move_a and move_b), not a new fault; they are the baseline the next runs are compared with.

**Negative control, run `1128-0133-40b62d4a-negative`** (2026-11-28 01:33-01:36 JST): a commit on a side branch (`t/080-negative-control`, `40b62d4a`, never on main, branch deleted
afterwards) that classifies ores as trash in `src/work/bot/sites.js`, `TESTS="tags place_a"`. The suite caught it: **tags FAIL 1/2, rate worse (was 2/2)**; the storage trial found
32 raw iron and 20 coal in `trash` and none in `ore`, while the supply trial, which the break does not touch, still passed. place_a on the same commit 4/4 (same as main): the
break shows where it is and nowhere else. The run is in the history with its label and did not become a baseline.

## 5. Limits

- One world, one run at a time: a full run is about an hour (58 min here), so a burst of commits is tested at its last commit, not each one.
- Shortened tests (move_a 500 blocks, mine_b 8 layers, place_c 15 minutes) and one trial per test: a 3/4 against 4/4 can be chance (deaths on Normal). Read a single change
  as a hint, a change that stays over two or three runs as a finding; the random repeat shows the spread.
- The runs use the main checkout's `node_modules` (read-only): a commit that changes dependencies is tested with the installed ones until the main checkout runs `npm ci`.
- container_b needs the owner's blueprint copy in `/mnt/data/forgeaip-play/t26/out/bp-076/`; without it the test records `no_result`.
- The trigger runs `scripts/ci/trigger.sh` of the main checkout: it starts working once the orchestrator has pulled main there (cron line guarded by `[ -x ... ]`).
