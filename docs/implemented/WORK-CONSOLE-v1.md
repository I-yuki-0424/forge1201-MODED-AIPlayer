# Work console v1: pure bots on the play world, with a web page to run them

`TASK-20261105-034` (2026-11-05). Owner brief: bring the bot system to the play world (the server on tailnet port 25566), start
testing the pure-bot features of [WORKERS-v1](../proposed/WORKERS-v1.md), decide whether the aux mod is still needed, and get a
management UI: designate open-pit areas, add and remove bots, edit structure NBT to make structural parts and build them.
Code: `src/work/{service,console,blueprint}.js`, `public/work/`. Tests: `tests/test_work_{service,console}_pure.js`,
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
- **Structure library and editor** (`src/work/blueprint.js`). Upload a structure `.nbt` (structure block or Create schematic), see its size,
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
  drawn from the world's region files (`src/work/mca.js`, read-only mount of the server volume at `/world`): top block per column at the
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
  arguments (`src/work/catalog.js`, schemas taken from `src/skills/index.js`). The page builds a form from it: grouped dropdown, direction and
  slope selects, coordinate fields with **operator / bot / map** helpers (the map helper also reads the ground height), a nearby-entity
  dropdown for attack/pickup/look_at, item fields with a list of what the bot carries. Targets: **All bots**, **Selected (n)**, or one bot.
  Bots run in parallel, each on its own; the answer says who started and who refused (busy, working on a job, offline, bad argument) and
  the per-bot result stays in the table (`cmd`) and in History. A bot working on a job refuses commands (pause the job first); **Stop** cancels.
  Why the earlier "commands" did nothing: there was no command interface in the console (only the old WebUI's chat commands); this is it.
- **Inventory GUI.** Two panes (operator, a bot, or a container block) with slot grids (armour/off hand, 3 × 9, hotbar; containers 9 per
  row). Drag a stack to a free slot of the other side, or double-click for the first free slot; **Move all**. The move is
  `item replace <dst> from <src>` followed by clearing the source, so the stack keeps its NBT and nothing is created; the destination slot is
  re-read first and must be empty. Containers: coordinates, or "find near a bot" (blocks in the chunks a bot has loaded). Players are read with
  `data get entity` (`src/work/snbt.js` parses the reply), so a bot's inventory and the operator's are handled the same way.
- **Look.** Left navigation, stat tiles with sparklines, panels with header strips, dense tables, status dots and pills, light and dark by the
  browser's setting (Grafana's panel layout and the AWS console's filter-table-detail pattern).
- **Public name.** `WORK_PUBLIC_HOST` (e.g. `bots.i-yuki.com`) makes the console require a valid Cloudflare Access assertion
  (`Cf-Access-Jwt-Assertion`: RS256 against the team's keys, issuer, audience, expiry, optional e-mail list; `src/work/access.js`) on every
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
- **`gather {target, count?, radius?}`** (Blocks group; `src/work/gather.js`). `target` is a block or an item name: `iron_ore`, `raw_iron`,
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
