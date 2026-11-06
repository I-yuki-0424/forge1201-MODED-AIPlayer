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
  request through that name; a valid assertion also signs the owner in without the token. The token login stays for loopback and the tailnet.
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

### In-game display (particles, no mod)

Page Automation, panel "In-game display" (switches for all, paths, mining divisions, tags; default all on). Every 1.5 s the overlay (`display/overlay.js`) draws up to 160
dust particles with `particle minecraft:dust r g b size x y z 0 0 0 0 1 force @a[tag=aip_see]`: each bot's planned walk (the planner's cells from the `walk` phase,
only the part ahead of the bot, a large mark on the destination, one colour per bot), each pit lane outlined at the rim and at the layer it is digging now with corner
posts between them (one colour per lane; a build job as a box), and a short column over every tagged block with a dotted line from a machine to its container. Viewers are
the players who are not bots and stand in the overworld; the overlay tags them `aip_see` itself (one selector, one command per particle) and draws nothing when nobody
watches, when a shape is more than 180 blocks from every viewer, or when the RCON queue is more than two commands behind (decoration never delays the bots). Measured on the
demo server: a frame of 41 particles took 19 ms, the slowest command 2 ms.
**Why not an auxiliary mod:** a mod that draws real lines needs Java and a build per Forge version and must be installed on every player's PC, and Forge refuses a client
whose content mods differ; particles show on any client with no install, cover the two things asked for (paths, divisions) and cost 3 small files. The cost is looks:
dust fades, lines are dotted, thin at distance. If real lines are wanted later the data (`displayState()`) is already what a client mod would draw.
Not verified: how it looks in a real client (no client here, only the server's replies: every command is accepted). Hook: the action layer's `Ctx.phase` calls `bot.__onPhase`
when a bot has one set (only the work service sets it; RL bots never do).

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

## Security basis (the console can reach RCON and control bots, so it is an administrative interface)

- Not an extension of the old unauthenticated WebUI (docs/LESSONS.md L3), which stays on loopback and unchanged.
- Random access token in `console-data/console.token` (mode 0600, never logged, never in a URL); `POST /api/login` exchanges it for an
  HttpOnly `SameSite=Strict` session cookie (12 h) and a CSRF value; failed logins are throttled (8 per address per 10 min).
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

From the PC (PowerShell, no elevation): `scp vps:/mnt/data/forgeaip-play/console-data/console.token $HOME\Downloads\`, then open
`http://100.77.246.23:3021` (Tailscale connected) and paste the token. If the tailnet route is missing, or the PC cannot reach it: an SSH
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
