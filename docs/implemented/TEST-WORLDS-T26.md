# TEST-WORLDS-T26: the Fabric 26.1.2 test worlds, the six server-graded tests and how to watch them

`TASK-20261114-063` (owner 2026-11-14). The place where movement, mining and placement are measured while the basics are built (MOD support is set aside): disposable Fabric worlds,
each a new random seed on every run, three or more in parallel, graded by the server, never by the bot.

## Why 26.1.2 and not 26.3

The owner's instance is Fabric 26.3 (`E:\Minecraft JAVA\instances\fabric 26.3\instance\mods`). Mineflayer 4.39.0 (the latest, 2026-09) speaks up to 26.1 (protocol 775); 26.3 support exists only in
open pull requests of minecraft-data and mineflayer. The servers therefore run **26.1.2** (protocol 775, the bots' own version) with **ViaFabric + ViaVersion 5.12.2**, which lets a 26.3 client join
an older server. The bots speak their native protocol (no translation between the bot and the server), only the owner's client is translated.

Server-side mods (the owner's list where a 26.1.2 build exists; client-only mods such as Sodium, Iris, minimaps, JEI stay on the client): fabric-api, carpet (also runs the `/dev` app), lithium,
ferrite-core, krypton, scalablelux, ksyxis, appleskin, jade, viafabric, viaversion. Pinned with sha512 in `docker/t26/mods.lock.json`; `scripts/t26/mods.sh` makes `/mnt/data/forgeaip-play/t26/mods`
exactly that set. Not available for 26.1.2 on Modrinth: modernfix, EssentialClient (server side), cupboard.

## Watching (the owner)

| What | Where |
| :-- | :-- |
| Join world N | Minecraft 26.3 client, server address **`100.77.246.23:2559N`** (world 1 = `100.77.246.23:25591` ... world 9 = `25599`), tailnet only. Operator: `Seia_Y` |
| Start a test from inside the game | `/dev run <test> [reps]` with `<test>` one of `move_a move_b mine_a mine_b place_a place_b`; `/dev status`, `/dev stop` |
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
/home/coder/projects/forge1201-MODED-AIPlayer/scripts/t26/dev.sh N start|stop|logs      # the /dev watcher of world N
```

`FIRST=k` puts a suite on worlds k.. (two suites side by side); `KEEP=1` reuses running worlds (debugging only); `CONTROL=noop` sends no command (the negative control: every trial must fail).
`NAV_TRACE=1` prints every plan segment and step of the walker. Containers: `forgeaip-t26-N` (server, 4 GB cap), `forgeaip-t26-dev-N` (watcher), `live-t26-N-<pid>` (a test run).

## The tests and their grading

Kit for every test: full tool set (diamond pickaxe, axe, shovel, sword, hoe, shears), 64 cobblestone (temporary blocks), 32 steak; Normal difficulty, keep_inventory false. A death fails the trial;
a server move (teleport) fails it. The scale (owner): 80 % or below = complete failure, 90 % = WIP, 100 % = success.

| Test | Setup | Pass (per trial, read from the server) | Required |
| :-- | :-- | :-- | :-- |
| `move_a` | 4 bots at the spawn, targets 2000 blocks E, W, S, N (`journey`) | within 4 blocks across of the target, alive | 100 % |
| `move_b` | 1 bot at the lowest standing cell of the nearest cave (200+ cells of air under a roof), command `surface` | `can_see_sky` at its feet, alive; the start must not see the sky | 80 % |
| `mine_a` | 4 bots at the corners of a 2000-block square, `obtain` wood, cobblestone, coal, raw iron, raw gold, 8 each | the server counts >= 8 of each in the pack | 90 % |
| `mine_b` | 1 bot, best tools (netherite, efficiency 255, unbreakable), 128 temporary blocks; pit job on the spawn chunk, top of terrain to y -59 | every layer equals air in the sky (`execute if blocks ... masked`); the untouched chunk fails the same check | 100 % |
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
