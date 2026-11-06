# Pure bots: a command-driven work layer beside the RL agent (v1)

`TASK-20261105-033` (2026-11-05). Owner brief: jobs that need no decisions ("dig this area", "build this house") should not be
generated step by step by the learned policy. They become **jobs** made of the existing commands, run by **pure bots**
(no policy, no LLM), shared out over any number of bots by a ledger. The RL agent stays what it is. Code: `src/work/`.
Tests: `tests/test_work_pure.js` (pure, in `npm test`), `scripts/work/pit_live.js` (live, disposable server).

## What is deliberately not changed (RL safety)

- The RL action matrix is `CMDS` and `K = 64` in `src/rl/skill_space.js`. Nothing in `src/work/` is imported there and
  nothing in `src/rl/` was edited, so the observation, the action space and the spec hash the learner sees are unchanged.
- Three small, backward-compatible edits to the action layer, none of them reachable from an RL candidate:
  `place` takes an optional `fluid: true` (fill a water or lava cell), `deposit`/`withdraw` accept shulker boxes, and
  nothing else. The 14 commands, their failure taxonomy and their benchmark (`SKILLS-v1.md`) stand.
- Rule for later: **a new action enters the RL matrix only by an owner decision**, because it changes the matrix every
  checkpoint was trained on. Pure bots may use any command or helper without that.

## Principles (they carry the whole design)

1. **Units are idempotent.** A unit (a row of cells in a layer) can be run twice, or after a half-finished run, and ends in
   the same world: mining air is a no-op, placing what is already there is skipped. So a job needs no exactly-once machinery.
2. **Success is what the world shows**, not what the command returned. A `mine` that fails in the drop pickup
   (`target_lost`: another bot took the item) has still opened the cell; the unit checks the world.
3. **Leases, not detection.** A bot holds a lease on a unit; it expires unless renewed. A dead bot needs no detector: its
   units come back. A late result for an expired lease is still accepted (rule 1).
4. **Layers settle in order** (digging top-down, building bottom-up). A unit that fails three times on three bots goes
   `stuck`, is reported, and does not block the layers behind it. A repair pass re-queues stuck units once
   (`Ledger.requeueStuck`), and a job ends with a diff of blueprint against world.
5. **Helpers work from the tail.** A bot with no region of its own joins the busiest one and takes units from the far end
   while the owner works from the head; they meet without talking.

## Part 3 first, because the others use it: the crew ledger (`src/work/jobs/crew.js`)

Pure and deterministic (the clock is an argument). Regions (a chunk of a pit, a tile of a building) hold `layers x rows`
units. API: `addRegion`, `claim(bot, pos, now, {batch})`, `done`, `fail(reason)`, `heartbeat`, `leave`, `reap`, `progress`,
`report`, `requeueStuck`. `claim` scores regions by distance (a bot keeps its own region first; other bots in a region add a
penalty, so unowned regions are taken before anyone is helped; when none is left the bot helps the busiest). Failure
semantics: `died`, `disconnected`, `cancelled` are the bot's fault and are not counted against the unit; anything else is an
attempt, the next claim steers away from the bot that failed (only while another bot is alive), three attempts make the
unit `stuck`.

Measured (`tests/test_work_pure.js`, simulated clock): 100 bots, 100 chunks x 6 layers x 16 rows = 9,600 units, units 6-10 s
(four times longer in one region in seven), 25 bots killed mid-unit (15 never return, 10 come back after 45 s): **all 9,600
units done, 0 stuck**, finished in 1,633 simulated seconds with helpers and 1,686 without (the benefit of helping is small
here because 85 bots outnumber the 100 chunks' tails; it grows as bots outnumber regions). A claim costs **0.03 ms** (10,894
claims in 340 ms). The ledger is therefore not a performance problem at 100 bots.

How this meets the owner's examples: "bot 3 dies, bot 10 takes over" = lease expiry plus the nearest free region by distance.
"Whoever finishes early helps the one who is behind" = helper from the tail.

