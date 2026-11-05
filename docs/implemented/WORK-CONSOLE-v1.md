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

A first session: **Bots** → batch of 4 → **Kit**; **Pits** → corner A = player (stand there), corner B = player, top = ground, depth 3 →
Create and start; **Structures** → upload or generate a house, rotate, **Build** → origin = player, y = ground → Create and start (Give
materials first if the bots hold nothing). Auto-kit (Bots) tops up pickaxes before every start.

## Limits seen, and what is not done

- Block *properties* are not reproduced by the bots (stairs, slabs, logs, doors come out as a click places them); the editor keeps them in
  the file and the diff compares names only. Next: property-aware placing (click height for slabs and stairs, face for logs).
- The pit does not remove its haul road; no drop sweep; lava lakes and caves below the floor are not planned for (WORKERS-v1 "Tasks that follow").
- A bot that fails three units in a row retires with the reason (`missing_tool`, `missing_item oak_planks`, `stuck`) and the job goes on with the others; with auto-kit it is restocked and continues (at most 5 times in a row), otherwise **Kit** / **Give materials** and **Resume**. A job whose bots are all retired shows `blocked`.
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
