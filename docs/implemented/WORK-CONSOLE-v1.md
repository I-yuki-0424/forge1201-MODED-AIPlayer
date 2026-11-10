# Work console v1: pure bots on the play world, with a web page to run them

`TASK-20261105-034` (2026-11-05). Owner brief: bring the bot system to the play world (the server on tailnet port 25566), start
testing the pure-bot features of [WORKERS-v1](../proposed/WORKERS-v1.md), decide whether the aux mod is still needed, and get a
management UI: designate open-pit areas, add and remove bots, edit structure NBT to make structural parts and build them.
Code: `src/work/` (map and "where do I change X": `src/work/README.md`), `public/work/` (one file per page). Tests: `tests/test_work_{service,console}_pure.js`,
`tests/test_blueprint_pure.js` (all in `npm test`).

## Answers to the owner's questions

| Question | Answer |
| :-- | :-- |
| Is the aux mod still needed? | **No, and it should stay off the server.** It is a client mod (status HUD, `/bot` commands, safe zones, macro screen, launcher) that talks to the *legacy* orchestrator, and its path overlay reads `ws://localhost:3001`, which only the legacy `bot_actuator.js` serves. The skills runtime and the pure bots send nothing there (open `TASK-20261101-023`). Its other jobs are done elsewhere: the exact block table by `tools/registry-dump` (`scripts/world/registry-dump.sh`), the test-world generator by the world scripts. It declares `side=BOTH`, so a copy on only one side may be refused at login (Forge `MATCH_VERSION`; unverified here). It is not in the play world's `mods/`. If it is in the PC's mods folder, take it out. |
| MODUI or WebUI? | **WebUI**: the work console below. A mod UI needs a client mod on both sides (the aux mod problem again) and a protocol between mod and bots; a page needs neither and works from the PC over the tailnet. |
| Is the target environment set? | Yes: the play world (`/mnt/data/forgeaip-play`, 34 content mods + Distant Horizons 3.3.3, 127.0.0.1:25569, tailnet 25566) with its own exact block table (`registry.json`, 6,241 blocks of which 5,238 are mods', 202,126 states, 0 problems) and the console container `forgeaip-play-console`. |
| Distant Horizons | `DistantHorizons-3.3.3-1.20.1-fabric-forge.jar` is in the play world's `mods/` (fetched from Modrinth by the VPS, sha512 checked against the API: `2ac0a2fd…c0`; the PC's copy was not reachable from here). `mods.toml` says `acceptableRemoteVersions="*"`, so bots and clients without it can join. After the owner's restart the server log shows `Initializing Distant Horizons server`, and a bot logged in with the exact table (spawned, survival, overworld). |

## What it is

One Node process (`node src/work/console.js`, container `forgeaip-play-console`) holding:

- **Bots.** Pure bots (Mineflayer on the action layer, no policy, no LLM): add by name or a batch (`Work1..N`, at most 24 per process:
  measured 60 MiB and 2 % of a core per bot), remove, kit (RCON `give` of what is missing), automatic reconnect with backoff (the owner
  restarts the server often; a returning bot is put back to work), respawn after death. The roster and the jobs are saved to
  `console-data/state.json`; jobs come back **paused** (the world is the truth, rerun units are no-ops).
- **Pit jobs.** Two corners, top y, depth; "= player" reads the owner's position over RCON; "top = ground" reads the terrain from the chunks a bot
  has loaded; picking on the map; optional depot (chest at x y z, or a shulker box the bot places). The job is
  [WORKERS-v1](../proposed/WORKERS-v1.md) part 1 unchanged (chunk regions, haul road, water rule, janitor). Limits: 256 blocks per side, 256 deep,
  y -64..319; a pit deeper than its edge is long is refused with the reason; a new job that overlaps an active one is refused unless forced.
- **Structure library and editor** (`src/work/jobs/blueprint.js`). Upload a structure `.nbt` (structure block or Create schematic), see its size,
  counts per block, mods and which blocks the bots cannot place, scrub through its layers, and **edit it into structural parts**: rotate
  90/180/270, mirror x or z, replace (a name keeps the state, a full state `oak_stairs[facing=north]` replaces it), remove blocks, crop,
  fill a box, and **merge** other stored parts at offsets (negative offsets shift the result), then save under a new name or over the old
  one, or download the file. Generators: plain house, solid box, empty canvas. Block states are turned with the structure (facing, axis,
  rotation, fence/wall sides, stair shape and door hinge on a mirror, chest side, rail shape). Block-entity NBT is kept as it is; **stored
  world positions inside it (Create kinetic sources, linked controllers) are not moved**, so a rotated contraption needs a look in the game.
- **Build jobs.** A stored structure at an origin (minimum corner, layer 0 at `y`), optionally rotated or mirrored; the job gets its own copy
  of the file (editing the library later changes nothing). Mod blocks are placed by their namespaced name (`place` now accepts
  `create:cogwheel`; the RL action matrix and its spec hash are unchanged: candidates use bare names). Blocks that are not in the bots'
  registry are listed and skipped. "Give materials" hands the bots what the plan needs (RCON `give`, an operator action).
  After a build the plan is diffed against the world (missing blocks are reported).
- **Map.** Plan view: job boxes with progress, bots, players, and the draft you are typing; click to set a corner or an origin.

## v2 (2026-11-05 evening, `TASK-20261105-035`): map, per-bot control, inventories, point-and-click commands, public name

Owner feedback after the first session: coordinates alone tell nothing; bots are hard to manage; commands did not work and syntax must not be
memorised; the pit area should be selected on the map; the page looked sparse. What changed (all verified, see "Checks"):