Not done: a persistent ledger. It lives in the process that runs the job (as the RL environment's bots do); a process restart
starts from a world diff (`diffBuild`, and for pits the same units run again, all idempotent), which is why persistence was
left out.

## Part 1: open-pit excavation (`src/work/jobs/pit.js`)

One command per chunk: `planPit(box)` cuts `{x0,z0,x1,z1,top,bottom}` into chunk-aligned regions; a unit is one row of
a layer. The unit is `mine` repeated (which already walks, aims, picks the tool, and collects the drop). Expand an area by
issuing the next box.

- **Haul road.** A one-block staircase is left standing along the box edge (`planRoad`): cell *i* keeps every block at
  `y <= top - i`. Any bot, including a replacement that starts late, can walk down and out (the planner does step up 1 and
  drop 1). A pit deeper than its edge is long is refused (`haul road` error). Removing the road is not implemented (an exit
  by `tunnel` dy=+1 is the likely way; open).
- **Water rule (owner lesson 1).** Before a cell is opened, and again after, `sealPlan` finds water and lava in the cell and
  in its four horizontal neighbours and fills them with cobblestone, dirt or similar (`place` with `fluid: true`), each fill
  against a solid neighbour (below first), starting from the solid side. That is the owner's method: fill the fluid that would
  flow in the moment the block is removed, also from a neighbouring chunk. Fluid with no solid face anywhere (an open lake) is
  reported `invalid_target`, never tried.
- **Inventory upkeep (lesson 2, `src/work/bot/janitor.js`).** Before every unit `maintain` keeps `freeTarget` (6) slots free:
  surplus over `keep.max` goes first (cobblestone 64, dirt 32), then lowest value first by a value table (dirt 0 ... diamond
  100). Tools, armour, food and containers are never touched; nothing at or above `neverToss` (60) is thrown away: it is stored.
- **Storage (lesson 3).** `depot` is a chest (fixed coordinates) or a shulker box (the bot places it beside itself, fills it,
  breaks it again, contents kept). `restock` lists what a depot should hand back (protected minimums, food). Ender chests
  are **not implemented**: their contents belong to one player, so a crew cannot share them, and getting the chest back
  needs silk touch; they remain an option for a single bot.

Open: the pit digs rows but not the drop sweep (each `mine` collects its own drop; a sweep after the row would be faster);
lava lakes and caves below the floor are not planned for (a floor that gives way ends the unit `died`/`stuck`).

## Part 2: structures (`src/work/jobs/build.js`)

- **Format.** The game's own structure file (`.nbt`, as written by the structure block; **Create schematics are the same
  format**) is read by `fromStructureNbt`. `house({w,d,h})` generates a plain house. Cells are `{x,y,z,block}`.
- **Job.** `planBuild` tiles the blueprint by chunk, layer 0 = lowest; a unit is a row of a layer; structural blocks first,
  attached ones (doors, torches, ladders) last; each cell is `place`. `diffBuild` is the repair list.
- **Scaffold (3D-printer step, staged as the owner allowed).** When `place` answers `unreachable`/`not_visible`,
  `scaffoldFor` builds a stair of cheap blocks outside the footprint (column *j* is *K - j* blocks high), the bot climbs it
  and places level with the layer below; temporary blocks are removed top-down when the layer changes or the worker ends.
  Cost is about *K(K+1)/2* blocks per stair.
- **First new action to consider, and when.** `pillar_up` (jump and place under the feet) would cut the scaffold from
  *K(K+1)/2* to *K* blocks. Trigger to build it: structures taller than 6 layers, or scaffold blocks above 25 % of the
  blueprint in a measured run. It would be a pure-bot helper, not an RL action.
- **Limits.** Block properties are not reproduced (stairs, slabs, logs, doors come out as a click places them); mod blocks
  are listed in `plan.unsupported` and skipped (the `place` schema takes bare names). Neither is a design limit: both are the
  next steps once the vanilla house works live.

## Part 4: speed, CPU and Rust

- The ledger costs 0.03 ms per claim, so it is not a reason for Rust. What costs is a Mineflayer client: measured live
  numbers are in "Live check" below, and one Node process runs many bots (`src/rl/run_skill_env.js` already runs up to ten).
- The speed limit is the Minecraft server: one thread, 50 ms per tick; with 10 bots on natural terrain it ran 25-39 ms per
  tick (`SKILLS-v1.md`, LV2). `GAME_SPEED` / `tools/tickrate` can raise the clock only while a tick's work fits in `50 / k` ms.
  **Do not speed the game up for pure bots until the tick time is measured with the crew running.**
- A Rust player to replace Mineflayer is not worth it: the FML3 handshake, the exact mod registry and the chunk/physics
  model would all be rewritten (months), and the measured limit is the server. The coordinator could be Rust, but it is
  not on any critical path. Revisit when one of these is measured: client CPU per bot above 25 % of a core at 100 bots, or
  claim time above 1 ms.

## Play world and mods (outside the repository)

The play server is **not in this repository**: compose file, scripts, jars, world data and client-only jars all live in
`/mnt/data/forgeaip-play/` (its own local git repo, no remote; `README.md` there). `up.sh` / `down.sh` start and stop it
(127.0.0.1:25569, container `forgeaip-play`, volume `forgeaip-play_data`); `check-mods.py` checks the jars.

| Folder | Holds | Who loads it |
| :-- | :-- | :-- |
| `mods/` | jars the **server** needs: anything that adds blocks, items, entities, recipes, world generation or rules, and every library such a mod needs | the server and the owner's PC (same files) |
| `client-only/` | renderers, minimap, shaders support, recipe viewers, sound/UI tweaks | the owner's PC only, never mounted on the server |

