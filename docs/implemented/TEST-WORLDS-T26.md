# TEST-WORLDS-T26: the server-graded test worlds (Fabric 1.21.1 since 2026-11-25, 26.1.2 frozen), the tests and how to watch them

`TASK-20261114-063` (owner 2026-11-14), version-agnostic since `TASK-20261125-074`. The place where movement, mining and placement are measured while the basics are built (MOD support is set aside):
disposable Fabric worlds, each a new random seed on every run, three or more in parallel, graded by the server, never by the bot. The name "T26" and the folder `scripts/t26/` are historical:
the scripts serve every version.

## Versions: one profile decides (2026-11-25)

Owner 2026-11-25 (list 5, Medium 1): 26.x compatibility is poor, the system must not depend on one version, move to Fabric 1.21.1. The game version lives in ONE place, the profile
`docker/tw/<name>.json` (Minecraft version, loader, the bots' protocol version `bot`, the server image by digest, the name tag, the port base, the server mods pinned by sha512);
`docker/tw/PROFILE` names the current one, `TW_PROFILE=<name>` picks another for one command. `scripts/t26/profile.sh` is its only reader; no other script or module names a version
(the bots get `MC_VERSION` from the profile; without it a Fabric bot asks the server by a status ping).

| Profile | Worlds | Game port (tailnet) | Containers / volume | State |
| :-- | :-- | :-- | :-- | :-- |
| `fabric-1.21.1` (current) | 1..9 | `100.77.246.23:2562N` | `forgeaip-w121-N`, watcher `forgeaip-w121-dev-N`, runs `live-w121-N-<pid>`, volume `forgeaip-w121-N_data` | the test worlds |
| `fabric-26.1.2` | 1..9 | `100.77.246.23:2559N` | `forgeaip-t26-N`, `forgeaip-t26-dev-N`, `live-t26-N-<pid>`, volume `forgeaip-t26-N_data` | FROZEN 2026-11-25: stopped, volumes kept |

Slots on the 1.21.1 worlds (docs/proposed/OWNER-LIST-5.md): 1-3 migration then 075/081, 4 075/081, 5 078, 6 079, 7 076, 8 077, 9 080.

**1.21.1 server mods** (Modrinth, sha512 in `docker/tw/fabric-1.21.1.json`; `scripts/t26/mods.sh` syncs them to `/mnt/data/forgeaip-play/tw/w121/mods`): fabric-api 0.116.18, carpet 1.4.147, lithium 0.15.4,
ferritecore 7.0.3, krypton 0.2.8, ksyxis 1.4.6, scalablelux 0.1.0.1, servux 0.3.17, syncmatica 0.3.14-sakura.5 (accepts the bots' Syncmatica client 0.3.20), appleskin 3.0.6, jade 15.10.6,
shulkerfix 1.5.1 (the 1.7.x builds list 1.21.1 but their minecart mixin fails to apply there and the server does not start), simple-autopickup 1.4.20. No ViaVersion: the owner's client is 1.21.1.

**Test-server settings (owner list 5 Small 4 and 5).** Every temporary block is a **pumpkin**: `run.sh`/`dev.sh` set `TEMP_BLOCK=pumpkin` (the kit's blocks and the bots' first choice, `src/work/bot/tempblocks.js`);
`TEMP_BLOCK=cobblestone` overrides for one run. A broken block's drops go **into the breaker's pack**: the simple-autopickup mod (server defaults in `config/AutoPickup/global_config.json`: blocks on,
mob loot off); with a full pack the drop lies on the ground as in vanilla. Production consoles keep their own `tempBlock` setting. Checked by `scripts/t26/version_probe.js` (below).

**Game rules** are snake_case on 26.x (`keep_inventory`) and camelCase on 1.21.1 (`keepInventory`): `scripts/t26/rule.sh N <rule> <value>` and the harness's RCON (`lib.js ruleSpellings`) send the
spelling the server accepts, so test code may write either.

**Version probe** (`scripts/t26/run.sh N version_probe.js`): login in the profile's protocol, inventory (bot and server agree), item components (an enchanted pickaxe), dig, drops into the pack, a full
pack drops on the ground, a pumpkin placed, a short walk, chat; PASS/FAIL per check, graded by the server. 2026-11-25 on 1.21.1 world 1 (seed -8840818871772942392): **9/9**.

**The frozen 26.x set (2026-11-25, TASK-20261125-074).** Stopped, nothing deleted:

| What | Volume / data | Start again |
| :-- | :-- | :-- |
| T26 worlds 1-4 (`forgeaip-t26-1..4`, watchers `forgeaip-t26-dev-1..4`; 5-9 were not running) | `forgeaip-t26-1_data` .. `forgeaip-t26-6_data` | `TW_PROFILE=fabric-26.1.2 scripts/t26/up.sh N` |
| `fabric26-survival-hard`, `fabric26-survival-op` (exited since 2026-11-23) | `fabric26-worlds_survival_hard_data`, `fabric26-worlds_survival_op_data` | `docker compose -f /mnt/data/fabric26-worlds/compose.yaml start survival-hard survival-op` |
| `fabric26-console-survival-hard`, `fabric26-console-survival-op` (stopped 2026-11-25 23:15 JST; survival-op's job `j2` (pit 16x16x140, 0 of 70 units done, no bots) was paused first through the console's API) | `/mnt/data/fabric26-worlds/console-data/survival-*` | `docker compose -f /mnt/data/fabric26-worlds/compose.yaml start console-survival-hard console-survival-op` |
| KEPT RUNNING: `fabric26-creative` (25601) and `fabric26-console-creative` (3031), data untouched | `fabric26-worlds_creative_data` | - |

The map view reads both world layouts itself (classic `region`, `DIM-1/region` and 26.x `dimensions/minecraft/<dim>/region`, `src/work/world/maps.js`), so a 1.21.1 console mounts the world folder directly.

## Why 26.1.2 and not 26.3 (history: the frozen 26.x worlds)

The owner's instance is Fabric 26.3 (`E:\Minecraft JAVA\instances\fabric 26.3\instance\mods`). Mineflayer 4.39.0 (the latest, 2026-09) speaks up to 26.1 (protocol 775); 26.3 support exists only in
open pull requests of minecraft-data and mineflayer. The servers therefore run **26.1.2** (protocol 775, the bots' own version) with **ViaFabric + ViaVersion 5.12.2**, which lets a 26.3 client join
an older server. The bots speak their native protocol (no translation between the bot and the server), only the owner's client is translated.

Server-side mods (the owner's list where a 26.1.2 build exists; client-only mods such as Sodium, Iris, minimaps, JEI stay on the client): fabric-api, carpet (also runs the `/dev` app), lithium,
ferrite-core, krypton, scalablelux, ksyxis, appleskin, jade, viafabric, viaversion. Pinned with sha512 in `docker/tw/fabric-26.1.2.json` (until 2026-11-25 `docker/t26/mods.lock.json`); `scripts/t26/mods.sh` makes `/mnt/data/forgeaip-play/tw/t26/mods`
exactly that set when that profile is chosen. Not available for 26.1.2 on Modrinth: modernfix, EssentialClient (server side), cupboard.

## Watching (the owner)

| What | Where |
| :-- | :-- |
| Join world N | Minecraft 1.21.1 client, server address **`100.77.246.23:2562N`** (world 1 = `100.77.246.23:25621` ... world 9 = `25629`), tailnet only. Operator: `Seia_Y`. (Frozen 26.x worlds: 26.3 client, `2559N`) |
| Start a test from inside the game | `/dev run <test> [reps]` with `<test>` one of `move_a move_b mine_a mine_b place_a place_b`; `/dev status`, `/dev stop` |
| The Litematica build (2026-11-19) | `/dev run place_c_area`, `/dev run place_c_layer`, `/dev run place_c_window`: the iron farm by three bots in 20 minutes, by the three methods of the builder (docs/implemented/SYNCMATICA-v1.md); chat gives the site, the progress every 2 minutes, the verdict |
| Watch a bot | `/dev bots` (names, positions, health), `/dev follow <bot>` (spectator on the bot; sneak to leave), `/dev back` (survival again at the spawn) |
| Results | in chat as they come (PASS/FAIL per bot), and `/mnt/data/forgeaip-play/t26/out/<run>/` (one JSON per world, `verdict.txt` for a suite) |

Bot names say what they do: `MvE1` (move A, east, world 1), `Cave2` (move B, world 2), `Mn3w1` (mine A, corner 3, world 1), `Pit5` (mine B, world 5), `BrN6` (place A, north, world 6), `Bld4` (place B).

## Commands (VPS, user `coder`, no elevation)

```bash
/home/coder/projects/forge1201-MODED-AIPlayer/scripts/t26/up.sh N [--new] [--seed S]   # start world N (1..9); --new = a new random world; also starts its /dev watcher
/home/coder/projects/forge1201-MODED-AIPlayer/scripts/t26/down.sh N [--purge]          # stop it (--purge deletes the world)
/home/coder/projects/forge1201-MODED-AIPlayer/scripts/t26/suite.sh TEST [WORLDS] [NAME=value ...]   # the standard run: WORLDS (default 3) new worlds, TEST on all in parallel, graded
/home/coder/projects/forge1201-MODED-AIPlayer/scripts/t26/run.sh N TEST.js [NAME=value ...]        # one test on one running world (debugging; not evidence)
/home/coder/projects/forge1201-MODED-AIPlayer/scripts/t26/rcon.sh N <server command>
/home/coder/projects/forge1201-MODED-AIPlayer/scripts/t26/rule.sh N <game rule> <value>       # either spelling (keep_inventory / keepInventory)
TW_PROFILE=fabric-26.1.2 /home/coder/projects/forge1201-MODED-AIPlayer/scripts/t26/up.sh N    # any command on another version (here: a frozen 26.x world)
/home/coder/projects/forge1201-MODED-AIPlayer/scripts/t26/dev.sh N start|stop|logs      # the /dev watcher of world N
```

`FIRST=k` puts a suite on worlds k.. (two suites side by side); `KEEP=1` reuses running worlds (debugging only); `CONTROL=noop` sends no command (the negative control: every trial must fail).
`SEEDS="s1 s2 s3"` gives world k the k-th seed instead of a random one: **an equal-box comparison of two settings** (run the suite twice with the same SEEDS, e.g. `METHOD=sweep` and `METHOD=expert`, or `PIT_LAKE=0|1`).
`scripts/t26/rcon.sh N -- ...` passes negative coordinates (the `--` is built in since 2026-11-16: `rcon-cli` took `-15` for a flag).
`NAV_TRACE=1` prints every plan segment and step of the walker. Containers (tag `w121` on 1.21.1, `t26` on 26.x): `forgeaip-<tag>-N` (server, 4 GB cap), `forgeaip-<tag>-dev-N` (watcher), `live-<tag>-N-<pid>` (a test run).
`REPO=/path/to/worktree` runs a script's harness and watcher from another checkout (the worktree needs a `node_modules` directory as a mount point; the main checkout's modules are mounted).

## The owner's three standing Fabric servers (2026-11-16)

Before the Forge MODs the system is verified on vanilla: three standing Fabric 26.1.2 servers, seed 1359280 (compose project `fabric26-worlds`, `/mnt/data/fabric26-worlds`, same server-side mod set as the T26 worlds), each with its own work console
(the repo is mounted read-only at `/app`: **a console restart deploys the committed code**; `docker compose -f /mnt/data/fabric26-worlds/compose.yaml restart console-creative console-survival-hard console-survival-op`).

| Mode | Game | Console | Server |
| :-- | :-- | :-- | :-- |
| creative | `100.77.246.23:25601`, Normal | `100.77.246.23:3031` | `fabric26-creative` |
| survival, hard, no cheats ("pure survival") | `100.77.246.23:25602`, Hard | `100.77.246.23:3032` | `fabric26-survival-hard` |
| survival for development (OP `Seia_Y`) | `100.77.246.23:25603`, Normal | `100.77.246.23:3033` | `fabric26-survival-op` |

`scripts/t26/f26.sh creative|survival-hard|survival-op script.js [NAME=value ...]` runs a harness script of this directory against one of them (the T26 tests are DESTRUCTIVE at the spawn: only when the owner is not building there).
All three are tailnet-only (the ports are bound to `100.77.246.23`; the consoles have no token, the network decides). Smoke 2026-11-16 (`smoke.js` on each): the bot logs in on 26.1, game mode and RCON kit work on all three
(the spawn of seed 1359280 is a snow/packed-ice area; the smoke's own mine/move targets were naive and not a finding).

## The tests and their grading

Kit for every test: full tool set (diamond pickaxe, axe, shovel, sword, hoe, shears), 64 temporary blocks (pumpkins since 2026-11-25, cobblestone before; `TEMP_BLOCK`), 32 steak; keep_inventory false. A death fails the trial;
a server move (teleport) fails it. The scale (owner): 80 % or below = complete failure, 90 % = WIP, 100 % = success.

**Difficulty (owner 2026-11-16):** the movement tests (`move_a`, `move_b`) run on **Normal**, every other test (`mine_a`, `mine_b`, `place_a`, `place_b`) on **Peaceful**. A hostile mob was a failure cause that cannot be told
apart from a fault of the system (mine_a: 18 deaths in one run, place_b: night deaths and timeouts); on Peaceful a failed trial is the system's. `lib.js open(names, settings, difficulty)` sets it, `DIFFICULTY=easy|normal|hard|peaceful` overrides for one
run, the report carries `difficulty`. Results of runs before this rule were all measured on Normal.

| Test | Setup | Pass (per trial, read from the server) | Required |
| :-- | :-- | :-- | :-- |
| `move_a` | 4 bots at the spawn, targets 2000 blocks E, W, S, N (`journey`) | within 4 blocks across of the target, alive | 100 % |
| `move_b` | 1 bot at the lowest standing cell of the nearest cave (200+ cells of air under a roof), command `surface` | `can_see_sky` at its feet, alive; the start must not see the sky | 80 % |
| `mine_a` | 4 bots at the corners of a 2000-block square, `obtain` wood, cobblestone, coal, raw iron, raw gold, 8 each | the server counts >= 8 of each in the pack | 90 % |
| `mine_b` | 1 bot, best tools (netherite, efficiency 255, unbreakable), 128 temporary blocks; pit job on the chunk of the **world spawn** (`bot.spawnPoint`; before 2026-11-16 the bot's join position, which differed between two runs of one seed), top of **terrain** (tree blocks do not count; 2026-11-16) to y -59 | every layer equals air in the sky (`execute if blocks ... masked`); the untouched chunk fails the same check | 100 % |
| `place_a` | 4 bots on a 3x3 platform 40 above the ground, `build_bridge` 30 blocks E, W, S, N | all 30 cells solid, the bot alive and not below the platform | 100 % |
| `place_b` | 1 bot with the exact materials, build job of a 7x7 cottage (floor, plank walls with a doorway and windows, roof) on a cleared site | `execute if blocks <site> <reference copy in the sky> all` (every cell, air included); the empty site must fail | 100 % |

## Results

Every number with its run id; runs of `suite.sh` only.

| Run | Test | Result | Worlds (seed) |
| :-- | :-- | :-- | :-- |
| `pa-b` (2026-11-14) | place_a | 12/12 = 100 %: success; control 0/4 | 5 (4877508311917734823), 6 (1714940017838245013), 7 (-5442695363753872941) |
| `ma-2000-a` (2026-11-14, before the walk's watch) | move_a | 0/12: every bot killed by night mobs | 1-3 |
| `ma-2000-b` (2026-11-14, watch + shelter at 12800, before the ice and shooter fixes) | move_a | 7/12 = 58 %: failure. 4 deaths at night (creeper, zombie, skeleton, pillager), 1 stuck arriving on an ice field (fixed: motion.js settle), 2000 blocks walked in 12-13 min by the others | 1 (-1128338543546415426) 2/4, 2 (1296430200317631099) 4/4, 3 (5550394729391805158) 1/4 |
| `mna-c` (2026-11-15, before the fight reflex) | mine_a | 6/12 = 50 %: failure. Every failure a bot killed by mobs (18 deaths, most underground while prospecting), which empties the pack | 6 (-3608000158804418219) 2/4, 7 (650888077947636532) 3/4, 8 (-2733350037816559178) 1/4 |
| `ma-2000-c` (2026-11-15, fight reflex) | move_a | 7/12 = 58 %: failure. 0 deaths in the report but 1 drowning in the server log (the harness counted deaths from the bot object: fixed, now a deathCount scoreboard); failures: sank to the sea floor, pillar tried under water, false "airborne", walks stopped for mobs it could not see (all fixed after the run) | 1 (5796927504813443504) 3/4, 2 (-8034123977708391188) 2/4, 3 (-677045203917096275) 2/4 |
| `pb-b` (2026-11-15, fight reflex, no night rule for jobs) | place_b | 0/3: failure. Night deaths (creeper, skeleton) and 40-minute timeouts; one-world runs before passed (pb-dev9: exact match in 3 min) | 4 (223802918269862176), 5 (1312173931742770498), 6 (6858382251929967949) |
| `mb-dev3` (2026-11-15, one world, 24 layers: a rehearsal) | mine_b | 1/1: box empty, 0 temporary blocks left, 27 min. The full-depth suite `mnb-a` was stopped: a coast chunk (water), a seal "inside rock", a death | 5 (-4370935164365506369) |
| `ma-2000-d` / `ma-2000-e` (2026-11-15) | move_a | 6/12 and 6/12: failure. Deaths (polar bear, guardian, drowned, zombies, creepers), walks timed out at a world spawn (a body wedged in the air: fixed in motion.js), "no move gets closer" at a coast | d: 1-3; e: 1 (-7884184696080837577), 2 (-5330471634005749682), 3 (-7350197736432623214) |
| `mvb-a` .. `mvb-d` (2026-11-15) | move_b | 2/3, 1/3, 2/3, 2/3 (67 %: failure, 80 % required). Failures: pillars stuck or without a floor in caves (pillar now only in open air), one death in a cave | 4-6 |
| `ma-2000-f` (2026-11-15 04:00, all fixes up to the wedge fix) | move_a | 8/12 = 67 %: failure (world 3: 4/4). Failures: 3 deaths, 1 stopped 1421 blocks short | 1 2/4, 2 2/4, 3 4/4 |
| `pb-c` (2026-11-15 04:00, fight reflex + night rule) | place_b | 0/3: failure. World 6 finished with one wrong cell (0,2,0); worlds 4 and 5 timed out at 40 min with the floor unbuilt | 4, 5 (-4682962233442891065), 6 (-843350994303942033) |
| `cmp-sweep-a` / `cmp-expert-a` (2026-11-16, DEPTH 24, Peaceful) | mine_b, sweep vs expert | **not an equal-box comparison**: the box was taken from where the bot joined (random around the spawn), so the two methods dug different chunks for seeds 4461664185924705895 and 8573729881198107154; only seed -8223826995433110289 had one box (x 0..15 / -16..-1, top 93 = a tree canopy): sweep 1606 s, expert 463 s, both FAIL with the same leftover (3 leaves at the box corner, 91-93) | 1-6 |
| `lake-b` (2026-11-16, expert, DEPTH = the pond's layers, pond planted by command: smoke, NOT evidence) | mine_b `POND=8x2` / `6x6`, `PIT_LAKE=0|1` | pond 8x8x2: lake fill on **PASS 480 s**; off not finished after 12 min (163 temporaries). Pond 6x6x6: on and off both stuck after 12 min (too deep: PIT-LAKE-v1) | 2, 4, 5, 7 (seed -8223826995433110289) |
| `cmp4-sweep` / `cmp4-expert` (2026-11-16, **equal boxes**: the chunk of the world spawn, top of terrain, DEPTH 16 = 16 layers, Peaceful, no night rule on Peaceful, lake fill on, 40 min limit) | mine_b, **sweep vs expert** | seed 4461664185924705895 (box -16..-1 x 16..31, 7 water cells): **sweep PASS 1335 s**, **expert FAIL 867 s** (3 dirty layers: 5 lake-fill cobble blocks left at the box edge z 30-31, units parked "could not stand at the station"). Seed 8573729881198107154 (box 64..79 x 48..63): **sweep PASS 1365 s, expert PASS 706 s**. Seed -8223826995433110289 (box 0..15 x 0..15): both stuck on the first unit (sweep "still far after a long walk toward it", expert "could not stand at the station"), see the note below the table; stopped by hand after 34 of 40 minutes with 9 of 256 / 4 of 8 units done | 1-3 sweep, 4-6 expert |
| `lake-c` (2026-11-16, final code, expert, pond 8x8x2 planted by command: smoke, NOT evidence) | mine_b `POND=8x2` | **PASS 378 s** (169 + 11 water cells, lake fill and the job-end cleanup of the fill blocks) | 7 (seed -8223826995433110289) |

**Sweep vs expert on equal boxes (`cmp4-*`, 2026-11-16):** where both finished the expert took **0.52 x** the time of the sweep (706 s against 1365 s) and was the only one to leave blocks behind (the lake-fill cobble at the edge of seed 4461's box, cells whose
station it could not stand at). The sweep never failed a unit it started (256 of 256 in both finished runs) but is slow and has no learned order; the expert's station choice halves the time and its weakness is the edge cells and irregular ground (parked units
with "timeout at expert: N cells left after 40 stations" in the earlier runs `cmp-expert-a`: forest and hill chunks), where the tile sweep simply walks every tile. Neither removes aerial trees (canopy over the ground, leaves left floating when the ground under them was dug):
the earlier box with the canopy (`top 93..96`) failed identically for both methods. One seed (-8223826995433110289, box 0..15 x 0..15) stopped both methods on their first unit; the cause (the bot cannot walk to the box) is open. Three seeds, one box each: this is a comparison, not a statistic.

**Why earlier wall times were wrong:** before 2026-11-16 the night rule (shelter: dig in and wait up to 12 minutes) also ran on Peaceful, so `mine_b` (and every peaceful test) lost whole nights standing still: "`place` hanging 8-10 minutes" in `cmp-sweep-a` was one night. Fixed in `7ef28b89`.

