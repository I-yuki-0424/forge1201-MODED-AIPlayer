# STUCK-SNAPSHOTS-v1: three 2D pictures per stuck, slow or progress event of the bots, kept in one folder the console and Nextcloud show (TASK-20261127-084)

When a bot gets stuck, loses time without an error, or a build's interval is over, the work service draws what was around the bot (or the build) as small
PNGs with the facts of the moment, under a hard byte budget, in one folder on disk that the work console's Snapshots page and Nextcloud both read.

Owner (2026-11-27, schedule sch_WbOh5Ca6lamorfKy): 2D first; events = the stuck signals, slow-but-not-error phenomena and a progress picture per crew
every ~10 min, each rate-limited; a hard total budget of about 2 GB and small PNGs; one copy on disk, visible in Nextcloud for the account Claude only
(never admin); a viewing page in the work console behind its session. The 3D replay is TASK-085 (deferred).

## 1. What is drawn

| Kind | Trigger (src/debug/stuck.js) | Limit (per bot or build / per run) |
|---|---|---|
| `stall` | log line `[stall] <bot> no action for N s at x,y,z` (build/drive.js) | 1 / 2 min, 40 |
| `no_stance` | `no way to the stance x,y,z` | 1 / 2 min, 40 |
| `move_no_start` | `[move] <bot>: no start at x,y,z` | 1 / 2 min, 30 |
| `no_progress` | `no progress` | 1 / 2 min, 30 |
| `evacuate` | `<bot>: evacuated from x y z` | 1 / 2 min, 30 |
| `death` | `<bot> died at x,y,z` | 1 / 1 min, 40 |
| `guard` | the fall guard held the bot back >= 100 ticks within one 10 s poll | 1 / 5 min, 20 |
| `slow_plan`, `retry`, `long_wait` | the build's open pause (build/pauses.js `open`): a plan holding the thread >= 15 s, retrying after a failure >= 20 s, waiting for another bot or the server >= 30 s | 1 / 5 min, 20 each |
| `progress` | every `STUCK_PROGRESS_MIN` (10) min per running construct build, the first one interval after its start | 1 / 10 min, 150 |

An event of a bot: `top.png` (feet level, each column down to its first block), `along.png` (vertical slice along the facing) and `across.png`
(across it), 13 x 13 cells, each picture the bot's own world beside the server's truth (RCON `execute if block` per cell: ghost, missing, other
state, other block), block textures from `/mnt/data/forgeaip/mc-assets/<version>` (flat colours without them), blocks at their shape (slab, bed,
open trapdoor, partial heights in 16ths), the exact body box, the route (`rec.path`), temporary blocks, other bots, the last fall-guard hold and the
cell the line names. `event.json`: position, yaw, controls, health, phase, the build mover's last 8 steps (`moves`, from `bot.__mover`, set in
`Mover.note`), guard episodes, the log lines 3 min before and 20 after, the server check (`server.checked`, `diff`, `ms`, `commands`) and `renderMs`.
A `progress.png` shows the build box from above and from the side: done / left / parked / claimed columns, bots, temporary blocks.

## 2. Where the files are

`<STUCK_DIR>/<RUN>/<NNN-kind-bot>/` (pictures + event.json), `<RUN>/index.json` (events by kind, refused and dropped counts), `<STUCK_DIR>/status.json`
(bytes used, budget, pruned). In harness runs `STUCK_DIR` defaults to `/out/stuck` = **`/mnt/data/forgeaip-play/t26/out/stuck`** on the host. The
budget (`STUCK_BUDGET_MB`, default 2048) counts the whole folder across runs; over it the oldest events go until 90 % remain. Pictures are indexed
PNGs (256 colours). The folder is gitignored (`stuck/`, `data/work/stuck/`).

- **Work console**: page "Snapshots" (`public/work/page_stuck.js`), routes `/api/stuck/runs|run/<r>|event/<r>/<id>|img/<r>/<id>/<view>.png`
  (`src/work/web/routes/stuck.js`): GET only, same session as every route, closed patterns for every path part, the file must resolve (symlinks
  followed) inside `WORK_STUCK_DIR`. The consoles of `docker/tw/creative.yaml` and `docker/tw/survival.yaml` mount the folder read-only at `/stuck`
  (`WORK_STUCK_DIR=/stuck`). Unauthenticated requests: 401 (measured on 3034/3035 for `/api/stuck/runs`, an image path and a traversal attempt).