Answer to "directly, or without addons?": **put the jars directly into `mods/`; the addons that add content must be there
too**, because Forge refuses a client whose content mods differ from the server's. Client-only jars go to `client-only/`;
a client mod left in `mods/` stops the server with a `net.minecraft.client` error (move it and start again).
`check-mods.py` reads `META-INF/mods.toml` and reports non-Forge jars, other Minecraft versions, duplicate mod ids, missing
mandatory dependencies and probable client-only jars. It cannot know every mod; the owner's favourite addons were not
picked or checked here, and that a given set works together is unverified.

Bots in the play world need that world's exact block and item table (`docs/implemented/MODPACK-v1.md`). Done 2026-11-05:
`scripts/world/registry-dump.sh --mods DIR --out FILE` dumps any mods folder (fresh world, no snapshot); the play world's table is
`/mnt/data/forgeaip-play/registry.json` (`./registry.sh` there), bots take it through `BOT_MOD_TABLE`. Rerun it after every mod change.
The console that runs the bots there: [WORK-CONSOLE-v1](../implemented/WORK-CONSOLE-v1.md).

Operation (2026-11-05): restart = `systemctl restart forgeaip-play` (unit and one sudo rule installed once by `/mnt/data/forgeaip-play/root-install.sh`, which also gives the VPS dashboard a Restart button; or `/mnt/data/forgeaip-play/up.sh`, which re-creates the container so `mods/` is re-read). Operator: `docker exec forgeaip-play rcon-cli "op <name>"`. The owner's first 32 mods had been copied into the build world's shared folder; see `docs/LESSONS.md` L18.

Permissions: `/mnt/data` is root's, the rootless Docker is coder's. The folder is created once by root
(`install -d -o coder -g coder /mnt/data/forgeaip-play`); `up.sh` run as root also makes the folder coder's before it re-runs
as coder, so root never has to touch it again. The tailnet route is one root command printed by `up.sh` (port 25566 ->
127.0.0.1:25569); it exposes a new tailnet port and is the owner's call.

## Live check

`scripts/work/pit_live.js`, 2026-11-05, disposable copy of the build world (Forge 1.20.1 + Create), a stone block in the sky,
box 32 x 16 x 3 (two chunk regions, 96 units), water planted in the ring outside the box (two cells, one open to the air, one
enclosed in stone) and buried inside the volume, 4 survival bots with iron pickaxes, one bot killed 40 s into the job.
Graded from the server (`fill ... replace` counts per layer, `execute if block`), not from the bots' reports.

| Run | Result | What it showed |
| :-- | :-- | :-- |
| p3 | FAIL, 47/96 | Iron pickaxes last 250 blocks: all three wore out and every unit they were on was charged as an attempt. Fix: `missing_tool`, `missing_item` and "chunk not loaded" are the bot's problem, not the unit's; a bot with three failed units in a row retires (`unhealthy`). The killed bot respawned at the world spawn and burned units in the meantime |
| p4 | 95/96 | A water cell enclosed in the wall next to the last stone could not be clicked before the dig (no open face). Fix: before the dig only fluid that can be seen is filled; after it the opened cell is the window, the pocket is filled first, the cell last, and a plug is dug again. Reproducer in `tests/test_work_pure.js` |
| **p5** | **PASS, 96/96** | 0 cells left in the volume (3 layers, server-graded), both ring waters sealed, no stuck unit, the killed bot's row taken over; 33/32/30 units by the three survivors, wall 725 s (about 8 s of bot time per cell row of 16, i.e. one `mine` incl. drop pickup per 1.2 s) |

Measured on the way: 4 bots in one Node process used 8 % of one core and 241 MiB (about 2 % and 60 MiB per bot; 100 bots
would be roughly 2 cores and 6 GB, extrapolated, unverified); the server used 16 % of a core. Not measured: more than 4 bots,
the server tick time under a crew, anything on natural terrain, a deep pit with the haul road walked by a late bot.

Seen but not fixed: `not_visible` / `target_lost` between bots working near each other (another bot takes the click); retries
and the ledger absorb them (3-4 failed units of 96, each redone by another bot).

## Tasks that follow

1. Pit: drop sweep after a row; road removal; lava and cave floors; tool wear (a spare-pickaxe minimum in `restock`, or crafting).
2. Build: block properties for stairs, slabs and logs; mod blocks (namespaced `place`); `pillar_up` by the trigger above.
3. Ledger persistence only if a job outlives its process in practice.
4. ~~`registry-dump` for an arbitrary mods folder~~ done; the console is built (WORK-CONSOLE-v1).
5. A thin command (`-dig`, `-build`) in the LLM intent layer that creates a job, once the jobs are verified live.
