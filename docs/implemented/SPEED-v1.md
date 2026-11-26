# SPEED-v1: faster test runs by a faster game clock on the test worlds, measured per test type (TASK-20261125-079)

The test worlds tick k times as fast with vanilla `/tick rate` and the bots follow the server's own announced rate; this doc says what was changed, what
limits k, the measured factor per test type against the same seeds at 1x, and the wall time of a standard run before and after.

Owner (list 5, Medium 3, 2026-11-25): one test run takes at least an hour; raise the server's plain processing speed with the time acceleration tried
early in RL, and use the Rust server. The Rust half is TASK-078 (docs/proposed/SIM-PARITY-v1.md); section 7 names what is handed to it.

All numbers: Fabric 1.21.1 test world 6 (`forgeaip-w121-6`, server cap 2 CPUs / 4 GB as every test world), seed 6169108031784577097 unless stated,
mineflayer's physics, inventory and dig (076's native modules opt-in since 0e1d55ac: one bot implementation for every comparison), the code of
main up to df4f295e (2026-11-26 12:35; the place_a and earlier runs of 2026-11-25 23:55-02:00 on the same commits before they landed), the
host shared with 2-8 other test worlds (host load and busy share in every table: contention is named, not read as the factor's ceiling).

## 1. How the clock is sped up (on main since df4f295e)

| Part | What | Where |
| :-- | :-- | :-- |
| Server | `/tick rate 20k` (vanilla since 1.20.3, no mod; day length, movement, digging, growth, mobs all scale together; a server setting, not a bot cheat). Not saved with the world: `up.sh` sets it on every start from the profile's `speed` (`docker/tw/<profile>.json`, default 1) or `SPEED=k` for one start; `scripts/t26/speed.sh N [k]` reads or changes it on a running world. | `scripts/t26/up.sh`, `speed.sh`, `profile.sh` (`TW_SPEED`) |
| Bots | The server announces its rate to every client (`set_ticking_state`, on join and on each `/tick rate`); a vanilla client ticks at exactly that rate, and so do the bots: `time_scale.follow(bot)` sets the process clock (mineflayer's `performance.now` and the `doPhysics` poll) to rate/20 whenever the packet comes, continuously, while bots run. `GAME_SPEED` is only the start value (and the whole story on Forge 1.20.1 with tools/tickrate, which has no such packet). | `src/transport/time_scale.js`, `fabric_bot.js` |
| Bots | **One physics tick per poll** (`maxCatchupTicks: 1`): mineflayer caught a late poll up with up to 4 ticks on the input of the last frame while the action layer gives one frame per tick; see section 4. | `time_scale.botOptions()`, `fabric_bot.js`, `forge_bot.js` |
| Waits | Every wait counted in ticks that is a server reply scales (L16, already: `ctx.until`, the dig confirm window). Test limits now count **game** minutes: `lib.js budget()` reads the world age the bot receives, so a test gives the bots the same game time at every speed (wall minutes stay the outer bound). | `scripts/t26/lib.js` (`command`), `mine_b.js`, `place_b.js`, `place_c.js`, `build_t.js` |
| Tools | `speed_sample.sh` (every 10 s: `/tick query` mean and P50/P95/P99 ms per tick, achieved rate from game time, CPU of server and harness, host load, busy and steal), `loop_lag.js` (harness event-loop delay and CPU), `trace_fail.js` (per-tick trace of every failed runner command), `speed_ab.sh` (one test, one seed, several speeds), `speed_report.py` (side by side). | `scripts/t26/` |

076's native physics (src/native, default on main since 0fff3f8a) replaces only `simulatePlayer` under mineflayer's loop, so it runs on the same scaled
clock and the same one-tick poll without a change.

## 2. What limits the factor (measured)

Three different things limit it, one per kind of test. Each sample is `speed_sample.sh` every 10 s while the harness ran (`speed_report.py`).

| Kind | Tests | What runs out first | Evidence (world 6, 1.21.1) |
| :-- | :-- | :-- | :-- |
| Short, local, few bots | `place_a`, `mine_b` (`place_b`, `move_b`: section 3) | nothing up to x6: the server keeps the rate on loaded chunks (mean 3-4 ms per tick at x3-x6), the harness is idle | place_a x3 60.3 of 60 ticks/s, x4 73-74 of 80, x6 91 of 120 (the trial still 5.2x shorter in wall time: 31 -> 6 s); mine_b x3 60.0 of 60 every minute (worst minute 59.9), 3.7 ms per tick |
| Long walks into new terrain | `move_a` (4 bots x 2000 blocks) | the **server** at 1x already: generating and sending new chunks for four bots that walk outwards keeps it at 15-20 ms per tick on average with P99 spikes of 1-2.7 s; at x2 it reaches 39.6 of 40 on average but its worst minute is 24, at x4 65 of 80 (worst minute 35) | spd-ma-x1 mean 20.5 ms, worst minute 15.7 ticks/s at **1x**; the server container at its 2-CPU cap (peaks 209-215 %) |
| Builds, eight bots in one process | `build_t` (`place_c`) | the **harness**: one Node process plans and steps all eight bots; the server is at 42-61 % of one core | spd-bt-x1/x2: harness CPU 77/90 % mean, peaks 154-156 %, event loop blocked up to 2.5-2.9 s ("no physics tick for 2394 ms"); the work done per WALL minute is the same at x1 and x2 (section 6) |

The harness's own CPU was also the first limit of the walk: a CPU profile of move_a at x2 showed 33 % of the busy time in `require()` path
resolution inside the planner's floor check (db42ee62 resolves the modules once per bot); after it the move_a harness's event-loop P99 fell from
439-463 ms to 83 ms at 1x (spd-ma-x1 vs d-ma-x1, same seed).

Wall-time parts of a bot do not scale with the game clock: a NAV plan, a wait for the planner or a blocked event loop takes the same milliseconds at
every speed, so at kx the world moves on k times further meanwhile. That is the mechanism behind every result that changed with k (section 3).

## 3. Results: the same seed at 1x and kx, graded by the server

One world (slot 6), new world per run, seed 6169108031784577097, the test's own server-side grading (suite.js). "Same seed" fixes the terrain
and the world spawn (mine_b's box was the same chunk in both runs) but not where a bot joins: vanilla scatters a joining player within
`spawnRadius` 10 of the spawn, so move_a's targets and move_b's nearest cave moved by up to 20 blocks between runs (section 7). Host contention
is in each row (load average, busy share of all 12 cores, steal; steal was 0.0 in every sampled run).

| Test | Run | k | Asked / achieved ticks/s (worst minute) | Result | Wall time of the test | Host load / busy |
| :-- | :-- | --: | :-- | :-- | :-- | :-- |
| place_a | spd-pa-x1 | 1 | 20 / 20.0 | 4/4 | trial 31 s | 5.3 |
| place_a | spd-pa-x2 | 2 | 40 / 28.6 (two samples) | 4/4 | 16 s | 12.8 |
| place_a | spd-pa-x3 | 3 | 60 / 60.3 | 4/4 | 11 s | 15.0 |
| place_a | spd-pa-x4 (before the fix of section 4) | 4 | 80 / 73.4 | **2/4** (two bots fell off the bridge edge) | 8 s | 13.9 |
| place_a | spd-paf1-x4, spd-paf2-x4 (after) | 4 | 80 / 73.5-74.0 | 4/4, 4/4 | 8-9 s | 12-13 |
| place_a | spd-paf1-x6, spd-paf2-x6 | 6 | 120 / 91.0 | 4/4, 4/4 | 6 s | 15.5 |
| mine_b | spd-mb-x1 | 1 | 20 / 20.0 (19.8) | PASS (box 32..47 x -16..-1, 16 layers) | 444 s | 6.0 / 42 % |
| mine_b | spd-mb-x3 | 3 | 60 / 60.0 (59.9) | PASS (the same box) | 174 s | 5.6 / 46 % |
| place_b | d-pb-x1 | 1 | 20 / 20.0 | PASS (every cell, empty site fails) | 373 s (6 game min) | 8.5 / 57 % |
| place_b | d-pb-x3 | 3 | 60 / 60.0 (59.6) | PASS | 480 s (the build 1 min, the rest the final tidy: section 7) | 6.3 / 47 % |
| place_b | d-pbt-x1 (BUILD_TRACE) | 1 | 20 / 19.9 (17.1) | PASS | 486 s: units done at 58 s, then 11 tidy rounds over 406 natural blocks left in the box | 4.0 / 23 % |
| place_b | d-pbt-x3 (BUILD_TRACE) | 3 | 60 / 60.7 (59.8) | PASS | 78 s: units done at 32 s, 3 tidy rounds over 72 blocks (another site: the join point moved) | 3.3 / 31 % |
| move_b | d-mvb-x1 | 1 | 20 / 20.0 | PASS (cave 107 deep) | 264 s | 9.9 / 48 % |
| move_b | d-mvb-x3 | 3 | 60 / 59.7 (59.6) | PASS (another cave, 31 deep: the join point moved) | 30 s | 12.3 / 93 % |
| move_a | spd-ma-x1 (before db42ee62) | 1 | 20 / 20.0 (15.7) | 3/4 | 1486 s | 7.7 / 53 % |
| move_a | spd-ma-x2 (before) | 2 | 40 / 39.6 (24.4) | 2/4 | 875 s | 6.9 / 46 % |
| move_a | spd-ma-x4 (before) | 4 | 80 / 65.0 (35.5) | 1/4 | 864 s | 12.9 |
| move_a | d-ma-x1 (after) | 1 | 20 / 19.9 (16.6) | 1/4 | 1437 s | 8.8 / 52 % |
| move_a | d-ma-x2 (after) | 2 | 40 / 39.7 (33.4) | 2/4 | 828 s | 11.4 / 70 % |

move_a, read bot by bot (the pass rate alone is noise: the same seed gave 3/4 and 1/4 at 1x):

| Bot | 1x (spd, d) | 2x (spd, d) | 4x (spd) |
| :-- | :-- | :-- | :-- |
| N | fail 1318 short (died); fail at **2,62,-1600** "the same step failed four times: walk (timeout)" | fail at **2,62,-1600**, the same reason, both runs | fail 1467 short (2 deaths) |
| W | pass; fail stuck at **-640,113,-11** | pass; fail stuck at **-656,112,-15** | fail stuck at -608,111 |
| E | pass, pass | fail (5 deaths); pass | fail (2 deaths) |
| S | pass; fail (killed by a mob 10 blocks from the start) | pass, pass | pass |

The deterministic failures (N at one cell, W on one hill) come at the same place at 1x and 2x; what differs is random mob deaths, which
happened at both speeds. Before the planner fix, x2 and x4 had 5 and 6 deaths per run against 1-2 at 1x; after it, x2 had 1 (1x: 2). A bot
needs more game time per block at higher k (1x: 41-50 game seconds per 100 blocks for E/S/N; 2x after the fix 58-97; 4x 140-620), because
the parts of a walk that take wall time take the same milliseconds at every k (planning, measured; waiting for chunks the server is still
generating, inferred from its 15-20 ms ticks at 1x, not measured per step; nav/go.js's "failed four times" also needs 60 s of WALL time): at 4x
the world's nights and mobs got four times as long against each plan, and the deaths followed.

## 4. Found on the way: the catch-up burst (fixed)

At x4 a poll is due every 12.5 ms; the harness's event loop was late by more than that at its p99 (25-42 ms in place_a). Mineflayer then ran up to 4
physics ticks in one poll, all with the input of the last frame, while the runner had answered only the first: in `spd-pa4b` (place_a x4) BrN6 slid
0.19 blocks in one runner tick at the bridge edge (trace t 332-333), the bridge's two empty idle frames let go of sneak at the very edge, and it fell
40 blocks; the first x4 run lost two of four bots the same way. Fix at the cause: one physics tick per poll (a late loop makes a bot skip ticks, a
lagging client, never act on stale input), and the bridge comes to rest still sneaking. After the fix place_a x4 and x6 passed 16/16.
The burst existed at 1x too (a 200 ms stall = 4 stale ticks) but rarely; every k makes it k times more likely.

## 5. The factor per test type and the default

Rule: a test gets the highest k at which every measured run gave the same graded result as 1x on the same seed and the server kept the
rate in its worst minute within about 20 %. Set in the profile (`docker/tw/fabric-1.21.1.json`, `"speed"`); `suite.sh` starts its worlds at the
test's k, `SPEED=k` overrides for one run, `"default"` is every test not named (new tests start at 1x until measured).

| Test | k | Why not higher |
| :-- | --: | :-- |
| place_a | 4 | equal up to x6 (16/16 at x4 and x6 after section 4's fix), but at x6 the server gives 91 of 120 ticks/s: x4 is the highest rate it keeps (73-74 of 80) |
| mine_b | 3 | measured at x1 and x3 only (same box, both PASS, the server at 60.0 every minute); x4 not measured |
| move_b | 3 | measured at x1 and x3 (PASS, PASS; the server at 59.6-59.7) |
| place_b | 3 | measured at x1 and x3 twice each (four PASS); the build itself 1.8x faster in wall time, the tidy after it does not scale (section 7) |
| mine_a | 2 | 4/4 at x1 and x2 (595 s against 1096 s); the server's worst minute at x2 was 21.7 of 40 (chunk generation for four bots 2000 blocks apart): x3 would not be kept |
| move_a | 2 | the same deterministic failures at x1 and x2 (section 3), deaths not higher after the planner fix; the server's worst minute 33.4 of 40; at x4 it gave 65 of 80 and the bots needed 3-12x the game time per block |
| place_c, build_t | 1 | the harness is the limit: at x2 the crew does the same work per WALL minute as at x1, so a limit counted in game minutes (lib.js budget) gets half the work done (section 6) |
| default | 1 | |

This is one world and one seed per row (the owner's standard is three new random seeds per test): enough to see a change caused by k at the
places where the tests fail deterministically, not to measure a pass rate. TASK-080's regression suite runs at these factors and will show a
k-caused change as a difference against its 1x history.

## 6. Wall time before and after

**The six T26 tests**, one world each, the test itself (world creation, about 1 min per world, not counted; it does not scale):

| Test | 1x | at the profile's k | factor |
| :-- | --: | --: | --: |
| place_a (k 4) | 31 s | 8 s | 3.9 |
| mine_b (k 3) | 444 s | 174 s | 2.6 |
| move_b (k 3) | 264 s | 30 s | (another cave) |
| place_b (k 3) | 373-486 s | 78-480 s | build part 1.8 (58 -> 32 s); the rest depends on the site's leftover terrain |
| mine_a (k 2) | 1096 s | 595 s | 1.8 |
| move_a (k 2) | 1437-1486 s | 828-875 s | 1.7 |
| **sum** | **about 61 min** | **about 33 min** | **1.8** |

A suite is three worlds of one test in parallel, so the suite's wall time is its slowest world: move_a and mine_a decide it, both at 1.7-1.8.

**The standard build run** (build_t, iron-farm-34, 8 bots, Peaceful, the same seed; spd-bt-x1 against spd-bt-x2, 15 game minutes each: LIMIT_MIN read from the progress lines, the runs' arguments were not logged; wall minutes since the harness started):

| Wall minute | 1x cleared / placed | 2x cleared / placed |
| --: | :-- | :-- |
| 3 | 503 / 5 | 627 / 1 |
| 6 | 1907 / 10 | 1888 / 5 |
| 9 | 3723 / 65 | 3905 / 8 |
| end of the 15 game minutes | 6666 / 181 (wall minute 15) | 3905 / 8 (wall minute 9) |

The work done per wall minute is the same at 1x and 2x: the build is not limited by the game clock. With the limit in game minutes, 2x ends
the run in 754 s instead of 1314 s with 59 % of the clearing and 8 of 181 placements, which is a different result, not a faster one. So the standard build run keeps
1x and its wall time is unchanged (120 game = 120 wall minutes plus the 10-minute wrap-up and the judge); what makes it faster is the
harness (section 7).

## 7. What stays slow, and what goes to 078's testing backend

**The build harness** (build_t at 1x, d-btp-x1, CPU profile of minutes 4-6, the clearing stage; the Node process was busy 47 of 120 s):

| Inclusive share of the busy time | Where |
| --: | :-- |
| 60 % | `plan` (src/build/move.js:192), the crew's A*: synchronous, up to 20,000 nodes; a plan that finds nothing expands all of them in one go ("no plan (nodes, 20001 cells ...)" in the log), which is where the event loop stops for 2.3-2.9 s and every bot with it ("no physics tick for 2394 ms") |
| 23 % | prismarine-world `getBlock` under `View.raw` (move.js:40) and `seen` (world.js:7): every cell read builds a new `Block` and a new `Biome` object (their constructors alone 13 % self time) and looks up block entities (3 %); the planner needs name, properties and box, which a state id gives without building objects |
| 19 % | `claim` (job.js:607) -> `ready` / `_logNear` |
| 8 % | packet parsing (minecraft-protocol framing, compression, protodef) |

And the build code waits in WALL time: src/build has 161 `Date.now()` and 77 `sleep`/`setTimeout` uses (src/work/bot 45/45, src/work/jobs
20, src/nav 9/10), e.g. the final sweep's 8 s between rounds (jobs/build.js), the idle fetch every 120 s, "no stance" for 20 s, the trip
spacing of 60 s (drive.js), nav/go.js's "failed four times" after 60 s. LESSONS L16 says such waits must count ticks; while they count
milliseconds, a faster clock changes what they mean (a 60 s wait is 120 game seconds at x2), and the work per wall minute stays what it is.
Handed to 075/081 (owners of src/build, src/nav, src/work/jobs): (1) game-tick clocks for those waits, (2) the planner's block reads by
state id (`bot.world.getBlockStateId` and a table per state), (3) a node cap or time slicing for plans that cannot succeed, (4) eight bots in
one Node process share one JS thread: two processes of four would double the CPU the crew can use.

**place_b's tidy**: the build of the cottage takes 32-58 s, then the final tidy takes 20-430 s: it walks to and digs every natural block
the site still holds inside the box (406 on one site, 72 on another), 40 per round, at least 8 wall seconds between rounds. That is the
site preparation done last and one block at a time; 081 (pit mining for clearing) is where it belongs.

**move_a, mine_a**: the server is the limit (chunk generation for bots that walk into new terrain; section 2). Pregenerating would only move
that wall time to before the test on a new random seed. Both are the natural case for 078's testing backend: the packet front end
(scripts/sim/front.js) replays recorded chunks and steps the clock, 12x on place_b (98.4 % the recorded outcome) and 25x on move_b (99.7 %) in 078's
measurements, so the walk and the obtain chain can run there without generation. What 078 needs from here: the same seeds and runs as above as
its real-server reference (out/d-ma-*, d-mna-*), and the build's wall-time waits counted in ticks first, because its front end steps the
game clock but not `Date.now()`.

**Same seed, not the same start**: the bots join within `spawnRadius` 10 of the world spawn, so a "same seed" comparison of move_a, move_b
and place_b starts from different places (move_b found a 107-deep cave once and a 31-deep one the next time). A `gamerule spawnRadius 0`
on the test worlds would make it an equal-start comparison for 080's fixed-seed regression suite; it changes where the bots stand at the
start of every test, so it is proposed here, not set (074's scripts).

## 8. How to run

```bash
scripts/t26/speed.sh 6            # the factor of world 6;  scripts/t26/speed.sh 6 3  sets x3 (60 ticks/s) on the running world
SPEED=3 scripts/t26/up.sh 6 --new # one start at x3 (default: the profile's "speed")
REPO=$PWD PREFIX=cmp scripts/t26/speed_ab.sh 6 place_a "1 3" <seed> [NAME=value ...]   # same seed, several speeds, sampled
python3 scripts/t26/speed_report.py cmp-x1 cmp-x3
```