- **Nextcloud**: external storage `aiplayer-snapshots` (mount id 3), a read-only bind of the same folder into the Nextcloud app and cron containers
  (`/srv/aiplayer-snapshots`, vps-containers `nextcloud/compose.yaml`), applicable to the user `Claude@i-yuki.com` only (no admin, no group). Set up
  2026-11-27 through the credential broker's root route after a `vps-backup`; vps-containers README "AIPlayer snapshots", `deploy/nc-test.sh` checks it.
  One copy on disk: nothing is uploaded or duplicated.

## 3. Switching it on

**On by default in harness runs** (a container with `/out`, i.e. every `scripts/t26/run.sh N script.js [RUN=name]`; `run.sh` mounts the texture
cache read-only at `/mc-assets`), off elsewhere (the consoles); `STUCK_SNAPSHOTS=1` / `0` forces it on / off. Runs from frozen code snapshots
(`REPO=<snapshot>`) made before this change keep the old opt-in behaviour. Other knobs: `STUCK_DIR`, `RUN`, `STUCK_BUDGET_MB`, `STUCK_MAX` (scales every cap),
`STUCK_PROGRESS_MIN`, `STUCK_ASSETS`. The hook is one line in `WorkService.note()` (src/work/service/index.js); the work is scheduled off that call,
one event at a time, the server check sequential on the shared RCON, pictures drawn one per event-loop turn, PNG compression on the thread pool.

## 4. Live check (slot 8)

Test world 8 (`forgeaip-w121-8`, Fabric 1.21.1, seed -5919885026834366270, game speed x1, server capped at 2 CPUs / 4 GB), code of this task on
2026-11-27 19:00-19:55 JST, the host shared with test worlds 1, 4 and 5 (host busy 32 % on average during st084b).

| Run | What | Result |
|---|---|---|
| st084a | `build_t.js` BOTS=4 LIMIT_MIN=40, random seed | no dry site in 30 draws (an ocean world): no job, no events |
| st084b | `build_t.js` BOTS=4 LIMIT_MIN=40 SITE_BIOME=forest, snapshots on | the job stayed in its prepare (pit) stage for 40 min; **4 progress events** (one per 10 min), 7.8-7.9 KB and 80-95 ms each; no stuck line in 40 min, so no stuck event. Server ms per tick (`tick query`, 5 s samples): 6.08 mean in the 10 s after a progress event vs 5.83 elsewhere (n = 5 / 316): no visible cost (progress pictures use no RCON) |
| sp084a | `stuck_probe.js` (new): 4 bots on slabs in the air, 3 rounds of a `[stall]` line per bot through `WorkService.note()` | **9 stall + 2 death events** (two bots died on their own and their death lines fired too). Per event: **RCON server check 103-175 ms for 774-1477 `execute if block` commands** (0 cells differed, 0 unchecked), whole event (check + 3 pictures + PNG) **212-353 ms**, **12-37 KB** for the three PNGs, textures found (1.21.1). Server ms per tick: idle 6.57 mean / 7.6 max (n = 6), while the events ran 5.63 / 6.8 (n = 127): no rise. No "event loop blocked" warning in the harness during the events |
| sp084b | the same, one round, **without STUCK_SNAPSHOTS** (default-on check) | 3 stall events (127-175 ms RCON, 256-295 ms each), idle 5.45 / busy 5.47 ms per tick; the 4th simultaneous line was dropped by the queue of 3 (`index.json` dropped 1), as designed |

Decision: the load is small (well under one tick of server time per event, spread over ~3 ticks; tens of KB), so the snapshots are on by default in
harness runs. At the per-run caps a run writes at most ~440 events (~13 MB at 30 KB); the 2 GB budget holds tens of thousands of events.

Not measured: a real `[stall]` / `no way to the stance` line from a build (st084b had none in 40 min; the probe's lines go through the same hook and
code path); the cost on a server at a faster game clock (SPEED-v1).

## 5. Not done

- Pit jobs have no progress picture (only construct builds).
- The consoles' own jobs write no snapshots (off outside a harness, and their mount is read-only; turning it on there needs `STUCK_SNAPSHOTS=1`, `STUCK_DIR=/stuck` and a writable mount of the same folder).
- Four lines at the same moment: the fourth is dropped (queue of 3, counted in `index.json` `dropped`).
- 3D replay: TASK-085.