- **Map from the server's data.** No map mod on the play server has a server-side API (JourneyMap's web map runs in the client), so the map is
  drawn from the world's region files (`src/work/world/mca.js`, read-only mount of the server volume at `/world`): top block per column at the
  MOTION_BLOCKING height, colour by block (vanilla table, keywords, hashed colour for mod blocks), shaded by the height step to the north.
  A region (≈ 900 chunks) decodes in ≈ 1 s in a worker thread (the bots' event loop is not blocked) and is cached by modification time;
  the browser caches decoded tiles. The map shows **saved** chunks: **Refresh from server** sends `save-all flush` and reloads. Overworld,
  nether and end. Overlays: job boxes with progress, bots, players, chunk grid when zoomed in, block grid when very close.
- **Pits: range selection like a spreadsheet.** The Pits page holds its own copy of the map. Drag over it: the selection snaps to **chunks**
  (shown as "2 × 2 chunks"); **Alt** drags single blocks; Shift extends; right-drag / Ctrl-drag pans; the wheel zooms. The coordinate fields
  follow the selection and can be typed for any area (large, or not on chunk boundaries); typing moves the selection on the map. "Top = ground"
  reads the terrain; "Operator chunk" selects the chunk the operator stands in.
- **Bots page (after the AWS instance list):** filter, state filter, checkboxes, bulk actions (stop, resume, remove), a detail pane with
  tabs (Commands, Summary, Inventory, History). Kit and auto-kit are gone from the UI (DPOD concern, owner 2026-11-05); the restock logic stays
  in the service, off by default.
- **Commands without syntax.** `/api/commands/catalog` lists the 15 action-layer commands plus `come`, `say`, `teleport`, `stop`, with typed
  arguments (`src/work/operator/catalog.js`, schemas taken from `src/skills/index.js`). The page builds a form from it: grouped dropdown, direction and
  slope selects, coordinate fields with **operator / bot / map** helpers (the map helper also reads the ground height), a nearby-entity
  dropdown for attack/pickup/look_at, item fields with a list of what the bot carries. Targets: **All bots**, **Selected (n)**, or one bot.
  Bots run in parallel, each on its own; the answer says who started and who refused (busy, working on a job, offline, bad argument) and
  the per-bot result stays in the table (`cmd`) and in History. A bot working on a job refuses commands (pause the job first); **Stop** cancels.
  Why the earlier "commands" did nothing: there was no command interface in the console (only the old WebUI's chat commands); this is it.
- **Inventory GUI.** Two panes (operator, a bot, or a container block) with slot grids (armour/off hand, 3 × 9, hotbar; containers 9 per
  row). Drag a stack to a free slot of the other side, or double-click for the first free slot; **Move all**. The move is
  `item replace <dst> from <src>` followed by clearing the source, so the stack keeps its NBT and nothing is created; the destination slot is
  re-read first and must be empty. Containers: coordinates, or "find near a bot" (blocks in the chunks a bot has loaded). Players are read with
  `data get entity` (`src/work/world/snbt.js` parses the reply), so a bot's inventory and the operator's are handled the same way.
- **Look.** Left navigation, stat tiles with sparklines, panels with header strips, dense tables, status dots and pills, light and dark by the
  browser's setting (Grafana's panel layout and the AWS console's filter-table-detail pattern).
- **Public name.** `WORK_PUBLIC_HOST` (e.g. `bots.i-yuki.com`) makes the console require a valid Cloudflare Access assertion
  (`Cf-Access-Jwt-Assertion`: RS256 against the team's keys, issuer, audience, expiry, optional e-mail list; `src/work/web/access.js`) on every
  request through that name; a valid assertion also signs the owner in. Loopback and the tailnet need no token since 2026-11-10 (v17: the network decides; `WORK_REQUIRE_TOKEN=1` brings the token back).
  It refuses to start with a public host but without `CF_ACCESS_TEAM` and `CF_ACCESS_AUD`.

### Checks (2026-11-05)

`tests/test_work_features_pure.js` (SNBT, inventory moves against a fake console incl. injection attempts, region reader on a synthetic Anvil
file, Access JWT with a generated key: expired / wrong audience / wrong issuer / other e-mail / bad signature / unknown key / `alg: none`, command
dispatch, routes, gzip, the Access gate on the public host) is in `npm test` (19 files, exit 0). The page was exercised twice: under jsdom (28
checks: navigation, batch add, filter, command forms for all bots and one bot, operator position helper, inventory drag-and-drop and double-click
against the server state, chunk-snapped and Alt selection on the map, typed coordinates, structures, jobs) and **in headless Chromium with
screenshots** (dark and light) against the play world's real region files; the review found and fixed "null" text from conditional children, a
selection that vanished while the top y was empty, cramped item tiles, and an empty Structures page. On the live play console: 33 region files
indexed, region (0,0) delivered in 23 KB gzip, the operator's and a bot's inventory read, `move_to` sent to one bot and completed,
nearby entities listed. **Not tested live:** container moves on a real chest (none was placed in the owner's world; the fake-console test covers
the commands), the Access path with a real Cloudflare token (no broker; the verification is unit-tested with a generated key), more than 5 bots.

### Public name (done 2026-11-05 late, through the credential broker `run` with `cloudflare/master`, audits 564-568)

`https://bots.i-yuki.com`: tunnel `vps` ingress `bots.i-yuki.com -> http://localhost:3020` (the list was fetched, the new rule inserted before the
`http_status:404` catch-all, 11 -> 12 rules, nothing else touched), proxied CNAME `bots` -> the tunnel, Access application `work-console (forgeaip)`
(self-hosted, session 24 h, the reusable policy `owner-allow-24h`: the owner's e-mail, Cloudflare login, no CN). Console env in
`/mnt/data/forgeaip-play/.env` (`WORK_PUBLIC_HOST`, `CF_ACCESS_TEAM`, `CF_ACCESS_AUD`, `WORK_ALLOWED_EMAILS`). Checked: an unauthenticated request to
the public name is a 302 to the Cloudflare login (page and API), loopback without a session is 401, the keys Cloudflare publishes at
`/cdn-cgi/access/certs` are fetched and parse (2 RSA keys). Not seen: a browser login through Access (the owner's). Recorded in the `cloudflares`
repo (`snapshot/`, `docs/HOSTNAMES.md`). Rollback: delete the Access app, the CNAME and the ingress rule; unset `WORK_PUBLIC_HOST`.

## v3 (2026-11-05 night, `TASK-20261105-036`): deep pits that do not stop, waiting for tools, `gather`

Owner: the pit stopped after a little digging; the depth should reach y -64; "mine" should take a *what* (a number of an item), using the world's
data to find the blocks and digging everything within reach of one standing place before walking on.

- **Why the pit stopped.** The owner's job was a 16 x 16 x 1 pit on the shore with four bots that carried nothing (Kit had been removed). `mine`
  needs a pickaxe for stone (`missing_tool`), and the water rule needs a seal block next to the shore (`missing_item`); both are the bot's problem,
  each bot failed three units and retired, the job sat at "blocked". Not the depth: but the depth had a limit too (next point).
- **Depth to bedrock.** The haul road had to fit on the box's edge (60 cells for 16 x 16: a pit could not be deeper than 60). It is now a spiral: when
  the edge ring is used up it continues on the next ring one block in (`pit.js planRoad`); a 16 x 16 box goes from y 62 to y -59 (122 layers), a
  32 x 32 box takes the full height of the world; a 4 x 4 box is still refused with the reason. The Pits form has `bottom y` beside `depth` (two views of one
  number) and buttons `to y -59` (the lowest layer without bedrock) and `-64`; bedrock (and other unbreakable blocks) are skipped, not failed.
- **Self-sufficient bots.** A cell whose water seal needs a block the bot does not have yet is left for after the row (digging brings cobblestone or
  dirt). A bot without the tool or the item now **waits, naming it** ("waiting for a pickaxe (to break stone): give one in Inventory and it continues by
  itself") and goes back to work by itself within 2 s of the item appearing in its inventory (the operator gives it through the Inventory page).
- **`gather {target, count?, radius?}`** (Blocks group; `src/work/jobs/gather.js`). `target` is a block or an item name: `iron_ore`, `raw_iron`,
  `oak_log`, `cobblestone`, `sand` ...; an item name finds every block that drops it, an ore name brings its deepslate variant. The blocks are found in the
  chunks the bot has loaded (`bot.findBlocks`, up to 64 blocks), exposed ones first, **nearest to where the bot stands now**: so everything within reach
  (4.5 blocks) of one standing place is dug before the bot walks (`mine` only walks when the block is out of reach). Count = items obtained (inventory),
  or blocks when the target has no item. Blocks that touch water or lava are never opened. A block buried in rock is reached by tunnelling at most 4 cells
  sideways or upwards into it from an air face (head room is dug too, so the bot can step in and pick up the drop); **straight down is not possible**
  (`mine` never stands on the block it breaks) and is reported as such. The form has "Find around the bot" (how many were found, how many exposed and within
  reach, the nearest) and progress `n/N` in the table. Stop cancels it.
- **Checks.** `tests/test_work_gather_pure.js` (resolution, clusters in reach, walking only between clusters, enclosed / too deep / lava / missing tool /
  cancel, tunnelling with head room), spiral road, bedrock skip, deferred seal and tool-waiting tests; all in `npm test` (20 files, exit 0).
  Live on a disposable Create server through the console with **8 bots**: 6 x 6 pit from y 159 to y 135 (25 layers, more than the 20-cell ring: spiral), bedrock
  floor, bots empty-handed: all six waited for a pickaxe by name, resumed on their own when given one, 150 of 150 rows (one repair pass), 386 s, the 300 stone blocks
  left are exactly the road, the bedrock layer untouched; `gather raw_iron 5` from a cluster in reach: 10 s, no walking; `gather raw_iron 4` from ores 2 cells inside a
  wall: 4 raw iron in 14 s with 5 tunnel cells dug, the ore beside lava left alone; chest <-> bot through the inventory GUI: take, take-all, put into a chosen slot, an
  occupied slot refused. On the real play world: `find oak_log` 156, `find raw_iron` 72 (1 exposed: iron is mostly buried).
  Defects the live run found: a one-block-high tunnel cannot be entered (the drops lay out of reach): head room is now dug; a block touching lava counted as "exposed": it no longer does.

## v4 (2026-11-06, `TASK-20261106-037`): pits that keep going, one X-Z range per bot

Owner, watching a live 16 x 16 pit (y 63 to -64) with four bots: it stopped on its own; only two bots finally moved; they dug the same spot; there is no
basic fixing when something goes wrong (jump, step aside, wait and retry), and too few retries. Read from the job's failure record (new: `recent` in the job
detail, with bot, cell, reason and the bot's position at that moment) and from the code:

- **Why it stopped.** After a failed unit a bot took the next one at once, and after **three failures in a row it retired for good** (`unhealthy`); three
  `unreachable` in a row (a bot standing outside the pit, or pushed aside) were enough. Nothing tried to get the bot out of whatever it was stuck on.
  A unit failed three times on three bots and went `stuck`.
- **Why the same spot.** One 16 x 16 box is one region, and a region hands out the rows of **one layer at a time**, so all four bots worked on the same
  layer on neighbouring rows, each standing where another needed to stand or break.
- **Lanes.** A pit is cut into one X-Z range per bot (`planPit(box, { lanes })`: a near-square grid, none thinner than 3 blocks; 4 bots on 16 x 16 give four
  8 x 8 ranges, 3 bots three stripes; a big box that already has as many chunks as bots keeps the chunks). The bot that owns a lane digs it layer by layer **down to the
  bottom**; others only help (from the far end of the lane) when their own lane may not go on. Lanes may not be more than **one layer apart** (`Ledger.maxLead = 1`), so
  the floors of neighbouring lanes never differ by more than a step and the bots can still walk between them. The Pits form has `Lanes` (auto = one per bot); a job shows its
  lane count; `lanes` is saved in the job and restored.
- **Fixes between retries (the ladder, `worker.js`).** After a failed unit: level 2 jump twice, level 3 step into a random safe neighbouring cell (free feet and head cell, solid
  floor), level 4 and up walk back to the cell where the bot last finished a unit; each time followed by a pause of **3, 5, 8, 12, 20, then 30 seconds**. Inside a unit the same
  ladder runs between the retries of one `mine` (up to four, 2 to 8 s apart; `unreachable`, `timeout` and `stuck` now count as retryable). A bot that needs a tool or an
  item does not retry: it waits for the operator (v3).
- **No permanent retirement.** After 12 failed units in a row (each after a fix and a pause) a bot **cools down for a minute and resumes by itself**, up to six times in a
  row; the counter resets with the first success. Units get 6 attempts instead of 3, and a finished job with stuck units gets **three repair passes** 15 s apart.
- **Checks.** Pure tests: lane layout and coverage, `maxLead` (the fast lane helps the slow one), the worker ladder and pauses, missing tool is immediate, cool-down
  and auto-resume in the service, all in `npm test` (20 files, exit 0). Live: see the STATE entry and the section below.

### World settings (owner, 2026-11-06)
`op Seia_Y` (level 4: the game's highest; ops.json already had two entries for the name, the offline and the online UUID), `difficulty peaceful`, `keepInventory`.
`/mnt/data/forgeaip-play/compose.yaml` now says `DIFFICULTY: peaceful`, `OPS: "Seia_Y"`, `OP_PERMISSION_LEVEL: 4`, `ENABLE_COMMAND_BLOCK: "true"`; the running server was
changed with RCON, and command blocks (a server.properties value) are on from the next start of the server.

## v5 (2026-11-06, `TASK-20261106-038`): pioneer digging, helpers, water, pillar exit, sites, worn tools, scripts

Owner brief 2026-11-06, items 2.1-2.7 (the RL part stays untouched: no RL command, action matrix or spec hash changed; every new argument is
optional and off by default, `tests/test_skills_*` and the full `npm test` pass).

| # | Owner point | What was built | Where | Verified |
| :-- | :-- | :-- | :-- | :-- |
| 1 | Strip mining digs one block, moves, digs one block | **Sweep** (default for new pits, `method: 'sweep'`): a layer is cut into tiles of at most 5 x 5; a unit is one *standing place*: the bot goes to the middle of the tile, steps into it and digs every cell within reach nearest first (`mine` with `collect: false`: no walk per drop), then picks the drops up once (stone and dirt are left once it carries 64 / 32), then the next place; places are ordered from the middle of the range outwards (a fan), helpers start at the far end. A place behind rock is reached by digging the first closed cell on the way. `method: 'rows'` is the old behaviour. | `pit.js` (`stationsOf`, `unitCells`, `goToStation`, `sweepDrops`), `mine` options in `skills/commands/block.js` | pure: same cells, 3.1 x fewer steps (432 vs 1,339 in the fake bot's cost model); live: see below |
| 2 | Falls into water | **Rescue**: in water -> nearest shore (breadth-first through water and air, lowest rim first), then stop the water: fluid cells that touch the open pit cells are filled (inflow from outside the box = plug at the wall; source inside the box = filled upstream inside the box), against something solid, below first. Runs before a unit when the bot is in water and after every failed unit (cheap scan when dry). The existing before/after seal of each cell stays. | `water.js`, hook in `worker.js` (`job.rescue`) | pure (plan, shore, rescue, no block = `missing_item`); a live fall into water was **not** staged |
| 3 | Chests that bots may take from, ore / storage / junk chests | **Sites**: name + x, y, z + tags `tools ore storage junk food blocks`. The upkeep puts each item in the chest of its class (ore, junk, storage; tools are never put into the tools chest), the scripts take tools from the `tools` chest. API: `GET/POST /api/sites`, `DELETE /api/sites/<name>`; stored in `state.json`. Without sites everything works as before (depot, or throw junk away). | `sites.js`, `janitor.js`, `service.js` | pure |
| 4 | Helping every block, low efficiency | A bot keeps its **home** region (the first it was given) while home has anything it may take at the current height; only when home has nothing to claim (done, or waiting for the neighbouring lanes through `maxLead`) it helps, the region furthest behind first, from the tail, and it goes **home again** the moment home has work. The rule applies at every height, so a bot that finished its layer helps the neighbour on that layer. | `crew.js` `claim` (`b.home`) | pure (3 regions, 3 bots) + live: helper units appear only at the end of each layer |
| 5 | Stairs at the edge | **Pillar** (`moves.js`, a work-layer move, not an RL command): look down, jump, place a low-value block under the feet at the top of the jump, land on it; then break the block *two below the feet* **without a line of sight** (`mine` with `blind: true`; the server checks the reach, not the line of sight; the body's only exception to "input only": frame field `cell`). One block is under the bot at any time; `finishPillar` takes the last one away from the side. `exit.js leavePit`: walk if a road allows it, else dig to the edge of the box at the bot's depth (those cells belong to the pit), pillar up the rest, step out. Sweep pits keep no road (`road: false`). Cost: one block per level (the broken block falls into the shaft). | `moves.js`, `exit.js`, `body.js` | physics simulation (prismarine-physics, server refuses a block into the body and a dig beyond 6 blocks): 6 levels, 5 blind breaks, one block left; live: 3 levels, nothing left in the box |
| 6 | Worn tools | `retireWorn` (setting, **default on**, `POST /api/settings {retireWorn:false}` turns it off at once for running bots too): a stack with <= max(8 uses, 6 %) durability left is not a candidate for `mine`; another stack of the same tool is held instead; none left = `missing_tool` with `detail.worn`. Off = the old behaviour. RL bots never set the option. | `skills/options.js`, `bestTool`, `holdItem(ok)` | simulation (fresh stack taken, only worn = missing_tool/worn, off = old); live: a pickaxe with 4 uses left was passed over |
| 7 | Scripts | `src/work/bot/script.js`: JSON, closed grammar (`cmd`, `if/then/else`, `take`, `take_tool`, `put_away`, `station`, `release_station`, `leave_pit`, `return`; conditions `has`, `tool`, `can_craft`, `site`, `free_slots`, `all/any/not`), validated when stored (unknown keys, commands, depth > 6, > 200 steps are refused). Built in: **replace-tool** = no usable pickaxe -> best tier from the `tools` chest -> else iron ingots (from the `ore` chest if tagged) + sticks (or planks to make them) -> table (made and placed if needed) -> craft the pickaxe -> take the table back -> back to work; **make-room**. A worker runs `replace-tool` when a unit fails `missing_tool` (3 tries in a row, then the bot waits as before); `settings.scripts` turns it off. API: `GET/POST /api/scripts`, `DELETE /api/scripts/<name>`, `POST /api/scripts/<name>/run {bot}`; the operator's scripts are files in `<dataDir>/scripts/`. | `script.js`, `worker.js`, `service.js` | pure (grammar, each branch of replace-tool, worker handler, 3-try limit) |

**Live check (2026-11-06, disposable copy of the build world, peaceful, `scripts/work/pit_live.js`, arena 24 x 12 x 3 in a stone block, 4 bots, no kills):**

| run | method | wall | units | result (graded from the server) |
| :-- | :-- | :-- | :-- | :-- |
| s1 | sweep, no road, one nearly broken pickaxe per bot (4 uses left), then bot 1 leaves | 221 s | 72/72, 2 retried | PASS: nothing left in the volume, ring and buried water sealed, bot 1 above the rim after a 3-level pillar in 8.5 s, no block of the column left in the box |
| r2 | rows, haul road kept (the old method) | 264 s | 72/72, 0 failed | volume graded FAIL by one cell in layer 1 (the road-row check of the script does not fit lanes; the job itself finished) |
| s3 | sweep, 2 bots, 12 x 8 x 2 | - | all | drops: the first stations pick up 4-10 items each; after that the bots carry 64 stone and leave it (by design) |

So the sweep is **16 % faster on the wall clock here** (221 s vs 264 s), far less than the 3.1 x fewer steps of the pure model: in this arena
the old method walked little, and a block of stone takes the same ~0.4 s to break either way. What the sweep saves is walking and drop
pick-up trips, which grow with larger stations and sparser drops; the next lever the pioneers named is the tool (efficiency, haste), not
the order of the cells. Not measured: more than 4 bots, deeper pits, ore-rich ground. A first attempt to run the rows baseline beside the
sweep run failed because both runs used the same bot names (the second login kicks the first): runs must not overlap.

What is deliberately **not** done: a late or respawned bot cannot walk
into a road-less pit (sweep jobs default to `road: false`; pass `road: true` to keep the haul road for that); the pillar does not recover the
blocks it breaks; the water rescue is not tested against a real fall (the live runs had water at the ring and buried inside, which the seal
rule handled as before); fights are out of scope (peaceful server only).

### v5 in the page and the API (2026-11-06, second step)

| Where | What |
| :-- | :-- |
| **Automation** page (new, `public/work/tools.js`) | *Settings*: Retire worn tools, Recovery scripts, Auto-kit (checkboxes, applied at once, also to bots that are working). *Sites*: table of tagged chests; form with name, x y z, tags; the position can come from a chest near a bot or from the operator's position. *Scripts*: list (built in marked), JSON editor with a template, **Validate and save** (the server validates; invalid JSON never leaves the page), **Run once** on an idle bot, a collapsible grammar reference. |
| **Pits** page | *Method* (sweep default / rows) and *keep a haul road* (off = bots leave by pillar). Sent as `method` and `road` to `POST /api/jobs/pit`. |
| **Bots** page | Summary lists the bot's tools with uses left (`iron pickaxe 212/250`, a bar, worn ones in red), the running script, and **Leave pit** for a bot inside its pit's box (also a bulk button for the selection). The bot must be idle: pause the job first (409 otherwise). |
| **Jobs** page | The job row says `pit sweep` / `pit rows` and `no road`. The job detail no longer carries the station list. |
| **Inventory** page | A durability bar on every damageable stack (green = new, red = nearly broken; tooltip `n of max uses left`). The server adds `max`, `damage`, `left` to each slot (from the bots' registry, `damage` from the item NBT through RCON or from the bot's own copy). |
| API | `POST /api/bots/<name>/leave`; `GET/POST /api/sites`, `DELETE /api/sites/<name>`; `GET/POST /api/scripts`, `DELETE /api/scripts/<name>`, `POST /api/scripts/<name>/run {bot}`; `POST /api/settings {retireWorn, scripts, autoKit}`. All behind the session and CSRF like every `/api/*` route (unauthenticated: 401, tested). The bot status carries `tools`, `script`, `inPit`. |

Checks: `tests/test_work_service_pure.js` (settings reach connected bots, tools/durability, sites and scripts persist, Leave pit and its 409s, inventory
durability, sweep jobs keep no road), `tests/test_work_console_pure.js` (the new routes: 401 without a session, 400 with the reason, 404), and
`scripts/work/ui_check.js` (the page under jsdom with a stubbed API: nav entry, settings post, site save, script validate/save, pit form fields,
tool list and Leave pit, job row, durability bar: 18 checks; canvas drawing is not checked; run line in the file header).

### Inv View (mod, 2026-11-06)

The owner added `inv_view-4.2.1-forge+1.20.1.jar` (RazorPlay01, MIT, Forge 1.20.1, no blocks or items; "open and manipulate the inventories and ender
chests of online and offline players") to the play world: copied from the PC with `scp` to `/mnt/data/forgeaip-play/mods/` (sha256
`f16e7ca0ec7aa2b64c35bb5e3b8b0ec3596b6add5b4b2618868661df442daee2`; `mods.toml` read before installing: requires only Forge and Minecraft 1.20.1,
no mixin target outside the game, one access transformer). `check-mods.py` ok, `registry.sh` unchanged (5,238 mod blocks, 0 problems), server
restarted; the log shows `Initializing inv_view on FORGE` and the command `inv_view` registered; the four bots logged in again by themselves.
**The same jar must be in the client's mods folder** (README rule: content mods are the same on both sides; this mod declares no server-only
display test). Use in game as an operator: `/inv_view ...` (the console of the server answers "incomplete command"; the exact arguments were
not read from the jar and are **unverified**: use tab completion). The console's own inventory page keeps working and now shows durability.

## v6 (2026-11-06, `TASK-20261106-040`): the BOT TODO batch (range audit, discard, direct pickup, glow, climbing, defence)

Source: the owner's list `LLM-records/2026-11-06-forge1201-moded-aiplayer-bot-system-todo-...` (six items). RL untouched: nothing here is in
`src/skills` `COMMANDS`, so the action matrix and the spec hash are what every checkpoint was trained on.

| Item | What it does now | Where |
| :-- | :-- | :-- |
| 1-1 range differs from its intended state | `pit.audit` looks at finished units (a rotating slice of 48 per call; the whole range once more before the job may end, up to 3 rounds) and sends every unit with a cell that is not open (leftover block, block placed by mistake, water that ran in) back to pending (`Ledger.reopen`; layers below wait again). Runs every 5 units and right after any failed unit. A unit sent back 3 times is left alone and reported (`gaveUp`): something keeps refilling it, a loop would be worse. Unloaded cells are not judged. Job cancelled and resumed: the units are idempotent, the first claim re-digs what is left | `pit.js audit/wrongCells`, `crew.js reopen`, `worker.js` |
| 1-2 trash loop | `discard.dispose`: (1) the server's `clear <bot> <item> <n>` over RCON (no item entity ever exists), (2) else walk to a dump spot outside every running job's box (+12 margin) and at least 8 blocks from any other bot and toss there, (3) else the plain toss. Option 3 of the note (not picking low-value drops up) is not built: it raises the entity load | `discard.js`, `janitor.js maintain` |
| 2-1 mined blocks into the inventory | KubeJS server script `modpack/kubejs/server_scripts/forgeaip_direct_pickup.js`: item entities that appear within 2 ticks next to a block that a player tagged `aip_direct` broke are given to that player instead of being spawned; the game still breaks the block (tool wear, loot, statistics). The console tags its bots (`tag <name> add aip_direct`) when they come online; switch "Mined blocks into the inventory" on the Automation page (default on, needs RCON and the script on the server) | script, `service.js _tagDirect` |
| 2-2 glow on problem bots | any failed unit, failed script or janitor run, an audit that gave up: the bot gets `glowing` for 120 s (`effect give`, visible through blocks), cleared by its next finished unit; the problem is written to `problems.jsonl` with position, cell, facing, the block it stood in / on / faced, job, region, unit, time. `GET /api/problems`, panel "Problem bots" on the Automation page counts what the problems have in common (reason, stage, facing, block below, y, x/z in chunk, absolute z and cell) | `problems.js`, `service.js _problem` |
| 2-3 Move up | the operator's `move_to` (console only) is `moves.climbTo`: normal `move_to` first; when that finds no way and the target is higher: walk to the standable cell nearest the target's column, dig a solid roof above the head if there is one, rise on a pillar (one block under the feet at a time, the one two below taken away, `pillar`), walk the last stretch, take the last block away from the side. The last block is noted in `env.temp` until it is gone; a worker takes leftovers away before its next unit (`cleanTemp`). Placed and removed as a pair | `moves.js climbTo/cleanTemp` |
| 2-4 defence | `guard.js`: a threat is a hostile mob (type `hostile` or a known name) within 5 blocks (20 for shooters) AFTER the bot lost health within the last 4 s. The running command is stopped (`cancelled`, not charged to the unit, no bad streak), the bot attacks until nothing attacks (at most 8 rounds), eats when hurt and hungry, claims again. A mob in sight that did not hit is ignored. Switch "Defend itself" (default on) | `guard.js`, `worker.js` |

Router and skill policies (DPOD `integrations/botsystem/experts/`): `src/work/escalation.js` builds the request the router answers and reads its
decision, in the closed form DPOD validates (cross-checked on 2026-11-06: a request built here is answered by `escalation.answer`). It is not
wired into any job; no expert exists and nothing is on a learning queue.

### Live check (2026-11-06, the demo server: real Forge 1.20.1 with the play world's mod set, flat world, easy)

`/mnt/data/forgeaip-play/demo` (outside the repo): the same jars as the play world, mounted read-only, own world, RCON and console. Ports are loopback only; the owner reaches them over the tailnet at `100.77.246.23:25570` / `:25571` (game) and `http://100.77.246.23:3022` / `:3023` (console), through `tailscale serve` routes. Since 2026-11-06 (owner decision, broker audit 571) ufw has `allow in on tailscale0`, so the whole tailnet is open by default and a route is optional; before that rule an unrouted tailnet port was dropped silently and looked like a dead server. The demo's OP entry must carry the offline UUID (`op <name>` over RCON; itzg's `OPS=` writes the Mojang UUID, which an offline-mode server never matches). Diagnose with `/mnt/data/forgeaip-play/check-access.sh --pc`.
`scripts/work/todo_live.js` drives the console's own `WorkService` with real bots; grading is the server's. Run: `cd /mnt/data/forgeaip-play/demo && ./live.sh`.

| Check | Result |
| :-- | :-- |
| direct pickup: 6 blocks mined with `collect:false` | +6 cobblestone in the inventory, 0 item entities; control (switch off, inventory full of other items): 3 mined, 3 entities on the ground |
| discard: 30 stacks of junk, bot next to another bot | `clear` freed 14 slots (6 -> 20 free) in 4 operations, 0 item entities, the neighbour received nothing |
| audit: a cobblestone placed into a finished unit of a 16 x 8 x 3 pit run by 2 bots | "1 unit(s) sent back", dug again, 0 blocks left in the volume on the server, 24 of 24 units |
| climb: `move_to` onto a plateau 6 high, no way on foot | arrived on top in 9.9 s, 6 levels, 0 cobblestone left at the foot of the wall |
| defend: a zombie summoned next to a bot that is digging | zombie dead, job finished 18 of 18, 0 stuck units |
| glow: a problem recorded for a bot | `glowing` in its active effects, problem on record with heading and blocks, cleared again |

Found on the way (fixed, in the repo): the first version of the KubeJS script kept a list per player and handed over only the first drop of a
run of blocks (3 of 6); one list of recent breaks, nearest break first, handles every drop. KubeJS cannot create its folders inside a bind
mount owned by root in a rootless container: the demo copies the script through itzg's `/config` with `COPY_CONFIG_DEST=/data`.

Limits: `climbTo` climbs a wall or cliff face (pillar at its foot, step over the top); a target on an isolated tower in the air needs a bridge, which
is not built. The direct-pickup script does not see drops of blocks that vein-miner mods (MineAllSMP, CutAllSMP are in the play world) break
without the break event of a tagged player: untested with them. Mod drops that spawn more than 1.6 blocks from the block are left on the ground.
`clear` needs RCON; without it the dump spot or the plain toss is used. The audit cannot judge cells outside the loaded chunks. Existing mods
for 2-1 were surveyed once on the web: SaltyJoe's AutoPickup (CurseForge, Forge 1.20.1) sends block drops into the inventory; whether it is
server-side only was not confirmed (one search, listing only), and a content mod would have to be on the owner's client too, so the script was
used (KubeJS is already on both).

## v7 (2026-11-06, `TASK-20261106-041`): tagged blocks and links, the in-game display, the in-game browser, a code layout you can find things in

### Code layout (owner: "I cannot tell where things are, so I cannot adjust them")

`src/work/` is grouped by role (`jobs/` what a crew does together, `bot/` what one bot does, `service/` the one object everything goes through, `web/` the HTTP
console, `operator/` forms and inventory pages, `world/` map data, `display/` the in-game display). `service.js` (1,032 lines) is now `service/` with one file per
concern (bots, jobs, workers, structures, operator, commands, inventories, world, diagnostics, library, links, display, views); `console.js` is a 10-line entry
point over `web/{http,server,main}.js` and `web/routes/*.js`; the page is one script per page (`public/work/page_*.js`, `widgets.js`, `ui.js`). `src/work/README.md`
has the file map, a table "I want to change X -> file" and the rules for new code (own file, own test, one job per file). Behaviour was not changed by the move:
`npm test` passed after each step with the old tests (only `require` paths and the script list of the page test changed).

### Tagged blocks and links ("symbolic links" for inventories)

Page **Tags** (API `/api/sites`). A tagged block is a name, coordinates, an optional free **label** ("auto furnace", any text up to 40 characters, Japanese is fine),
functional tags (`tools ore storage junk food blocks`, the upkeep reads them; new: `machine`) and an optional **link** `via`: the name of the container that feeds or
empties it. Like a symbolic link, a link is followed: `deposit` and `withdraw` at the coordinates of a linked machine (or with `site: "<name>"` instead of x y z) run
on the container; the inventory page shows and moves through the container; the answer says which links were followed. Example: an automatic furnace with a hopper and a
chest beside it: tag the chest (`ore`), tag the furnace (`machine`) and link it to the chest; then `withdraw iron_ingot 8` at the furnace takes from the chest.
Rules (tests/test_work_links_pure.js): coordinates are unique per name; a link needs an existing container, not another machine, not itself; loops and chains longer than 4
are refused (like ELOOP); a container that is the target of a link cannot be removed first; a machine is never where the upkeep puts items away. `smelt` and `craft` on a
machine are refused with the reason (they would open the machine's own GUI, which an automatic machine does not offer). Not done: opening the real machine
GUI, chains through several containers per verb, tags for entities. The Commands form has a **tagged** button that fills x y z from a tag.
Live (demo server, real Forge, `scripts/work/display_live.js`): withdraw 8 / deposit 3 / by name 1 through a furnace linked to a chest, graded from the chest's NBT: pass; the
furnace itself was never filled.

### In-game display (real lines, no mod; v22, 2026-11-11, replaces the particles of v7)

Page Automation, panel "In-game display" (switches for all, paths, mining divisions, tags; default all on). The overlay (`display/overlay.js`, shapes in `display/shapes.js`) draws **real lines**:
a line piece is one `block_display` entity (a thin box of a bright, fully lit concrete block, stretched and rotated by its `transformation`; Minecraft 1.19.4+, vanilla, no mod, no
client install), summoned with `execute in <dimension> run summon block_display x.xxx y.yyy z.zzz {...}` (coordinates with a decimal point: whole numbers are moved to the block's centre).
- **movement** (each bot's planned walk, the planner's cells of the `walk` phase, only what is ahead of the bot): a **solid** line of 0.16 blocks in the bot's colour, collinear steps merged into one piece (a straight 40-block walk is one entity), **glowing** (seen through blocks), ending in a 0.6 cube.
- **range** (each pit lane's designated box): a **dashed** outline (1.6 blocks on, 0.9 off, 0.12 thick, glowing) at the rim and at the layer it is digging now, joined by dashed corner posts; a build job as a box.
- **tags**: a column over every tagged block and a dashed line from a machine to its container.
- **Other dimensions** (the owner's report: nothing showed in the Nether or the End): the old viewer filter was "overworld only" and every command ran in the overworld. Now every player (not a bot) is a viewer in whatever dimension they are in, every bot, lane and tag carries its dimension (`displayState()`: `dim`), and a piece is summoned with `execute in` its own dimension and only near a viewer of that dimension (110 blocks), so it stands in loaded chunks.
- **Cost and lifetime:** pieces have stable keys (geometry + colour), so only what is new is summoned and only what is gone (or out of range, or its viewer left) is killed: at most 70 commands per frame (1 s), nothing when the RCON queue is behind. Caps: 420 path, 520 range, 120 tag pieces. Every entity carries the run's epoch tag; the first frame in a dimension and every minute kill the entities of other runs (`tag=!epoch`: a crash leaves none that is loaded), switching the display off, nobody watching and a service stop kill this run's.
- **What changed for the viewer:** an entity has no per-player visibility, so everyone in the dimension sees the lines (the particles were tagged `aip_see` and seen by the operator only). Switch off from the page.
- **Verified:** `tests/test_work_display_pure.js` (quaternion, dashes, runs, keys, frame contents, other dimension, sweep, budget); against the real demo server the generated commands are accepted (`Summoned new Block Display`) in the overworld and the Nether, the entity's Pos is the given coordinate, and its transformation read back has the expected scale (length of the segment) and rotation. A summon in an unloaded chunk succeeds silently and leaves the entity there (found while testing): that is why pieces are drawn only near a viewer. **Not verified:** how it looks in a real client (no client here).
Hook: the action layer's `Ctx.phase` calls `bot.__onPhase` when a bot has one set (only the work service sets it; RL bots never do).

### In-game browser (WebDisplays + MCEF, staged)

Reuse, not a new mod: WebDisplays 2.0.2 (MIT) gives the **minePad** (handheld browser) and screens, MCEF 2.1.6 (LGPL) is the Chromium wrapper it needs. Jars, checksums,
the PC install command and `enable.sh` / `disable.sh` are in `/mnt/data/forgeaip-play/browser/` (README there). Server side tested on the demo server with the play mod set +
both jars: starts healthy, `webdisplays:minepad` exists; its file server (miniserv, TCP 25566 in the container) is switched off by `enable.sh`. **Not enabled in the play
world yet:** the owner was online when this was built, WebDisplays is a content mod (the server restarts and every client needs the two jars first), so `enable.sh`
refuses while a human is online. The page: `#token=<token>` in the address signs in once (the fragment never reaches a server and is removed from the address at once; one
attempt, no retry loop), `#kiosk` (remembered until `#kiosk=0`) switches to larger controls and one column. Checked under jsdom (`scripts/work/ui_fragment_check.js`, 11 ok).
Authentication is unchanged: the same `/api/login`, throttle, session cookie and CSRF; a link with the token is a password and belongs only in the PC's own config.
Not verified: the page inside Chromium-in-Minecraft (no client here), keyboard focus and the game's key capture.

## v8 (2026-11-06 night, `TASK:20261106-042`): owner feedback on v7 (faint particles, web view, tools chest and depot, chat spam, tag item)

**Owner's observed state (read from the running console before anything was restarted):** a pit job (16x16x123, 4 then 8 bots) crawled: 18 of 1,968 units in 12 minutes. Work1
carried nine worn iron pickaxes (15 uses left each) in a nearly full inventory; the tools chest handed out whatever pickaxe came first (`withdraw` by name takes the first
stack, worn or not); a bot holding only worn pickaxes was "waiting for a pickaxe" and every 13 s "had what it waited for" (the watcher's `_canBreak` ignored wear, the worker
did not), then failed `missing_tool` again. Work3/Work4 also failed `unreachable` on one dirt cell, glowing.

| Item | What changed |
| :-- | :-- |
| 1 particles too faint | dust size 3 (was 1), three particles per point with a small spread, lane lines every 1.5 blocks, destination and tag-column tops are `end_rod` marks, redrawn every second, budget 300 per frame (about 150 ms of RCON at the measured 2 ms per command). Not seen in a real client by me: if still too weak the knobs are `DUST_SIZE` in `display/shapes.js` and `budget`/`FRAME_MS` in `display/overlay.js` |
| chat spam | the server tells every operator what a console command did (`[Rcon: Displaying particle ...]`). The overlay's first frame sets `gamerule sendCommandFeedback false` and `logAdminCommands false` (once; `quiet: false` leaves them alone). Side effect: the feedback of everybody's commands ("Gave 1 ...") is hidden too, errors still show; undo with `/gamerule sendCommandFeedback true` |
| 2 web view | new mod `aux_console/` (id `aipconsole`): **F12** opens the console in a full-screen web view (MCEF/Chromium, structure of MCEF's own example screen), Esc or F12 closes; the `url`/`token`/`kiosk` come from `config/aipconsole-client.toml`. WebDisplays/minePad dropped (its jar is moved to `mods-disabled` on the PC, never was on the play server) |
| 3 tools chest, depot, usable tools | (a) tools chest: tag `tools` on the Tags page, or the Pits form's "the depot chest is also the tools chest"; (b) `take_tool` now calls the work move `take_usable` (`bot/moves.js`): opens the chest, takes ONE tool of the class that is not worn out (8 uses or 6 % left, independent of the switch), best tier first then most uses left, by shift-clicking that slot; a chest with only worn ones gives nothing and the log says "no usable pickaxe in the tools chest (N worn out)"; (c) worn-out tools are used up: setting "Use up tools and throw them away" (default on): the janitor throws each worn stack away through the server with `clear <bot> <item>{Damage:N} 1`, so a good tool of the same name stays; (d) the watcher no longer counts a worn pickaxe as "has what it waited for"; (e) the depot's rank: Pits form "Depot takes" (store everything / 10+ no stone, dirt, gravel, sand / 40+ ores, coal, wood / 60+ valuable only): items worth less are thrown away instead of stored (never one valued 60 or more, never when the operator tagged a chest for exactly that kind, e.g. a junk chest) |
| 4 pit check | see "Pit observed" below |
| 5 tag item | `aipconsole:tag_tool` (`/give @s aipconsole:tag_tool`): right-click = what and where; **shift + right-click** opens the web view on the Tags page with the block's coordinates filled in (`#goto=tags&x&y&z`; an already tagged block opens for editing). It changes nothing in the world and runs before the block's own use. A native form was not built: the page already has the form, authentication and validation, and a second one would have to talk to the console from the game server (a credential in the game container) |

Tests: `tests/test_work_tools_pure.js` (11 tests: worn rule, `pickUsable`, the script, janitor, `makeClear` with damage, depot rank incl. the 60 cap and the junk-chest exception, `_canBreak`,
depot rank in the job policy, the quiet rules). Live on the demo server (real Forge, play mod set + `aipconsole`): `scripts/work/tools_live.js` 10/10: replace-tool took the good iron
pickaxe (230 uses left) over a stone one and two worn ones, a chest with only worn pickaxes gave nothing, three worn stacks of four were discarded by wear and the good one stayed, no item
entity, rules off, the Tag Tool item exists. The mod compiled against the real MCEF jar (build in `aux_console/README.md`) and loads on a Forge 1.20.1 dedicated server; NOT tested:
the web view and the key in a real client (none here), the tag item's screen flow.

### Stuck bots in a pit above the ground (2026-11-07, owner: "nothing moves, they stop in an empty spot, glow, no error in the WebUI")

Cause, read from the running job (j16: top y 90 over ground at y 64-68, a tree inside the box): every sweep unit walked to the station in the middle of its tile, also when the tile held
only air and tree blocks 10-20 above the ground. A station in mid air has no standing cell; the planner (20,000 cells, 30-85 s, six tries per unit) takes the nearest reachable one,
and that was the canopy: bots climbed onto the leaves, two stood in the same place, glowed, and the page showed nothing. Progress was 122 of 2,400 units in 12 minutes.
Fixes (`jobs/pit.js`): `aerialTree` (a leaf, log or vine more than 6 above the ground below is not tried and not counted by the audit), a unit with nothing left to dig finishes at once
without walking, a station without a floor within 3 cells below is not chased, failures carry the block's name. Bots table: the activity column now shows the action layer's phase and
its age ("walk 14 s", "plan 14 s") and the last problem ("unreachable 248 80 446, 50 s ago"), so a bot that searches or glows says why (`service/bots.js`, `widgets.js`).
After the fix, same area, four bots: 393 of 2,400 units after 90 s, bots at ground level digging, 0 problems (before: 187, stuck in the canopy). Job reset by the owner's word.
Not done: tall terrain features other than trees (a floating block of stone would still be tried); the box top should be set at the ground, "Top = ground" does that.

## v9 (2026-11-07, `TASK:20261106-042` second half): the owner's batch of seven, and what the live pit taught

Owner's batch (all done, live on the play console): (1) help only after the own range is dug to the bottom (`jobs/crew.js`: `stayHome`, `lanes`), lanes independent (no lock-step, `maxLead` off: a fast lane used to wait for the slowest);
(2) retries after 1, 1, 2, 2, 3, 5 s (were 3-30), cool-down 5 s, repair every 3 s; (3) nothing is retired for good any more (no Resume button needed), a unit gets 10 attempts and an unreachable cell is retried once;
(4) resupply from mined items: `replace-tool` v2 (script grammar gained `gather`, `make_planks`, `station: furnace`, `furnace`, `go_back`, conditions `planks`, `logs`, `in_pit`, `usable`): tools chest first, then iron (smelt raw iron in a furnace placed beside the bot) or stone pickaxe, sticks from planks from logs (trees only outside the pit);
`stock-tools` at job start (three usable pickaxes, 12 sticks); (5) the pillar: overhead blocks are broken first, bare hands or a worn tool break the lower block (so the same routine runs without a pickaxe), dirt first when no pickaxe is usable;
(6) the tools chest: a far chest is reached by leaving the pit and the bot is put back by `tp` (`go_back`); `take_usable` never takes a worn tool; (7) monitoring: a watcher on `/api/state` for 6 hours, fixes below.

What the live pit (16x16, y 90 to -59, ground y 64, an old bigger hole beside it) taught, each fixed and deployed (tests in `tests/test_work_tools_pure.js`, `test_work_pure.js`, `test_work_moves_sim.js`):
- bots in the canopy (tree blocks 10-20 above the ground are not tried; units with nothing to dig finish without walking);
- `leavePit` looked for ground at the box top (y 90) and, later, took the first standable cell from the top of a column (the floor of a hole at y -59): now the highest standable cell within six columns, and a climb over eight levels is a lift;
- four bots stood under an undug slab / on their own floating pillar blocks, 5-26 levels from their units, and failed `unreachable` for ten minutes: a station three or more levels away that cannot be walked to is reached by `env.lift` (server `tp` to a standable cell at that layer; position only), the pillar is the fallback;
- two bots in one cell blocked each other's pillar (`not_confirmed`): `env.stepAside` and `env.crowded`;
- the tools chest handed out worn tools, a worn pickaxe ended the wait for a pickaxe, worn tools are thrown away by exact stack (`clear` with `{Damage:N}`);
- drowning mid-dig (the water check ran only between units): a unit is cancelled when the bot is in water with air below 9, and the water rescue falls back to a lift when swimming out fails;
- bot freezing: not the event loop (tick gaps of one bot were 1.5 s while the others' were 1-50 ms): the path search now runs in slices (`planAsync`) and is capped at 6,000 cells for work bots; the lock-step between lanes was the real reason for "the others wait".
Diagnostics added: the Bots table shows phase and last problem, script logs are complete, `event loop blocked` and `no physics tick` warnings name the bots involved.
Known limits: the ledger restarts from layer 0 at every console restart (units are idempotent, idle ones take milliseconds); `tp` is used for lift and go_back (a server-side position change, no blocks); leftover cells beside open air that no standable cell reaches stay `stuck` until a repair pass finds them reachable.

## v10 (2026-11-09, `TASK:20261109-043`): the owner's notes of 2026-11-08 (design notes + evening addendum), BOT side only

Sources: `LLM-records/2026-11-08-forge1201-moded-aiplayer-addendum-2026-11-08-evening-...` and `...-design-notes-2026-11-08-dpod-split-moe-router-bot` (the RL/MoE part is untouched).
Where two notes disagree the newer wins. Every item has a test file and, where the game decides, a live check on the demo server (`scripts/work/*_live.js`, graded on the server's state).

| What | Result | Where |
| :-- | :-- | :-- |
| B3 tag purposes | One closed list per block, chosen from a pulldown: `tools` (bots take tools), `ore`, `trash` (was junk), `food`, `blocks`, `any` (anything may be put in; was storage), `free` (contents may be used freely, nothing is put in), `furnace` (was machine, linked by `via`), `portal`, `other`. Old names work as aliases; a stored block with several old tags keeps the most specific one and is listed in `migrated` on the Tags page. `placeFor` fills only ore/trash/food/blocks/any. | `bot/sites.js`, `page_tags.js`, `tests/test_work_ender_pure.js` |
| B2 Ender Storage | Facts read from the mod (class constants, a live world): frequency = three wool colours + optional owner; items live in the world's `EnderStorage/data1.dat`/`data2.dat` under `left=blue,middle=white,right=white[,owner=<uuid>],type=item`; breaking the chest returns the item with its colours (the item keeps `Frequency` at top level, not in `BlockEntityTag`). **A tagged chest has `ender: {left,middle,right,owner?}`**; the Tags page lists every saved frequency, what is inside and which tagged chests use it with their purpose (GET `/api/enderstorage`, read-only on `WORK_WORLD`). | `world/enderstorage.js`, `service/ender.js` |
| Ender Storage: opening it | CodeChickenLib opens the screen over `ccl:internal` (`0a menuType windowId title extra`), never `open_window`, so Mineflayer saw nothing. `transport/forge_windows.js` raises an `open_window` of the right size when the window items arrive; `deposit`/`withdraw`/`take_usable`/`stash_worn` open mod chests with `openBlock`. Live: deposit 30, withdraw 12, world file agrees; light_blue/light_gray/black key names confirmed. | `transport/forge_windows.js`, `skills/commands/gui.js` |
| Owner rule: fixtures | A chest, trapped chest, barrel, ender chest, Ender Storage chest or shulker box that **no bot placed** (and any tagged block) is never broken: `mine` answers `protected` (new reason), a pit treats the cell as skipped. The bot may use what is inside. A box a bot placed from its pack is remembered (`bot.__placed`, shared set in `WorkService.placed`, kept in `state.json`) and picked up again with up to three retries (the shulker depot). | `skills/fixtures.js`, `skills/commands/block.js`, `bot/janitor.js` |
| A1 no useless climb | `replace-tool` skips the trip to the tools chest when the pack already holds a pickaxe's materials (3 iron ingots or 3 raw iron + fuel, or 3 cobblestone, and 2 sticks): it is crafted below. | `bot/script.js` (`CRAFTABLE_BELOW`) |
| A2 stations | A furnace/table is taken back into the pack after use (`release_station` takes both); one that cannot be taken back is remembered (`bot.__stations`) and used again by the next run if still there and within 12 blocks. | `bot/script.js` |
| A3 varied escapes | The same failure in the same 3x3x3 area is answered with a different fix each time: jump, sidestep (a direction not used yet), back to the last good place, step back, wait 1.5-3.5 s, server lift. First failures behave as before. | `bot/escape.js`, `bot/env.js` |
| A4 map | Cause: `Tiles.get` replaced a region whose file had changed by an empty entry, so it was drawn black until the reload arrived (the bot's own chunk is rewritten at every save); the region list was read once; torn reads of a file being saved lost chunks. Fixed: old picture kept, list polled every 15 s, last complete decode kept, optional `mapSave` (the service sends `save-all` every 30-300 s; off by default). | `public/work/map.js`, `world/maps.js` |
| A5 F12 | One MCEF browser is kept while the player is in the world; F12/Esc only hide it, leaving the world or a changed address closes it. Built (BUILD SUCCESSFUL) and installed on the PC (old jar kept as `.bak-20261109` next to the mods folder) and on the play server (identical jar). **Not tested in a real client.** | `aux_console/` |
| B1 long walks | Cause (live, flat demo world): `move_to` needs the target's chunk (work bots: view distance 4 = 56 blocks) and the planner stops after 6,000 nodes, so a far target is out of sight, not unreachable. `bot/travel.js` walks in legs of 40 blocks inside the loaded area (shorter and to either side when a leg fails; stuck after three useless legs). Live: 303 blocks in 8 legs, 59 s, and back. | `bot/travel.js`, command `journey` |
| B1 dimensions | Portals are tagged blocks (`portal`, `dim`, `twin`); a `journey` to a target in another dimension walks to the nearest gate that leads there, walks into it (`bot/portal.js`: steps out of an exit portal first, then forward until the server changes the dimension), and goes on. `viaNether` shortens a long overworld walk through gates on both sides when clearly shorter (experimental, only planned and unit-tested; the live check is overworld-nether-overworld through one pair). The planner still treats portal blocks as danger. | `bot/route.js`, `bot/portal.js`, `service/commands.js` |
| 3.1 tool durability | Per material: `use_up` (never counts as worn, used until it breaks) or `keep` (stopped at the reserve and **stashed** in the chest that takes things, never thrown away). Default: wooden, stone, iron, gold use up; diamond, netherite keep. Master switch `retireWorn` as before; RL bots have no policy. | `skills/options.js`, `bot/janitor.js`, `bot/moves.js` (`stash_worn`), Automation page |
| 3.2 routine bot | `POST /api/scripts/<name>/run {bot, repeat:true}` runs a script over and over until Stop (pause 2 s, doubling to 16x after failures; five failed rounds in a row end it). Script steps may name a tagged block (`"at": "nugget-chest"`). Live: 162 nuggets -> 2 iron blocks in the chest in 24 s, then it waits without failing, Stop ends it. | `bot/script.js` (`runLoop`), `service/library.js` |
| 3.3 reflexes | One watcher per bot (physics tick). Fall of >= 5 blocks: water bucket put down just before landing and taken up again, else a block into the cell a few below the feet against the wall; lava: fire resistance potion, else walk out. The running command is stopped (`bot.__preempt`), the worker waits and runs the unit again. Live: 40-block fall 20 -> 20 hp (control: dead), 21-block wall fall 3 damage instead of 18, lava pool with a potion 20 -> 20 and out. Setting `reflex`. | `bot/reflex.js` |
| 3.4 "teleporting" | Cause (read from the code, then reproduced): not lag. The recovery code moves a stuck bot with the server's `tp` (`env.lift`, `env.back`: a standable cell near the target or the last good place) and nothing said so. Now every such move is in the log and in the bot's row ("moved by the server N blocks (why)"); moves made to get out of trouble (`purpose: recover`) follow the setting `teleport`: `near` (default: 16 across, 6 up/down), `off`, `any`; moves a job needs (another layer, out of the pit) are not limited. | `bot/env.js`, `service/bots.js` |

Deployed 2026-11-09: console on the play world restarted twice (jobs come back paused; the running pit `j26` was started again), `state.json` backed up
(`.bak-20261109-purposes`, `.bak-20261109b`), the new settings default as above. **Not verified:** the F12 web view and the Tags/Map pages in a real browser (jsdom only), `viaNether`
live, the lava walk-out without a potion, edge-slip block placement on a real cliff edge in a running job, the carried (item) Ender Storage chest as a depot kind (an Ender Storage chest
is used where it stands, or placed by a script and taken back), the end dimension.

### v10 follow-up (2026-11-09 night, owner's first play test)

| Report | Cause | Fix |
| :-- | :-- | :-- |
| F12 view: dropdowns stay open, white blocks | the embedded browser draws no native pop-ups: the list of a `<select>` and the suggestions of `<input list>` are separate windows it never shows | `public/work/kiosk.js` (kiosk layout only): a `<select>` opens the page's own `choose()` box, suggestion lists are left out; modals scroll (`max-height 92vh`). **Not seen in a real client**; other white areas, if any, are not explained. |
| Remove does nothing | the browser's `confirm()` shows no dialog in the web view (and was never answered) | `ask()` in `ui.js`: a yes/no box of the page, used by every Remove / Delete / Cancel (bots, tags, jobs, scripts, structures). jsdom check: no `confirm()` call, No deletes nothing, Yes sends the DELETE. |
| 20 bots, nobody can join | `MAX_PLAYERS: "20"` of the play world | 100 in `/mnt/data/forgeaip-play/compose.yaml` (needs a restart: done with `up.sh --force`, the known mcef false positive of `check-mods.py`) |
| The tagged Ender Chest does not respond | the `tools` tag pointed at 1746 107 1781, where there is no block entity; the two chests stand at 1743 103 1774 (white/white/white) and 1743 103 1775 (blue/white/white). A tag does not move with a chest, and the page could not say so. | the tag is corrected (1743 103 1775); a container tag on a cell a bot sees as air is refused, and a tag whose cell is air shows `⚠ air` in the table. The Inventory page no longer shows an Ender Storage chest as empty: it reads the saved storage (read-only, colours in the note) and refuses to move stacks through the console (the server console cannot reach those items). Live: the tagged chest as tools chest works (`replace-tool` took the diamond pickaxe, left the worn one). |
| The Ender Chest in the inventory does not work | nothing used it: depots were a chest or a shulker box, and the upkeep treated `enderstorage:ender_chest` as ordinary surplus | depot kind "Ender Storage chest (carried, placed by the bot)" (`depot.item: enderstorage:ender_chest`): placed beside the bot, filled, taken back with its colours; it and the pouch/tank are never put away or thrown away. Live: a lime/lime/lime chest used and picked up again, none left standing. A vanilla ender chest cannot be a depot (without Silk Touch it drops obsidian). |

## v11 (2026-11-09, `TASK:20261109-045`): the freeze, a watchdog, and "no Resume button needed" made true

**What happened.** At 02:27 JST every bot was dropped by the server ("Timed out") a few seconds after Work5 fell to its death and a Resume was sent. The console process
was not dead: it ran at 140 % CPU for 100 minutes and answered nothing. Found with the Node inspector on the frozen process (`kill -USR1 1` in the container, then
`Debugger.pause` / `Profiler` from a second container in the same network namespace): the stack was `runWorker -> job.rescue -> water.rescue -> floodPlan`, the worker
of Work11 had `failed = 99,639`, `cancel.cancelled = false`, `env.unitCancel.cancelled = true`.

**Cause.** `unitCancel` (env.js) is the operator's cancel OR a guard interrupt OR `drowning()` (air < 9 in water). The water rescue, which is what a drowning bot is sent to,
ran its swim and its fills through the same token, so every command came back `cancelled` at once. The worker read `cancelled` without an operator cancel as "attacked:
defend, then claim again", with no wait and no I/O. A loop of microtasks only never lets timers or sockets run, so the keep-alives of all 20 bots (one process) stopped.

**Fixes** (tests: `tests/test_work_freeze_pure.js`, in `npm test`; the worker test hangs on the old code):
- `env.execFree` (operator cancel only) is what `water.rescue` uses.
- `worker.js`: a `cancelled` with nothing to fight (`defend().fought == 0`) is a failure like any other (fix, wait, streak, cool-down); a failed unit yields with `setImmediate`.
- `service/watchdog.js`: a second thread watches a heartbeat of the main thread. After 25 s of silence (`WORK_WATCHDOG_S`, 0 = off) it asks the main thread for its stack through
  the inspector, writes `freeze.json` (time, count, stack) and kills the process; the container's restart policy brings it back. Three freezes in an hour: jobs come back paused.
- `restore()`: a job that was running comes back running (setting `resumeJobs`, default on), and the bots work as soon as they are online (before: "jobs are paused: press Start").
- `_watchResume()` (every 2 s): a bot that is online, belongs to a running job and does nothing (no worker, script or operator command) is started again after 6 s, doubling to 2 min;
  one that waits for an item or tool the operator must give looks again every 5 minutes. Before, only some endings restarted themselves; `stalled`, `error`, a failed restock or a throwing
  start left the bot idle until somebody pressed Resume.
- `rec.missing` accepted `String(undefined)`: Work5 "waited for undefined" four times, for good. It now needs a string.

**Not fixed, seen on the way.** The ledger can deadlock two lane bots on one region when the first bot finishes a unit before the second claims (tests/test_work_miner_pure.js shows it with
a yield at the top of the worker loop; never seen live). Work20 and Work9 fail on units far from where they stand with `target chunk not loaded` and cool down in a loop (hundreds of
problem rows). The console uses 1.6 of its 2 GiB with 20 bots.

## v12 (2026-11-09, `TASK:20261109-047`): containers first, the dump at the end of a job, the final sweep, tools by rule

The owner's four BOT-side points of 2026-11-09 (`tests/test_work_fixes_pure.js`, 19 checks; `npm test` 270 checks). Causes read from the live play console
(`state.json`, `problems.jsonl`, the container log of job j27, a 32 x 160 x 200 pit) before anything was changed.

| # | Owner point | Cause found | What was built | Where |
| :-- | :-- | :-- | :-- | :-- |
| 1 | Storage (tagged Ender Storage too) is not used; look there FIRST when something is missing; a standing container only within 10 chunks | The two tagged Ender chests (`any` white/white/white, `tools` blue/white/white) stand on the pit floor, y -59. Bots 60-90 levels above failed `take ... unreachable` (the `take` step never changed layer; `take_tool` skipped a chest more than 12 levels away) and `janitor_failed reach block` (38 rows): every deposit failed, so nothing reached the chest. The white/white/white chest was empty (0 of 27 slots, read from the saved world). A second cause, found after the first deploy: `deposit` / `withdraw` took their item as the plain `name` type, which refuses `create:limestone` ("not a valid name", 25+ `janitor_failed` rows), and one refused item ended the whole deposit run, so everything valued above it (the ores) stayed in the pack. The upkeep also deposits only when fewer than 6 slots are free (`janitor.plan`), which is by design and stays. A `missing_item` was never fetched from a container, only waited for | `Sites.reachable`: a container (tools, ore, trash, food, blocks, any, free) is usable only within `sites.reach` = 160 blocks (10 chunks) of the bot, in the bot's dimension, measured to the container a link points to; portals and machines are not filtered. `Sites.sources`: every usable container, **Ender Storage first**, then the asked purpose, then the rest, nearest first (rubbish and food chests only when asked). The script steps `take` and `take_tool` walk that list (at most 6 / 4 chests, a chest that lacked the item is not opened twice in a run). `reach.approach`: a chest in another layer or beyond a `move_to`'s sight is gone to (walk in legs, then the server lift `purpose: job`); the janitor's deposit does it too; when the walk fails (inside a deep pit there is often no surface) the server lift follows. `deposit` / `withdraw` take namespaced item ids (type `item`, as `place` does), and an item the action layer refuses is skipped, not the end of the run. A `missing_item` runs `fetchScript` (the item, or the first acceptable of `detail.tried`) before the bot waits | `bot/sites.js`, `bot/reach.js`, `bot/script.js`, `bot/janitor.js`, `bot/env.js` (`pos` carries the dimension) |
| 2 | At the end of a finished pit or build, put everything except tools and Ender storage into the tagged storage; switch; white/white/white for now | none (new) | `_endDump` (service) after the last worker of a job ends and the repair passes are over: every bot of the crew, three at a time: leave the pit, go to the Ender chest of `settings.endDumpEnder`, deposit most valuable first (27 slots: diamonds before cobblestone), what does not fit goes to the next container that takes items (`Sites.storesFor`), what fits nowhere stays in the pack (nothing is thrown away). Tools, armour, buckets and containers (Ender Storage, shulker boxes, chests) stay with the bot. Not after Move or other commands, not after a cancel. Switch `settings.endDump` (default on, page "Empty the pack when a job is finished"); colours `settings.endDumpEnder` (white/white/white, public chests only) | `bot/enddump.js`, `service/workers.js`, `service/world.js` |
| 3 | Unmined blocks left in the pit (interrupted heights, water); check the assigned chunks from the top once the bottom is reached and order what remains | `pit.audit` judges a cell only when the bot's world model has it, and a bot knows only the chunks within view distance 4; with many chunks the one bot that ran the last check saw most of the pit as `unknown`, and unknown cells are skipped, not failed. Also the check looked at finished units only and gave up after 3 reopenings | `pit_sweep.js`: when the ledger is finished a bot takes the nearest chunk nobody is looking at, walks toward it until it is loaded (`env.travel`), reads every finished unit from the top layer down (`pit.cellState`: wrong cells and unknown cells) and sends each unit that still holds a block back (`ledger.reopen`: the layers below wait; the same bots dig it); the chunk is looked at again after the repair (5 rounds, 5 reopenings per unit, then reported as `gaveUp`). The job is not finished while a chunk is being looked at. The old events (`audit`) are still sent, so the log, the problem list and the glow work as before | `jobs/pit_sweep.js`, `jobs/pit.js` (`cellState`, `createPitJob().sweep`), `bot/worker.js` |
| 4 | "waiting for a sword or shears (to break cobweb)" all day; make axes, shovels (and the existing pickaxe) by rule | `missing_tool` always ran `replace-tool`, which makes a pickaxe, and its first test is "has any usable pickaxe": with a pickaxe in the pack it ended `ok` at once without a sword, ten times, then the bot waited | `replaceScript(class)` generates `replace-tool` (pickaxe, step for step the old script: checked equal), `replace-sword` (2 material, 1 stick), `replace-axe` (3, 2), `replace-shovel` (1, 2): containers first, then iron (or raw iron smelted), then stone, then wood. `craftClassFor(registry, block)` picks the class from the block's harvest tools (cobweb: sword; shears cannot be made: the bot waits for one); the worker handler and the 15-second retry while waiting use it. `stock-tools` also takes one sword, axe and shovel from a container when there is one | `bot/script.js`, `service/workers.js` (`_toolScript`), `bot/worker.js` (a handler may be a function of the failed result) |

Not verified live: the lift to a chest on the pit floor and back (pure tests and the code path only), the Ender chest filling up with a real 27-slot limit
(deposit of more than fits is assumed to return `not_confirmed`, and the rest goes to the next container), the final sweep on a pit of ten chunks (the walk to a far
chunk inside a deep pit uses `travel`, whose legs are limited to 24 levels), a cobweb in a real pit. The owner's remaining "stuck near the target / at the target but not moving"
cases are not explained by this batch.

## Security basis (the console can reach RCON and control bots, so it is an administrative interface)

- Not an extension of the old unauthenticated WebUI (docs/LESSONS.md L3), which stays on loopback and unchanged.
- **No access token by default (v17, owner 2026-11-10).** Who may reach the console is decided by the network: loopback and the tailnet, or the public name behind Cloudflare Access (a valid assertion for an allowed e-mail). `GET /api/session` issues the session (HttpOnly `SameSite=Strict`, 12 h) and the CSRF value. A request that came through a proxy (headers `Cf-Ray`, `Cf-Connecting-Ip`, `X-Forwarded-For`, `X-Forwarded-Host`, `Forwarded`, `Cf-Access-Jwt-Assertion`) and has no valid Access assertion is refused with 403, whatever the Host header says, so a tunnel mistake cannot open the console. With `WORK_REQUIRE_TOKEN=1` the old token (`console-data/console.token`, mode 0600, `POST /api/login`, throttled 8 per address per 10 min) is required again.
- Every API route needs the session; every non-GET also the `X-CSRF` header and, when a browser sends `Origin`, the same host; JSON only
  (`text/plain` and form posts are refused, 415); bodies limited (256 KB JSON, 8 MB upload, drained not buffered); the `Host` header must be
  `localhost`, an IP literal or `*.ts.net` (DNS rebinding); strict CSP (`default-src 'none'; script-src 'self'`), no inline script, no
  `innerHTML` in the page; routes and names are closed (`[a-z0-9_-]{1,48}` structures, `[A-Za-z0-9_]{3,16}` bots); every value that
  reaches RCON is a validated token (names, item ids, integers). The structure reader checks sizes, palette indexes and positions.
- Reachability: container port published on `127.0.0.1:3020` only (checked with `ss -ltn`); the owner reaches it over the existing tailnet
  route `3021 -> 3020` (`tailscale serve`, tailnet only, no public listener). Unauthenticated requests: `/api/*` 401, wrong `Host` 421
  (curl, 2026-11-05). `npm audit --omit=dev`: see STATE.yaml. Recorded in the knowledge-DB.
- Offline-mode bots: who may log in as a bot is decided by the network (loopback + tailnet), as for every server of this repo.

## Use

On the VPS (as `coder`; everything is in `/mnt/data/forgeaip-play/`, outside this repository):

```bash
./registry.sh        # after ANY change of mods/: rebuilds registry.json (about 1 min), then restart the server and the console
./console-up.sh      # starts / rebuilds the console (needs the play world healthy and registry.json)
./console-down.sh    # stops it (bots log out, state is kept)
```

From the PC: open `http://100.77.246.23:3021` (Tailscale connected); no token (since v17). If the tailnet route is missing, or the PC cannot reach it: an SSH
tunnel `ssh -L 3020:127.0.0.1:3020 vps` and `http://127.0.0.1:3020`.

A first session: **Bots** → Add bots → batch of 4; **Pits** → drag over the map to select chunks, Top = ground, depth 3 →
Create and start; **Structures** → upload or generate a house, rotate, **Build** → origin = player, y = ground → Create and start (Give
materials first if the bots hold nothing). Auto-kit (Bots) tops up pickaxes before every start.

## Limits seen, and what is not done

- Block *properties* are not reproduced by the bots (stairs, slabs, logs, doors come out as a click places them); the editor keeps them in
  the file and the diff compares names only. Next: property-aware placing (click height for slabs and stairs, face for logs).
- The pit does not remove its haul road; no drop sweep; lava lakes and caves below the floor are not planned for (WORKERS-v1 "Tasks that follow").
- A bot that fails three units in a row retires with the reason (`missing_tool`, `missing_item oak_planks`, `stuck`) and the job goes on with the others; with auto-kit (a setting of the service, off by default, not in the UI since v2) it is restocked and continues (at most 5 times in a row), otherwise **Give materials** (build jobs) and **Resume**. A job whose bots are all retired shows `blocked`.
- The console is one process: a crash or container restart logs every bot out, the roster returns, jobs come back paused.
- DH on the server is untested for load beyond a login; if the server's tick time rises with players moving, remove the jar and restart.
- Not done: ender-chest depots, ledger persistence beyond the job definition, a Rust coordinator (not on any critical path, WORKERS-v1 part 4).

## Live check (2026-11-05, disposable copy of the build world with Create, console in its own container)

Server: Forge 1.20.1 + Create, survival, a stone slab high in the sky as the arena; three bots (`Dig1..3`) added **through the console API**
(`scripts/work`-style driver in the session scratchpad, not kept), kit by RCON; graded from the server and from the bots' own world diff.

| Job | Result |
| :-- | :-- |
| Pit 16 × 16 × 3 (768 cells, 3 bots) | 48 of 48 rows done, 0 stuck, 376-390 s (two runs); server count of stone left in the volume: 6 = exactly the haul road (cells keep 3 + 2 + 1 blocks) |
| House 7 × 7 × 4 from the library (194 blocks, 2 bots), first run | **found two defects** (below): both bots retired after three failed units each (one `missing_item`, one `stuck` on a roof cell) and the job sat at "running" with nobody working |
| House, after the fixes | 384 of 384 rows, 0 stuck, **diff against the world 0**, 102 s, roof built with a scaffold, one automatic restock (`oak_planks x128`) |
| Create cogwheel box 2 × 1 × 2 (namespaced `create:cogwheel`, 1 bot) | 16 of 16 rows, diff 0, both probed cells verified on the server (`execute if block ... create:cogwheel`); one automatic restock |

Defects found and fixed in this run (each has a pure reproducer in `npm test`):
1. A scaffold was only tried on `unreachable` / `not_visible`; a roof cell inside the walls answers `stuck` with goal `reach placement face`
   (`tests/test_work_pure.js`, "failed walk to the placement face"). Other `stuck` reasons (the bot's body) still do not scaffold.
2. The scaffold's cobblestone competes with the structure's blocks, and an even split of materials runs one bot dry. `Give materials` now adds
   the scaffold margin per bot, and with auto-kit a bot that runs out of an item gets exactly that item (two stacks) and goes on. Without
   auto-kit it retires **with the item named**, the job shows `blocked: no bot is working: Dig1 retired: missing_item oak_planks`, and the
   **Resume** button (or `POST /api/bots/<name>/resume`) puts it back (`tests/test_work_service_pure.js`).
3. The structure reader failed in any process that had created a bot (docs/LESSONS.md L19): found by the first live upload.

Also checked on the real play world: a bot added through the console logs in with the 5,238-mod-block table, `players` and `surface` answer,
the roster comes back after a console restart (the bot logged in again by itself), unauthenticated `/api/*` is 401 on `127.0.0.1:3020` and on
the tailnet route `100.77.246.23:3021`, a foreign `Host` is 421, no listener beyond loopback and the tailnet. The UI was exercised under jsdom
(login, bot add and batch, structure generate / select / edit / save, pit form with RCON position, build form, validation toast): 15 checks, no
page errors. A real browser was not available here: the canvas drawing (map, layer view) is **unverified visually**.

Not measured: more than 3-4 bots live, the server tick time under the crew, the play world's own terrain (the live runs used a sky arena on a
disposable copy, never the owner's world), property-aware placing (not built). `npm audit --omit=dev`: 8 moderate, all `uuid < 11.1.1`
through `yggdrasil` / `mineflayer-tool` (existing TASK-20261030-004; the console does not call uuid with a buffer argument and bots log in offline).

## v13 (2026-11-09, `TASK:20261109-048`): lines at beds and chests, `set_spawn`, the Place page, climbing without blocks, a map that fits the in-game view

The owner's four points of 2026-11-09 (`tests/test_work_queue_pure.js`, 8 checks, plus one pillar case in `tests/test_work_moves_sim.js`; `npm test` 37 files, all green).

| # | Owner point | Cause found | What was built | Where |
| :-- | :-- | :-- | :-- | :-- |
| 1 | A command that sets the respawn point (sleep in a bed or touch it); bots sent together crowded one block and the first slept until morning; line them up by name and use the same line at chests; a timeout so one bad bot does not hold the rest; a bot that fails is sent away | The old `sleep` action (legacy actuator) used one shared lock file; the work layer had no bed command, and every container use started at once for every bot | `set_spawn {x?, y?, z?}` (Operator group): the nearest bed, or the given one; bots start in natural name order (Work2 before Work10) and queue at the bed in a FIFO line (`bot/queue.js`, one line per bed, both halves one key). One bot at a time walks next to the bed, touches it (the server sets the respawn point at the touch, day or night; at night the bot lies down and wakes after 300 ms), and the server's stored spawn is read back over RCON (`data get entity <bot> SpawnX/Y/Z`, either half of the bed). The same line guards every container: `env.exec`/`execFree` for `deposit`/`withdraw`, `env.run` for `take_usable`/`stash_worn`, and `reach.approach` takes the turn BEFORE the walk or lift (`env.reserve`, given back by `release` when the walk fails). The front place runs out after 60 s (the command under it is cancelled through the ticket, the bot gets `timeout`, stage `queue`); a waiter gives up after 3 min (beds: 15 min); a bot that fails there (`timeout`, `stuck`, `unreachable`, `not_confirmed`, `not_visible`) is sent 5-9 blocks away (`env.sendAway`). The place in line shows in the activity column ("in line 3/20") | `bot/queue.js`, `bot/bed.js`, `bot/env.js` (`queued`), `bot/reach.js`, `service/commands.js` (`_setSpawn`), `operator/catalog.js` |
| 2 | A simple block placement, like Pit, one block type as a floor or a wall; walls are hard to picture | none (new) | The **Place** page: Floor (one layer over the dragged rectangle), Wall (drag along the line; it follows the longer direction, start and end are marked on the map), Room walls (the four walls around the rectangle). It says in words what it will make, draws the footprint on the map, and shows a side view of a wall with the x or z numbers at both ends and the ground line. `POST /api/layout/preview` (validation and the sentence), `POST /api/jobs/layout` makes an ordinary build job (the cells are a blueprint), so bots, materials, scaffold and repair are the build job's | `jobs/layout.js` (pure), `service/jobs.js` (`createLayout`, `previewLayout`, `_buildFrom`), `public/work/page_place.js` |
| 3 | Errors for want of blocks to climb with; in a mine take a block from the undug part; being teleported anyway, teleport back instead of stopping for good | `pillar` ended `missing_item` ("no low-value block to stack") when the pack had none; the worker then waited for the operator (`waiting for cobblestone`) wherever it stood | In a pit job `env.within` is the pit's box. A pillar with nothing to stack digs ONE stackable block (drop in the pillar's list: cobblestone, deepslate, dirt ...; never sand or gravel) beside the bot or over its head, inside the box only, never next to a fluid (`moves.harvestBlock`, up to 6 tries). A bot that gives up (needs an item or a tool, or 12 failures in a row) is put back on its feet first: `env.goBack` = server move to the last good place, else a lift where it stands, purpose `job` (always allowed, whatever the `teleport` setting says; owner: they are moved anyway) | `bot/moves.js`, `bot/env.js` (`within`, `goBack`), `bot/worker.js` (`bringBack`), `service/workers.js` |
| 4 | The map of Pit and others is too large in the F12 view: the boxes at the bottom are hard to see | `.tall-map` was `100vh - 230px` (at least 380 px) and the kiosk layout is one column, so the form lay below a map as tall as the window | One column (under 1100 px) and the kiosk: the map is 34-38 % of the window height (180-420 px) | `public/work/work.css` |

**Server (play world), applied the same day:** it ran at its 3-core cap (292 % of 300 %) with 5.9 of 7 GB, and the console at its 2-core cap (191 % of 200 %) with 1.8 of 2 GB. Now 6 cores, 14 GB container, 10 GB heap (`PLAY_CPUS`, `PLAY_MEM_LIMIT`, `PLAY_HEAP` in `.env`); console 3 cores, 4 GB, `--max-old-space-size=3072`. Gamerule `disableElytraMovementCheck true`.
**Not done: "the client wins a state conflict".** Vanilla and Forge 1.20.1 have no setting for it. Position checks ("moved wrongly", "moved too quickly") are hard-coded in the server; the only ways are a server-side mod that removes them (for example "Too Fast", "Gotta Go Fast"; both are coremods and open the world to speed hacks) or lowering the latency. Nothing was installed: it changes the mod set of the owner's world and the owner decides.

Not verified live: a real bed touch on the play server (day and night), a line of 20 bots at one chest, the Place page in a browser and in the F12 view, the harvest inside a running pit (j28 was running while the console restarted; a bot that respawned far from the pit still waits for items there: set its respawn point with `set_spawn`).

## v14 (2026-11-09, `TASK:20261109-049`): set_spawn was broken for all 20 bots, desync mods on the play world, a bigger map in the F12 view

| # | Owner point | Cause found | What was done | Where |
| :-- | :-- | :-- | :-- | :-- |
| 1 | `set_spawn` fails with `error` and no content for all 20 | The result detail was `{"message":"pos.floored is not a function"}`: `bot.blockAt` and `bot.lookAt` were given plain `{x, y, z}` objects, mineflayer wants a `Vec3`. The unit tests' fake bots accepted plain objects (fakes now throw like mineflayer), so v13 shipped broken | `Vec3` in `bot/bed.js`. Checked on a REAL server (demo): four bots, day and night, the stored `SpawnX/Y/Z` read back from the server, a bed by coordinates, no bed = `invalid_target` with the reason in words. Also on the play world: Work3 and Work20 set their spawn at the pit's bed, verified by the server | `bot/bed.js`, `scripts/work/spawn_live.js` |
| - | (found by that check) a one-off `deposit`/`withdraw` from the Commands page did not use the line | `_exec` called `skills.execute` directly | It goes through `env.exec` (the line): four bots, one chest: all four deposited 20 (80 read from the server, up to 4 in line at once). Without the line two of four failed | `service/commands.js` |
| 2 | Server: only trusted players join; install something that prevents desync of movement checks and block placing/breaking, and none of the efficiency mods | The server rolls a player back when it judges a step "moved too quickly" / "moved wrongly" and refuses a break or placement whose block is out of reach of the position IT knows (`forge:block_reach` 4.5 + 1 margin); with lag that position trails the client's | **I'm Fast 1.0.2** (Modrinth, MIT, source github.com/Gabriel-Hiss/Im-Fast; 4971 bytes, sha512 b6e57e91933db8eb... matches Modrinth's listing; one mixin on `ServerGamePacketListenerImpl.handleMovePlayer`/`handleMoveVehicle` raising the speed and moved-wrongly limits, no network or file code), server side only, in `mods/`. And the KubeJS script `forgeaip_block_reach.js`: `forge:block_reach` base 7.5 at every login and respawn (nothing on the client). No performance mods added (FerriteCore and ModernFix were there already). Live check on the demo server: a 25-block step in one tick is kept 3 of 3 (without the mod: reverted 3 of 3, measured first); reach 7.5 for a joined player and after a death and respawn | `modpack/kubejs/server_scripts/forgeaip_block_reach.js` (also in the play volume `/data/kubejs/server_scripts/`), `scripts/work/desync_live.js`, `/mnt/data/forgeaip-play/mods/imfast-FORGE-1.20.1-1.0.2.jar` |
| 3 | The F12 map is now far too small; twice the size | v13 made it 34 % of the window height | Kiosk: tall map `clamp(360px, 68vh, 900px)`, small map `clamp(320px, 56vh, 640px)` | `public/work/work.css` |

What this does NOT do: the client does not win every conflict (a block another player or a Create contraption changed, or a break the server rejects for another reason, is still corrected), only the two causes above are removed. The mod has no `displayTest`, so a real Forge client may show the server with a red mark in the list; the bots join without trouble (live). Not tested with the owner's own client: if joining is refused, delete the jar from `mods/` and run `./up.sh --force`.

## v15 (2026-11-09, `TASK:20261109-050`): the bots in other dimensions, work over an abyss, the frame for breaking bedrock, villager trading (WIP)

The owner's request: extend the pure bots to the Nether, the End and dimensions that may exist (Twilight Forest) for pits, placing, building, moving, mining and collecting; a range per dimension with coordinate designation and the movement to get there; a method for a floor that is an abyss; the basic structure for breaking bedrock; trading with villagers (WIP, imperfect on purpose). **Operation testing was not requested and was not done**: everything below is unit-tested (including the bridge move on real `prismarine-physics`), none of it has run on a live server.

| # | Part | What it does | Where |
| :-- | :-- | :-- | :-- |
| 1 | Dimension profiles | `canon` turns any spelling into `overworld`, `nether`, `end` or the full id of another dimension (`twilightforest:twilight_forest`); ids with `..`, empty parts or odd characters are refused (the id becomes a folder name in the map). `profile` gives limits (overworld -64..319, Nether and End 0..255), the bedrock layers, `voidBelow`, the 1:8 scale. An unknown dimension gets the safe intersection 0..255 and no assumed floor; once a bot has been in it, `bot.game.minY` / `height` (from the login packet) replace the guess. | `world/dimensions.js` |
| 2 | Designated range | `designate({dim, x0, z0, x1, z1, y0?, y1?})`: normalised, checked against the dimension's limits and the 256-per-side / 4 M volume caps, y defaults to the work band (the Nether: 5..122, between the bedrock layers), with warnings (touches a bedrock layer, no floor in places, limits are a guess). `convert` does overworld <-> Nether at 1:8 (`exact`), other pairs keep x and z (`exact: false`). `POST /api/range/check` answers with the range, the limits and the same spot in the twin dimension; `GET /api/dimensions` lists the three vanilla ones and every dimension a bot or a tagged gate is in. | `world/dimensions.js`, `checkRange` / `dimensionsList` in `service/jobs.js`, `web/routes/jobs.js` |
| 3 | Jobs in a dimension | `createPit`, `createBuild`, `createLayout`, `previewLayout` take `dim` (default overworld); heights are checked against that dimension (a layout in the Nether at y 300 is refused with the reason); the spec keeps `dim` (and `limits` when a bot told us the limits of an unknown one); jobs in different dimensions never overlap. A worker whose bot is in another dimension is taken there BEFORE its environment is made (`_enterDim`: a tagged gate, else the server puts it at the pit's middle at its top level / the build's origin). The dimension watch (`_watchDimension`) no longer sends a bot home when the bot's job is in that dimension or the operator sent it there (`rec.inDim`). The Pit and Place pages have a Dimension field (the map follows it for the three vanilla ones and, with the map store change, for a modded id). | `service/jobs.js`, `service/workers.js`, `service/bots.js`, `service/common.js` (`normalizeBox`), `jobs/layout.js`, `public/work/page_pits.js`, `page_place.js` |
| 4 | Moving there | `journey` takes any dimension id; the route goes through a tagged gate that leads there. New option **by the server** (`viaServer`, needs y): with no gate (the Twilight Forest has none a bot can walk into) `execute in <dimension> run tp` puts the bot there, then it waits for the dimension to change and for ground under the feet, and says so when there is none. `teleport` takes `dim` with x, y, z. Gates (tagged blocks) may stand in any dimension. Gather, move_to, mine, place work in whatever dimension the bot is in: they read the world model of the dimension it stands in. | `_journey`, `_serverJump` in `service/commands.js`, `bot/route.js` (unchanged), `bot/sites.js` |
| 5 | Floor is an abyss | Not "place a block, break it, ..." (it never ends: the block you break is the one you stand next to). `bridge {x, y, z, job?, item?}` lays a level bridge of temporary blocks from the bot's safe cell to the cell beside the work, does the job (mine, place, or nothing), walks back along the bridge and stops. The bridge stays. Planning (`abyss.js`) reads the world and names every refusal before a block is laid (no solid start, not loaded, lava / water in the way, blocked, longer than 40 blocks). The move (`bridge.js`) is sneak-walk to the very edge, place against the side face of the block under the feet, step on; the way back is `sneak_walk`. A bridge that fails half way (out of blocks) is walked back; a walk back that fails goes to the server (`goBack`). Blocks used: cobblestone first, never sand or gravel. The pit's step into a hole with nothing under it is skipped (`r.abyss` counts them). | `bot/abyss.js`, `bot/bridge.js`, `bot/moves.js` (registry), `jobs/pit.js` |
| 6 | Bedrock | Only the frame, as asked. `break_bedrock {x, y, z, radius?}` is off unless the Automation setting `bedrockExploit` is on; then it works only inside a designated range (the block, or `radius` around it), only on real bedrock inside the dimension's bedrock layers, never within 12 blocks of the End's exit. `METHODS` has one empty sketch, so today the answer is `invalid_target: no bedrock method is implemented (WIP)`; a method is a list of steps (place, mine, activate, wait, move_to, expect_air, expect_block: never a server command) run by `runSteps`, and success is only claimed when the block is really air afterwards. | `bot/bedrock.js` |
| 7 | Villagers (WIP) | `trades` opens the nearest villager (or the picked one) and writes its offers to the log; `trade` buys: name the trade by its number, or by what it gives (`get`) / takes (`give`), a price limit (`maxPrice`), `count` uses. The cheapest open matching trade is used; sold out, not affordable, no villager, a walk or a window that fails each have a reason; the window is always closed; success is confirmed by the inventory. | `bot/trade.js` |

**Not done / not verified (WIP):** nothing ran live. The bridge's aim from the edge is only proven on the physics simulation (the real server's reach and placement checks are the vanilla ones the simulation models). The server jump lands at an explicit y and cannot know the floor of a dimension nobody has loaded. Chunks: a bot far from its job in another dimension is only as good as the legs of `travel`. The map page's dimension list is still the three vanilla ones (the Pit and Place pages take any id). Pits are not planned around a gap in the middle (only the step into one is skipped); bridges are one block wide, level, x-then-z. No method for bedrock exists. Villagers: no line when many bots want one, no wandering trader, no modded villagers, the list is read at each call (a restock changes it), the offers go to the log, not to a page.

**Security basis:** no new listener. New routes `GET /api/dimensions` and `POST /api/range/check` sit behind the existing session + CSRF (`tests/test_work_console_pure.js`: 401 without a session, 400 with a bad dimension or height). The dimension id is closed-list validated (`canon`: namespaced, no `..`, no empty part, 70 characters; it reaches RCON only through `rconId`, and the map store resolves it under `dimensions/` and refuses a path that leaves the world folder, tested). `bedrockExploit` defaults to false and is a boolean setting through the existing `POST /api/settings`. The new commands go through `_checkArgs` (closed lists: dim, item names, integers within limits). The world folder stays read-only. Node dependencies unchanged.

## v16 (2026-11-09 evening, `TASK:20261109-052`): where the bot time went, failure memory, bots by number, `any` insert-only

The owner's list: 13-68 failed units a minute (unreachable 11-54, `invalid_target` on bubble columns, stuck), 0-8 drowning cancels a minute, no way to give a job "bots 5 to 8", the chest tagged `any` sometimes emptied, bots that say "Digging" but stand still, and the same movement to the same place repeated for ever. Method: measure first (the health row now adds up bot time per activity and standing-still time), then fix what the numbers showed.

**What the measurement showed (live job j29, 20 bots, 32 x 160 x 200 pit; health windows before and after).**

| Finding | Evidence | Fix |
| :-- | :-- | :-- |
| One door at the storage chest: 8-11 of 20 bots in the line all the time, 5-8 visits a minute, about 60 bot-seconds a minute of service | health `lines` before: 8-11 at `1744,-59,1774`; after: 1-2 | `Gates` take `slots` bots at once (`bot/queue.js`): chests 3 (setting `chestSlots`, 1..6), tools and free chests 2, beds 1 (`service/index.js _slotsFor`) |
| Bots stranded at the world spawn: 127 of 192 failures in 7 minutes were `target chunk not loaded` at the same cell from 4 bots (Work1, 13, 15, 18). They died, came back 1,500 blocks from the pit, `lift` found nothing (no chunks), then `goToStation` dug a 180-block corridor toward the station cell by cell | problem rows: pos 269,140,457 vs station 1753,140,1801; the failure was counted as the bot's own (no attempt, no hold) so the same bot re-claimed the same unit at once, for 20 minutes ("I do not know why it goes there") | `env.rejoin` (`bot/env.js`): the server moves the bot to the cell above the station, or the last good place, only when the server itself says that cell and the one above are air (`execute if block ... run tp`); twice at most, then a failure marked `botSide`. No corridor of more than 24 blocks any more (`jobs/pit.js goToStation`) |
| The same try failing the same way, again and again: Work18 failed the same cell 13 times, one unit 10 times (`maxAttempts` 10) | problem rows by (bot, cell) | **Failure memory** in the ledger (`jobs/crew.js`): the same failure twice (same reason, stage, cell, words: `failureSig`) parks the unit as `stuck` at once (the layer goes on, the repair pass tries it again when the neighbours are dug); a failed unit is on hold for 5 s (x2 per identical failure) so the bot takes the other units of its range first; a parked or held unit skips the backoff wait. `PIT_LEDGER`: `sameLimit 2`, `holdMs 5000`. Builds keep the old rules |
| `invalid_target: cell holds bubble_column / tall_seagrass`: 124 of 364 failures in 30 minutes | `place` refused them; both are replaceable in the game | `REPLACEABLE` in `skills/commands/block.js` |
| `unreachable: reach placement face` (21 % of failures) | in water the planner finds no standing place that sees the face | one server lift beside the fluid cell, then the placement again (`placeAt` in `pit.js`); the second failure goes up and the unit is parked |
| `unreachable: reach block` at a distance of 0.5-3 blocks (76 of 148 in 5 minutes) | one-wide shafts with undug neighbours: no standing place sees the block, the pick still reaches | blind dig (`mine {blind}`; the server checks distance, not sight) for any block within 4.6 blocks of the eye, not only the one under the feet |
| One failed cell ended the whole 5 x 5 tile, so a retry redid everything | `runUnit` returned at the first failure | the rest of the tile is dug, the unit then fails with the first failure (two failed cells end it at once; died / cancelled / missing tool or item end it at once) |
| Lift loop: "moved by the server 0 blocks (job)" every 20 s (Work17) | log | `lift {skipSame}` does not move a bot that already stands there; at most two lifts per walk to a station |
| "Digging" while standing still | the page showed the action layer's last phase, kept for 180 s after the bot had stopped (in the line, in the backoff, cooling down) | the page shows the worker's **activity** (taking a unit, working a unit + fresh phase, upkeep, waiting in line, at the chest, moved by the server, fixing a failure, pausing, waiting for a unit ...) and `not moving N s`; the phase only while it is under 10 s old |
| Drowning cancels (3-5 a minute, `rescue` 60 bot-seconds a minute) | health `cancel` | not changed: it is the protection (air below 9 of 20); the cost is now visible as `rescue` in the time row. The cause is digging next to water; the bubble-column and seal fixes remove its biggest source of repeated tries |
| `any` emptied "occasionally" | `sites.sources()` listed `any` chests as a place to look for a tool or a material; a script's `from: any` (any container) ranked the `any` chest first | **`any` is insert-only**: `Sites.sources()` never lists it, `withdrawable()` refuses it, scripts refuse `withdraw` / `take_usable` at it (`bot/script.js`). A manual `withdraw` typed on the Commands page still works (the owner types the coordinates). Consequence: what a pit bot deposited is never fetched back, so the seal reserve stays in the pack (`keep.cobbled_deepslate.min 16`), and routines that took from a chest need it tagged `free` |
| After the `any` change one bot (Work9) failed `missing_item: no block to seal water with` 11 times a minute for ever: the fetch script had no chest to take from, "waiting for an item", resume, again | health `needs: missing_item:water 11`, log `fetch-item ... invalid_target` | `harvest` (`bot/moves.js`): with nothing to seal with the bot takes a stackable block from the undug part of the pit beside it (the pillar's way); a bot that fails over and over cools down 5 s, 10, 20 ... up to 120 s (`workers.js`), reset by one finished unit |

**Bots by number.** `POST /api/jobs/pit|build|layout` take `range: {from, to}` (Work3 is number 3; either order; merged with `bots`), `POST /api/jobs/<id>/assign` takes `{bots}` and/or `{range}`, `POST /api/jobs/<id>/unassign` takes `{bot}` or `{range}`. The Pits, Place and Structures pages have a "by number" row (from, to, Select / Add / None, idle only), the Jobs page has "bots no. from - to, Assign / Remove" per job. A bot that works on another job is refused (409), so two jobs run side by side on their own bots: 5 bots on one pit, 5 on another.

**Health row (new fields, once a minute in `health.jsonl` and the log line).** `time`: bot-seconds per activity (`unit:<phase>` inside a unit, `line`, `lift`, `chest`, `janitor`, `claim`, `idle`, `recover`, `backoff`, `rescue`, `audit`, `sweep`, `script`), `still`: seconds without movement (sampled every 2 s) per the same keys, `parked` / `parkedBy`. Reading it: `still` under `unit:dig` is a bot digging (a sweep stands and digs); `still` under `line`, `backoff`, `idle` or `recover` is time lost.

**Measured (same job, 20 bots).** Before: 22-42 finished units a minute (average about 33), 13-68 failed, 8-11 bots in the storage line. After the fixes, steady state: see the record in the knowledge-DB (`TASK-20261109-052`); the first windows after a restart are not representative (about 4 minutes: every bot re-runs its finished units as no-ops, 20 bots take their pickaxes from the tools chest, rejoin of stranded bots).

**Not done / not verified.** Not tried live: `chestSlots` above 3 (the Ender chest shows one inventory to every viewer in the mod's design; two bots taking the same pickaxe stack at the tools chest ask again), `env.rejoin` where the chunk of the station is not loaded on the server (the server then refuses and the bot fails `botSide`; nothing sets a bot's spawn point near the pit automatically: `set_spawn` at a bed is still the way to stop deaths from sending bots to the world spawn). Parked units wait for the repair pass at the end of the job (up to 30 passes, 3 s apart). The startup after a restart still costs minutes: the tools chest is the line (27 pickaxes for 20 bots that each want 3).

## v17 (2026-11-10, `TASK:20261110-053`): no token, maps of other dimensions, retries by themselves, the layer gate, one list of placed blocks, storing in one trip

The owner's nine points. Evidence first, then what was built.

| # | Owner point | Cause found | What was built | Where |
| :-- | :-- | :-- | :-- | :-- |
| 1 | Maps of other dimensions are black (Pit and Map); area selection is hard | **Nether:** its region files hold a bedrock roof, the map drew the MOTION_BLOCKING height, so every column was bedrock: `r.0.0.mca` of the play world read 206,336 columns, all `bedrock`. **End:** the map was fitted to the overworld jobs and bots (hundreds of blocks away) and the jobs, bots and players of other dimensions were drawn on every map. Selection: after typing numbers the old typed box (`fixed`) was drawn instead of a new drag; the pan/select modes were only right-drag / Ctrl-drag | The map **looks down from a layer** (`/api/map/region?top=<y>`, `mca.js sliceColumns`: first non-air block from y down; the Nether starts at y 70, a field `view from y` on Map, Pit and Place, blank = surface; in the Pit page it follows `top y`): same columns, now netherrack, basalt, lava, soul sand. Jobs, bots and players are drawn only in their own dimension (`dim` on the bot view, `spec.dim`, player `dimension`); fit uses only that dimension and, with nothing in it, the six regions nearest the origin. Selection: **Select / Pan** button, edges and corners of the selection can be dragged, **Clear** (and Esc), **Bigger**, a new drag drops the typed box | `world/mca.js`, `world/mapworker.js`, `world/maps.js`, `public/work/map.js`, `widgets.js` (`dimPicker`, `sliceControl`, `selectTools`), `page_pits.js`, `page_place.js`, `page_map.js` |
| 2 | Is the WebUI token needed? | Both routes are already authenticated by the network (Tailscale) or Cloudflare Access | No token by default; see Security basis. `tests/test_work_console_pure.js` (no session without `/api/session`, no login route, proxied requests refused 403 with every proxy header) | `web/server.js`, `web/main.js` |
| 3 | Pit tab: dimension as a pulldown | a text field with a datalist | `dimPicker`: overworld, nether, end, "other (mod dimension id)..." (a text field appears); also on Place and Map | `public/work/widgets.js` |
| 4 | Failed jobs' retries should not wait for a human | the job's repair passes ended after 90 s (30 passes, 3 s apart) and then only the button was left | Quick passes while the crew is there (3, 6, 12, 24, 48, 60 s), then, when units are still stuck, **automatic rounds** 2, 5, 10, 20, 40 and 60 minutes later by the crew that is free (else any idle bot); a fixture (`protected`) or bad arguments are not retried; the job page says "next automatic retry in ..." or "used up"; setting `autoRepair` (default on); the button still starts a round at once | `service/workers.js` (`_maybeFinish`, `_watchRepair`), `jobs/crew.js` (`requeueStuck` with a filter), `service/views.js`, `page_jobs.js`, `page_auto.js` |
| 5 | Pits leave many unmined blocks, "fix it properly before going down a level" | In a live pit (j29, 32 x 160) the leaves hung at y 98-116, and the layers 20-39 held 3,546 stone because lanes lag; the real cause of leftovers: a **parked unit settled its layer** (the layer below went on) and only the end-of-job repair and the final sweep looked at it, and the sweep read only finished units. `unreachable: mine` was 35,431 of 59,000 problem rows | **The layer gate** (`Ledger {gate}`): a layer opens the next only after `checkLayer` read every cell of it from the world (done and parked units alike); what holds a block goes back to work (held 4, 8, 12 s; three rounds, then accepted as `leftover` and reported); one bot reads, the others wait; the last layer is read too; fixtures and floating blocks left on purpose (`plan.accepted`) never send a unit back. Log: "layer N of <region> checked ...". The final sweep and the automatic retry stay | `jobs/crew.js` (`needCheck`, `checkDone`, `requeueUnit`, `checkBusy`), `jobs/pit.js` (`checkLayer`), `bot/worker.js`, `service/common.js` (`PIT_LEDGER.gate`) |
| 6 | A bot breaks the bed at its respawn point; blocks on top of chests | `fixtures` knew boxes and tagged blocks, not beds; nothing stopped a placement on a chest | A **bed is a fixture** (`mine` -> `protected`); **nothing is placed on top of a chest, trapped chest, Ender chest or shulker box** (`place` -> `protected`; the pillar refuses to start on one); a water seal is the one exception and is registered; a block of ours over a chest is taken away before a deposit (`uncover`). Live: bed, chest, Ender chest refused, cells above still air | `skills/fixtures.js`, `skills/commands/block.js`, `bot/moves.js`, `bot/temps.js` |
| 7 | Slow, many retries and timeouts, stops often | Measured in the live pit (20 bots, 60-second windows): `recover` took **229-514 of 1200 bot-seconds a minute** (20-40 %), the experts only about 4 % (124 uses in 2 hours, failures 42-62 s each); the rest were walks back to the last good place, which ran to the command's 60 s limit; `unit:walk` 150-230 s. The console process was at **94 % of one core** (Node is one thread for all 20 bots): the structural limit, not changed | A walk back gets 15 s, a walk to a station 30 s, the experts 25 / 20 s; a bot whose expert failed twice in five minutes goes without it for three minutes; the fix in progress is named in the health row (`fix:jump`, `fix:wait`, `fix:lift`, `fix:walk_back` ...) so that the next measurement says where the rest goes | `bot/env.js`, `jobs/pit.js` |
| 8 | Storing: one stack, then back at once | the plan stopped at 18 free slots (lowest value first), a surplus-only trip took only the surplus, and a **full chest does not answer**: the transfer just does not happen and the wait ended as `not_confirmed`, which failed the whole trip (found by the live check) | A trip takes **everything that may be stored** above the protected minimum (`dumpAll`, default on); a container with no room for a kind is skipped at once; what did go in counts; the rest goes to the **next container in the same trip** (up to three rounds), and a full one is passed over for two minutes. Live: 17 kinds into a chest next to a full one, bot 32 slots free, the second upkeep found nothing to do | `bot/janitor.js`, `bot/moves.js` (`depositMany`, `roomFor`) |
| 9 | Blocks placed for water handling are never broken; temporary blocks too; register them, one set, global | `env.temp` was a Map **per worker run**: gone at every restart or pause, so pillar blocks stayed; water seals were not recorded at all; the build job used the same name (`env.temp.cells`) for its scaffold and would have crashed on the Map | **One registry for the service** (`bot/temps.js`, shared by every bot, kept in `state.json`): a block is listed when placed (`place {temp: 'seal' \| 'scaffold' \| 'rescue'}`, the pillar, the reflex), forgotten when broken **by anyone**, cleaned up when safe: a pit that is finished breaks its listed blocks inside the box, a bot that passes breaks pillar, scaffold and reflex blocks within 10 blocks, a **seal or a water-rescue fill stays while fluid lies beside or above it** (the first deployment let passing bots break the rescue fills too: 369 were listed, the pit flooded again and `rescue` went from 27-108 to 273-404 bot-seconds a minute within minutes; found in the health row, fixed the same hour). The build scaffold has its own `env.scaffold`. The page status shows the counts (`temps`) | `bot/temps.js`, `service/index.js`, `jobs/pit.js` (`cleanup`), `bot/worker.js` |

**Security basis (item 2).** No new listener (`ss` unchanged; the container publishes `127.0.0.1:3020` only, the tailnet reaches it by the ufw rule). Unauthenticated `curl` on `/api/state`, `/api/session` through a proxy header: 401 / 403 (test and live). The token's one job was to stop a tunnel mistake and other users of the box; the first is now a header check that does not depend on the Host, the second is the Tailscale ACL (trusted players only). Every non-GET still needs the CSRF header and a same-host Origin, the Host check against DNS rebinding is unchanged, the session cookie is `SameSite=Strict` and not readable by pages of other origins (no CORS). No dependency changed.

**Tests.** `tests/test_work_gate_pure.js`, `test_work_temps_pure.js`, `test_work_store_pure.js` (new), additions to `test_work_console_pure.js`, `test_work_features_pure.js`, `test_work_flow_pure.js`, `test_work_policy_pure.js`. Live on the demo server: `scripts/work/temps_live.js` 17/17 (the first run found the full-chest behaviour), `scripts/work/pit_live.js --gate 1`.

**Not done / not verified.** The map's new controls (select / pan, edge resize, view from y) are not tried in a browser: no browser check against the real console (CLAUDE.md of the vps repos) and none on the PC. A seal that holds water back is never broken while it does, so exterior seals of a pit stay as they are. The event loop of the console is one thread (94 % of one core with 20 bots): more bots need more than this change; moving bots into worker threads is the real fix and is not started.

## v18 (2026-11-10, `TASK:20261110-054`): no teleportation, gates by what they lead to, Move with a dimension, pits of 100 x 100 chunks, the chest reach as a setting

The owner's five points. Evidence first, then what was built.

| # | Owner point | Cause found | What was built | Where |
| :-- | :-- | :-- | :-- | :-- |
| 1 | An End portal was placed and the Pit given the End as its dimension; several units suddenly appeared in the End and fell. Nobody went through the gate | Two causes. (a) `_enterDim` asked `_journey` with `viaServer: true`: with no usable gate the **server put the bot into the End** at the pit's middle (`execute in minecraft:the_end run tp`), over the void. (b) The only portal tag (`endportal` at 1761 20 1757) had no twin and the dimension field "end"; a gate counted only with a twin, and the field means the dimension the block STANDS in (it was read as the destination), so the route found no gate | A bot enters a job's dimension through a tagged gate only; with none the worker does not start and the log says which gate is missing. A portal tag has a new field **`leads`** (the dimension it leads to) as an alternative to a twin: an End portal has no twin, the way back is another place. The Tags page says "stands in" and "leads to"; the route uses `leads`. The Nether shortcut (`viaNether`) still needs real twins | `service/workers.js` (`_enterDim`), `bot/sites.js`, `bot/route.js`, `public/work/page_tags.js` |
| 2 | Too much is left to teleport; prohibited for now | 14 places used RCON `tp`: recovery lifts, the way out of a pit, the water rescue, `goBack`, `rejoin`, the dimension watch, the server jump, the Teleport command. The old setting limited only recovery moves | The setting **Server moves** is `off` by default and means **no server move of any kind** (lift, rejoin, goBack, back refuse with `refused`; the dimension watch only says once that a bot is in another dimension; `_serverJump`, `journey` "by the server" and the Teleport command refuse). `near` / `any` work as before (recovery only). A bot far from its station (it respawned at the world spawn) now **walks back in legs** (`env.travel`) instead of being rejoined by the server | `bot/env.js` (`lift`, `rejoin`), `service/commands.js`, `service/bots.js`, `jobs/pit.js` (`goToStation`), `service/world.js`, `public/work/page_auto.js` |
| 3 | Cross-dimension targets cannot be given; Move had no dimension | Only `journey` took a `dim`; `move_to` (Move on the Commands page) is the RL action-layer command and has x, y, z only | `move_to` gets an operator-only optional **`dim`** (taken off before the action layer sees it, so the RL action space is unchanged): another dimension = the same route as `journey` (walk to the nearest gate that leads there, go in, walk on to x y z); the same dimension = the plain walk. `journey` still exists and does the same, with the extra options "by the Nether" and "by the server" | `service/commands.js` (`_checkArgs`, `_exec`), `operator/catalog.js` (`EXTRA`) |
| 4 | Pit range too small; 100 x 100 wanted (open pits of several dozen chunks are routine in the other system) | The limit was 256 blocks a side (16 x 16 chunks) and 4 M cells | Read as **100 x 100 chunks = 1600 blocks a side**, depth unchanged (256). The cell cap is replaced by a **unit cap** (`MAX_UNITS` 16 M: what the ledger keeps in memory, about 35 bytes a unit; 100 x 100 chunks, 5 x 5 stations, 100 layers just fits; deeper = dig in two steps, the error says so). A designated range (`dimensions.designate`) has the same side limit. Measured on a fake world: 1600 x 1600 x 10 = 1.6 M units, 10,000 regions, planned in 0.3 s, 125 MB, 40 claims in well under a second | `service/common.js` (`MAX_CHUNKS`, `MAX_SIDE`), `jobs/pit.js` (`MAX_UNITS`), `world/dimensions.js` |
| 5 | The chest range (supply runs and the like, 10 chunks) variable, 50 chunks for now | `REACH_BLOCKS` was a constant of `sites.js` | Setting **`reachChunks`** (1..200, default 50), page Automation "How far a bot looks for a chest"; `Sites.setReach`, re-applied when the registry is made again on restore | `bot/sites.js`, `service/world.js`, `service/index.js`, `public/work/page_auto.js` |

**Layout and limits.** Region count follows the chunk grid (10,000 for 100 x 100 chunks); the lane count of a job stays at most 32. `claim`, `needCheck`, `progress` loop over all regions (cheap at 10,000). The page's job detail lists every region (about 1 MB at 10,000).

**Tests.** New `tests/test_work_limits_pure.js` (gate with `leads`, sites validation, 100 x 100 chunk pit plan and cap, the setting, the walk back instead of a server move); changed: `test_work_dimensions_pure.js` (server moves off by default, no server jump for a job, `move_to` with a dimension), `test_work_policy_pure.js` (off refuses job moves too), `test_work_features_pure.js`, `test_work_fixes_pure.js` (reach 50 chunks), `test_work_queue_pure.js`, `test_work_service_pure.js`.

**Not done / not verified.** Not run live: a crossing of a real End portal (the End side is the obsidian platform at 100 49 0; reaching a pit on the central island from it needs a bridge over the void, `bot/bridge.js`, not tried), a pit of 100 x 100 chunks (only planned and claimed on a fake world; the walking between regions of that size, the final sweep over 10,000 chunks and the display of 10,000 lanes are untried), a supply run of 800 blocks. With server moves off a bot that falls into a pit it cannot climb, or into water, has no rescue except the walking, digging and pillar moves.

## v19 (2026-11-10, `TASK:20261110-055`): a bot outside the job's dimension stops, the entry ends at the gate, a level bridge over the End void, a step off a block the planner cannot start from

First job that spans dimensions (a 208 x 224 pit on the End's main island, 20 bots). Evidence read from the live console (`problems.jsonl`, the bot rows, RCON `data get entity`), not guessed.

| # | What the owner saw | Cause found | What was built | Where |
| :-- | :-- | :-- | :-- | :-- |
| 1 | Nos. 1, 2, 12, 15 ... pace or walk about "unrelated to the End portal"; 12 of 20 bots were in the Overworld | A bot that died in the End comes back in the Overworld (at its bed, or at the world spawn on the rim of the pit). Its worker was still running with the pit's **End coordinates** (stations like 81 57 17): `goToStation` -> `env.rejoin` (server moves are off) -> `travel` walked toward x 81, z 17 across the Overworld, underground, 1,500 blocks (Work1 x 1580 -> 1450, Work2 y -30 in a cave). Nothing in the worker, the walk or the station code knew which dimension the coordinates belonged to; only the start of a worker checked it | `env.jobDim` (set from `spec.dim`) and `env.wrongDim()`. `runWorker` ends `wrong_dimension` before claiming and after a unit; the unit's failure is the bot's own (`BOT_FAULT`, nothing counted, nothing parked); `travel` and `goToStation` stop at once. `_workerEnded` restarts the worker 2 s later, `_startWorker` then goes through the gate (`_enterDim`). Verified live: Work13 "is in overworld, the job is in end: the worker stops ... -> end ok" | `bot/env.js`, `bot/worker.js`, `bot/travel.js`, `jobs/pit.js` (`goToStation`), `jobs/crew.js`, `service/workers.js` |
| 2 | "Some entered the End but began rising right after, then stopped abruptly and threw an error; some stood still without destroying their temporary blocks" | On arrival the bot stands on the obsidian platform (100 49 0); the island is 20-40 blocks away across void. `goToStation` had no way over a gap: a station above the bot meant `pillar` (rise) straight up beside the platform, then `not_confirmed` / `nothing solid under the feet`; a tower over the void whose blocks `cleanTemp` cannot break (the bot would fall) | The pillar is only for a station above the bot's own column (within 24 blocks). A **gap on the level line toward the station** (`bridge.js` `gapOn`: solid floor, then no floor down to the dimension's bottom) is crossed by a level bridge (`planToward`, `bridgeToward`, the existing `bridge` move); a bot standing on a base beside the void walks to its edge first; a bot whose own level is blocked (the owner's iron base is two levels under the platform, the platform is its ceiling) tries up to four launch cells nearby (`launchCells`: the platform top) and bridges from there. The bridge ends on land or at the wall of the island's flank, then the usual walk / corridor goes on | `bot/bridge.js`, `bot/env.js` (`bridgeToward`, `gapOn`), `jobs/pit.js` |
| 3 | The entry itself "failed" for bots that had crossed | `_enterDim` walked on to the pit's middle at `top + 1` after the portal: in the End that is a cell of air over void ("a player cannot stand there"), so a crossed bot reported "could not get into end" | The entry ends at the exit portal (`journey {gateOnly}`); the walk to the job is the worker's | `service/workers.js`, `service/commands.js` |
| 4 | No. 8 "stopped in front of the bed" | It respawned standing on the Ender chest beside its bed (feet at y 21.9); the planner has no model of that block as a floor: every `move_to` failed "start cell not standable" (diagnosed with one `move_to` on the idle bot) | When the plan fails and the bot stands still on a block the planner cannot start from, one step onto a neighbouring cell that is surely standable (air for feet and head, solid below), at most three times per walk, then plan again. Verified live: Work8 got into the End | `skills/motion.js` (`stepOffCell`) |
| 5 | (found on the way) | `env.rejoin` asked the server whether the cell is air with `execute if block`, which looks at the Overworld; in the End it tested the wrong world | `execute in <the bot's dimension> if block ...` | `bot/env.js` |

**Not fixed, and why.** Bots 16-19 stand on the pit's rim at y 87-93 and 7, 9, 12, 14 in shafts at y 3-8: the portal (1761 20 1757) is in an iron room on a platform in the middle of the pit, 40-70 levels below, with the floor at y -60 around it. No walk leads there (legs are limited to 24 levels, deliberately: walking down pit walls killed bots), and server moves are off by the owner's rule. They no longer work with End coordinates; they wait and retry, and the log now says "the gate is N levels below the bot and no walk leads there". The respawn point decides where a dead bot comes back: the bed in the room (Work8) is one step from the gate, the world spawn is on the rim. Ways out (owner's decision): the `bed` command for every bot while it is in the room, a ramp or stair from the rim to the platform, or `Server moves` switched on once.
Also open: the bridge and the step-off are verified on a fake world and (step-off, End entry) on one live bot each, not on real physics over the End's void; a bridge needs cobblestone, end stone, dirt or similar in the pack (`missing_item` otherwise). `Work3` at the platform fails `reach placement face` while sealing at y 69 (a cell over void), not changed here.

**Tests.** New `tests/test_work_dimension_guard_pure.js` (13 cases: worker stops and charges nothing, no rule = no change, travel and `goToStation` stop, bridge planning on an End in miniature, edge walk then bridge, no pillar 30 blocks away, `stepOffCell`); `test_work_flow_pure.js` (the `rejoin` command now has `in <dimension>`). `npm test` exit 0 (43 files).

## v20 (2026-11-10 evening, `TASK:20261110-057`): any low-value block to climb with, one stack kept, a push for bots that do nothing

Owner points: bots stopped for want of cobblestone to climb with although countless blocks can be placed; bots piled up on pillars and never moved; a bot in an error loop never recovers; the storing trip took the last climbing blocks.

| # | Built | Where |
| :-- | :-- | :-- |
| 1 | **Any placeable, non-falling, low-value block is a temporary block.** Name families (dirt, stones, netherrack, blackstone, end stone, sandstone, terracotta, the Create stones ...) or a janitor value of 8 or less; never sand, gravel, concrete powder, anvils, scaffolding; no slabs, stairs, glass; with the registry: a full cube, breakable, hardness 4 or less. The usual cobblestone and deepslate first, then the biggest stack. Used by pillar, harvest (what a bot may dig out of the undug pit for it), pit and water seals (`sealItem`, `env.tempItem`), bridge, fall reflex | `bot/tempblocks.js`, `bot/moves.js`, `jobs/pit.js`, `bot/water.js`, `bot/bridge.js`, `bot/reflex.js`, `bot/env.js` |
| 2 | **One stack (64) of such blocks is never stored or thrown away** (`policy.tempReserve`); less than a stack stays whole | `bot/janitor.js` |
| 3 | **Forced fall.** A working bot that has not moved for 30 s, finished no unit in 30 s, is not in `idle`, `line`, `chest` or `bed` and has at least 2 blocks of free air under its support: the block under its feet is broken (never a container, bed or tagged block), or it steps off sideways; the fall reflex is off for 12 s. Settings `forceFall` / `forceKill` | `bot/force.js` (decision), `service/force.js` (action) |
| 4 | **Forced kill** (RCON `kill`): 60 s of unit failures without a success (cancelled, wrong_dimension, missing_item, missing_tool do not count), or a fall that did not get the bot moving within another 30 s. A bot first seen has 30 s of grace (a restart pushed three bots at once). Written to `console-data/forced.jsonl` and counted in the health row (`forced`, `FORCED` in the line) | same |
| 5 | Two causes of `unreachable` found with these logs and fixed in `jobs/pit.js`: a block across a gap in the bot's own layer (a ledge or column the dig left, 3-14 blocks away, within 2 levels) is reached by a level bridge toward it (`gapOn` could not be used: it only sees void down to the world floor, a dug pit has rock far below); a block 3-12 levels straight under a bot standing on the last block of a column is reached by breaking that block (once per cell, health 14 or more, no fluid in the column) | `jobs/pit.js` (`bridgedFor`, `droppedFor`) |

**Measured (live pit j35, End, 20 bots, 2026-11-10 18:55-19:25).** The pushes did not stop: after the two fixes in point 5 the rate was about 120 an hour (10 kills, 4 falls in 7 minutes), against a target of 10. 10 of 14 were kills by errors; for 7 of 10 kills the bot's main failure was `unreachable` at `mine`, 2 at `station`, 1 `stuck` at `rise`. By distance: bots 24 levels or more above a block 6 blocks away (15 failures), 12 blocks away and 6 below (11), 18 away on the same level (9). The first cluster (6 blocks away on the same level, over a gap) disappeared after the bridge. **Open:** the bots that stand 24 levels above their work (on the surface of an undug chunk next to a chunk that was dug down) have no way down: no road (sweep jobs keep none), the corridor step refuses distances over its limit, a 24-level drop kills and the 12-level drop rule leaves them. One bot (`Work20`) was killed about once a minute for this. The pit needs a ramp or a staircase dug by the first bot of each chunk; until then the 60 s error kill fires on every such bot. A kill drops the bot's inventory unless the server keeps it (not checked).

**Tests.** `test_work_tempblocks_pure.js` (rules, registry, order, reserve, janitor), `test_work_force_pure.js` (decision, grace, errors, `isHigh`, health counter), three cases in `test_work_miner_pure.js` (bridge by distance and level, once per cell, none when too far; the drop under the feet). Four old expectations changed from the 16-block seal reserve to the 64-block stack (`test_work_pure`, `test_work_tools_pure`, `test_work_store_pure`, `test_work_fixes_pure`).

## v21 (2026-11-10 night, `TASK:20261110-058`): guard your post, a bot takes away only its own temporary blocks, bridges are taken away behind the bot, `descend`

Owner: bots interfere with each other (scaffolds destroyed under their placers, fall deaths, temporary blocks as many as the mined ones, place-and-break loops); the mining place is vague, everybody mines as they please; far too slow, too many deaths and stuck bots. Order of work: guard the post, destroy temporary blocks once passed, then a way down for bots stranded high.

| # | Cause found (live pit j35, 20 bots, 196 chunk regions) | What was built | Where |
| :-- | :-- | :-- | :-- |
| 1 | `Ledger.claim` took the region with the most work left (distance only as a 1e-3 tiebreak) and a bot kept its range only while it held a lease: bots such as Work3/16/11 claimed 6-10 different chunks, 100-150 blocks from where they stood (x -120 vs x 65), failed the walk back ("no leg of any length"), died, and took another far one | **Posts.** The nearest free range first (work left only as a tiebreak); a range has a `keeper` that is not taken by a bot without a post while the keeper is here (or left less than 3 minutes ago); only a bot whose own range is finished helps (nearest range with work), or any bot when nothing else is free; `homes()` / `adopt()` keep the posts across a restart (state.json `homes`). Measured after: one region per bot | `jobs/crew.js`, `service/index.js` |
| 2 | `Temps.view` gave every bot ALL pillar / scaffold / reflex blocks within 10 blocks, whoever placed them, and the worker's `cleanTemp` ran at every unit: bots broke the block another bot stood on or climbed (fall deaths), and walked to far leftovers (the loop) | A bot cleans **only its own** blocks; another bot's only when the placer is gone (offline or dead), the block is older than 20 s and no bot stands within 3 blocks (`Temps.mayClean`, `attach({alive, others})`); own leftovers only within 6 blocks, 6 a call, 3 tries a block. The seals and the water rescue are unchanged (their own cleanup) | `bot/temps.js`, `bot/moves.js` (`cleanTemp`), `service/index.js` |
| 3 | Bridge blocks were never registered or removed (the bridge "stays") | Registered as kind `bridge`; the bridge takes away the block it stood on one step ago, as the pillar does (`keep: true` for `workOver`, which walks back and takes them away on the way, `sneak_walk {unlay}`) | `bot/bridge.js` |
| 4 | Bots standing high on a leftover block or column "have no way down and no place to bridge to", then were killed | **`descend`**, the reverse of the pillar: a block is put blind into the cell two below the feet against the *underside* of the block the bot stands on (the body's `cell` frame now also works for `use`), that block under the feet is broken, the bot drops one block; the same block comes back with the dig; stops on the ground; never through natural ground (needs two cells of air under the support), never with fluid or an unloaded cell below. Used by the pit for a block 3 or more levels below within 6 blocks across, by `goToStation` (station 3 or more below, twice per walk), and by the escape ladder (`fix:descend` to the level of the last good place) | `bot/moves.js` (`descend`, `descendStep`), `skills/body.js`, `jobs/pit.js`, `bot/env.js` |

**Measured (j35, 20 bots).** Forced pushes (fall after 30 s still, kill after 60 s of errors): 181, 212, 261 an hour on the old build; 127 an hour after the posts and temp-block changes; **52 an hour** (7 in 8 minutes) after `descend`. Units finished: 8.9 a minute before, 10.7 after the posts, 19.2 after `descend` (8 rows, small sample). Router success (RL waypoint router, `src/experts/route`): 16 % (18:55-19:25), 43 % (21:00-22:14), 73 % (after the posts, 60 calls); the old legs fallback 0 of 14. The rise of the router rate coincides with the bots no longer being sent to far chunks (not proven to be the cause). Temporary blocks listed at 22:42: seal 79, pillar 34, rescue 18, bridge 14.

**Open.** 85 `unreachable` at `mine` in 8 minutes remain (bots at 12-15 blocks across and 6 below, beyond the bridge's 14 / `descend`'s 6 across); the forced kill still fires on such bots (52 an hour). The router chooses waypoints only; the failures were missing actions (down, bridge, place), not bad waypoints, so the next step for RL is `descend` / `bridge` / `pillar` as options in its simulator (a height field today: no overhangs, no other bots), compared with the heuristic there before any live use. A kill drops the bot's inventory unless the server keeps it (not checked).

**Tests.** `test_work_posts_pure.js` (nearest range, keeper, helpers, adopt), temps tests (own blocks, orphans, nobody near, placer alive), `test_work_moves_sim.js` (`descend`: 19 levels in the physics simulation, no refusals, no block left, count kept; `descendStep`), `test_work_miner_pure.js` (the pit calls `descend`: once per cell, not near, not across 7, not on natural ground).

## v23 (2026-11-11, `TASK:20261111-060`): the learned walk and the pit expert

Two new things in the work layer, both measured in their own documents: **[MOVE-v3](MOVE-v3.md)**, a learned cell-level walk (bridge, pillar, descend, dig, recover after a fall or a push) that `env.travel` tries first for targets within 48 blocks (setting `move3`, on; counters `move3` in the health row; old chain as fallback; 28/28 live worlds against 12/28 for the old chain), and **[PIT-EXPERT-v1](PIT-EXPERT-v1.md)**, the pit method `expert` (setting `pitExpert`, on for new pits: a unit is a band of two layers of a chunk, a scoring network picks where to stand, 32 blocks per station against 16, 621 s against 861 s on the same live arena). The in-game display of v22 is the third part of the task. A restart is needed to load them (the console mounts the repo); a running pit keeps the method it was created with.
