# SYNCMATICA-v1: Fabric mode, the Syncmatica wire protocol and the Litematica build pipeline

`TASK-20261117-070` (owner 2026-11-17). Litematica blueprints reach the bots through Syncmatica (the server-wide list of Litematica placements); the build job places them block by block with the states the blueprint asks for. Fabric and Forge are now two separate transports.

## Forge mode and Fabric mode

| | Forge (`src/transport/forge_bot.js`) | Fabric (`src/transport/fabric_bot.js`) |
| :-- | :-- | :-- |
| Server | Forge 1.20.1 | any Fabric server; the standing and T26 servers are 26.1.2 |
| Login | host marker `\0FML3\0`, login handshake proxy, registry sync, mod block table | the vanilla protocol, nothing else |
| Process-global patches | packet `restBuffer` bypasses, lenient NBT reader, chat hardening | none (a test fails if the module mentions them) |
| Version differences | fixed 1.20.1 | absorbed in the module: 26.1 item components (`fixDigTime`) |
| Extra | Ender Storage windows (`forge_windows.js`) | the Syncmatica client (`bot.syncmatica`, attached before the login) |

`src/transport/platform.js` decides: `MC_PLATFORM=forge|fabric`; without it `MC_FORGE=0` or an `MC_VERSION` other than 1.20.1 means Fabric (the old switches keep working). `src/transport/index.js` is the one entry point (`createBot`, `attachHandshake`); the callers use it. `SYNCMATICA=0` leaves the client off.

## The Syncmatica protocol (0.3.20, read from the mod's classes, golden packets from a live server)

One plugin channel, `syncmatica:main`. Its data is `utf("syncmatica:<type>")` followed by the body of the type. Fabric only sends a channel to a client that announced it (`minecraft:register`, `syncmatica:main\0`), which the client does in the configuration phase. Strings are varint-length UTF-8, UUIDs two big-endian longs, a BlockPos one packed long (x 26 bits, z 26, y 12), ints 4 bytes.

| Packet | Direction | Body |
| :-- | :-- | :-- |
| `register_version` | both | `utf` version (`0.3.20`); the server sends it first on join, the client answers |
| `feature_request` / `feature` | both | empty / `utf` feature names joined by `\n` (`CORE FEATURE MESSAGE CORE_EX VERSION DISPLAY_NAME`) |
| `confirm_user` | S to C | `int n`, n x metadata: the whole list |
| `register_metadata` | both | one metadata: a placement shared later (C to S: share) |
| `remove_syncmatic` | S to C | `UUID` |
| `modify` | S to C | `UUID`, position, then with CORE_EX `UUID`, `utf` of the last modifier |
| `request_download` | C to S (and S to C when sharing) | `UUID` |
| `send_litematic` | the side that has the file | `UUID`, `int len`, `len` bytes, 16384 per packet; the receiver answers `received_litematic UUID` after each chunk |
| `finished_litematic` | sender | `UUID`; the file's hash is `UUID.nameUUIDFromBytes(md5(file))`, checked by the receiver |
| `cancel_litematic`, `cancel_share`, `modify_*`, `mesage` | | not needed by a reader (`mesage` = `utf` type, `utf` text) |

metadata = `UUID id`, `utf fileName`, `UUID hash`, `[DISPLAY_NAME: utf name]`, `[CORE_EX: UUID owner, utf ownerName, UUID lastModifiedBy, utf name]`, `[VERSION: varint litematicVersion, varint dataVersion]`, position.
position = `BlockPos origin`, `utf dimension`, `int rotation` (NONE, CLOCKWISE_90, CLOCKWISE_180, COUNTERCLOCKWISE_90), `int mirror` (NONE, LEFT_RIGHT, FRONT_BACK), `[CORE_EX: int n, n x (utf subRegion, BlockPos, int rotation, int mirror)]`.

Code and tests: `src/transport/syncmatica.js` (`SyncmaticaClient`: `placements`, `fetch(id)`, `share({...})`, events `ready placement removed message`), `tests/test_syncmatica_pure.js` (golden packets captured from `fabric26-survival-op` on 2026-11-17: the owner's shared placement `easy-ironfarm`), probe `scripts/t26/syncmatica_probe.js`. The mod's server stores files in `/data/syncmatics` and the list in `world/syncmatica/placements.json`.

Servux (Litematica's other helper, `litematics` one-way paste, no placement query) is not used.

## From the file to the blocks

`src/work/jobs/litematic.js` reads the `.litematic` (gzip NBT, version 4..7): regions with negative sizes, palettes, the packed `BlockStates` (no padding across longs, `max(2, ceil(log2 palette))` bits), tile entities. `place(parsed, {pos, rotation, mirror})` applies a Syncmatica placement the way Litematica does (mirror first, then rotation, both about the placement origin) and returns the blueprint and the WORLD cell of its minimum corner. `materials(bp)` is the material list as Litematica counts it; the build plan adds buckets for fluid sources and waterlogged blocks (`build.materialsOf`).

## Placing a block with the state of the blueprint

A block's state after placement is a function of the clicked face, the height of the click on it and the player's look; the server takes face and click point from the packet and the look from the last look packet, so the bot can choose all of them. `src/work/jobs/orient.js` is a pure model of vanilla's `getStateForPlacement` per family (stairs, slabs, trapdoors, repeaters, hoppers, chests, pistons and the other facing-by-look blocks, fence gates, beds, doors, torches and signs standing or on a wall, redstone, logs, ladders) and `recipes(name, props, solid)` enumerates the contexts that give the wanted state. `place {x,y,z,item,recipe,block}` (`src/skills/commands/block.js`, `placeWithRecipe`) walks within reach of the support and clicks blind (Body frame `cell` with a `cursor`), the server checks the reach, not the line of sight. Properties the game derives (wall and wire connections, power, `lit`, `extended`, stair `shape`) are not compared; `open` and repeater `delay` are set by right-clicking afterwards.

`build.js` (the Build job) orders the cells bottom-up in one tile (`spec.tile` 64), inside a layer solid blocks first, then the ones that need a support (torches, signs, redstone, repeaters, doors), FLUIDS in a last pass (a source placed before its walls stand flows out), flows and the second half of a bed or door are never placed. A block with no neighbour to click against yet gets a temporary chain (`tempChain`, up to 16 cells, from the nearest clickable block, taken away at the layer change); a block that needs a support never uses one. After each placement the state is read back; a wrong one is dug out and tried with the next recipe. Water and lava sources: `pour {x,y,z,item}` (a real look ray: the server takes the target from it); waterlogged blocks get a bucket on the block itself. Materials come from tagged chests (purpose `free`/`any`) through the existing `missing_item` fetch script.

## The test `place_c`

`scripts/t26/place_c.js` (`scripts/t26/run.sh N place_c.js [LIMIT_MIN=90] [TRIALS=5]`): the owner's iron golem trap (`tests/fixtures/easy-ironfarm-fixd.litematic`, the owner's `E:\Minecraft JAVA\instances\fabric 26.3\instance\schematics\iron-farm\easy-ironfarm-fixd.litematic`) is shared through Syncmatica by one bot, the builder bot receives it from the server, builds it in the sky (box minimum at y 200 on a stone deck), from chests that hold every item of the plan's material list; survival, keep inventory, peaceful. The server compares the box with a reference copy that the harness makes by commands (`execute if blocks ... all`, air included); the empty site must not match. The report gives the strict verdict and a "static" one (same blocks and placement-decided properties; power, `lit` and similar may differ).

## The rewrite of 2026-11-18 (owner: "None of the know-how of my other mechanisms was reused": the build is a user of the same layers as the pit)

The first build (`build.js` with scaffolds, temporary chains, ledger layers, `place` walking by itself, supply by recovery script, server moves for supply trips) reached 445 of 1288 cells in 58 minutes. It is replaced by `src/work/builder/` (the old module `jobs/build.js` is a thin facade with the old API):

| file | job |
| :-- | :-- |
| `cells.js` | item, kind (block / attached / fluid / flow / derived), support, material list, state match (moved from the old file) |
| `order.js` | the order of placement: the structure is cut into one **area per bot** (slabs across the longer side, balanced by cells), each area is ordered lowest first, every level beginning at the middle of its area and then nearest next; a cell goes when one of its recipe supports stands; a floating piece (seed) starts with a plain block of its own piece; fluids wait for what holds their body (waterlogged blocks are sources too), and everything above a small body (the lava pit) waits for the source; then chunks of at most 24 nearby cells = units, and the units each waits for |
| `stations.js` | where a bot stands: `chooseStation` scores every feet cell within 5 of the next cell by the cells it serves (support face within 4.2 of the eye, a bucket within 3.4 with a clear ray to a solid face, from above) minus the cost of getting there (native: a walkable block under the feet; pillar / bridge: NAV leaves exactly one temporary block under the feet, which is also the support of a floating piece) |
| `run.js` | one unit: supply -> station -> `env.travel` (NAV) -> blind `place` with the recipe (the router once on a positional failure) -> state read back; `gateOf` (a unit is claimable when the cells it hangs on stand in the world, inside a start window of 14 units), `pickNear` (bottom-up window, then nearest) |
| `posts.js` | the bot's **post**: a bot takes a free area at its first claim and keeps it (it works nothing else while the area has work it can do); another area only when it has none, has finished its own, or waited 20 s, and only 14 or more blocks from the keeper; the area of a bot gone for 2 minutes goes to the next one that asks |
| `supply.js` | one `take_many` visit per chest, for the whole **run of units of the area that fit in the pack** (whole units, counted in slots: a bucket takes one slot per piece), made only when the unit at hand lacks something; all chests tried |

NAV got what it lacked: `descend` (place one under the temporary block, break the one under the feet: the reverse of a pillar; also from a bridge block placed at an edge, so a builder can always come down), a bridge when the ground is 4 to 8 below an edge (it was neither a drop nor a bridge: no move at all), never a temporary block into a cell of the structure (`keep`), never landing on a floor the action layer refuses (another bot's block), no pillar from another bot's block, a cheaper search (upward heuristic, foot-only pass of 3000 nodes) and `stuckAfter`. `moves.js` has `take_many`. The ledger has `gate`, `pick` and `release` (a unit that placed what it could is handed back, not failed). **No teleport**: `place_c` runs `TELEPORT=off` and fails a trial with any server move.

## Update 2026-11-18 (evening): areas, middle-first order, one trip per run, jump-place (owner's observation of the live builds)

The owner watched the builds and named four causes; each is a rule now (`TASK:20261117-070`, commit `4dd959fa`):

| Observation | Rule |
| :-- | :-- |
| Bots stall on their own bodies, most in tubes built upward (nothing to step aside to) | A block that goes on what is under the bot's feet is placed by a **jump**: look, jump, click at the top of the jump into the cell the feet left, land on the block (`block.js jumpPlace`, as the pillar does). `stations.js` serves the cell at the feet last from a native station (a column or tube stacked from its own top), and a station where the bot already stands needs no exit |
| Two of three bots froze at about 30 %: areas changed during the run (materials of the wrong place in the pack, the right ones short), and two bots built the same place | One **area per bot** (`order.js partition`, `posts.js`); the bot keeps it, carries the materials of that area only, and helps elsewhere only when finished, idle for 20 s or without an area, and then 14 or more blocks from the keeper; a bot that has left for 2 minutes hands its area on |
| The order began at the outermost part and built pieces apart that would be easy to place connected | Bottom-up; **every level starts at the middle of the area**, then the cell nearest the last one placed (a compact piece that grows). Rings of 3 or 6 blocks around the middle (the middle first on the whole level) cost 30 % more walking in the simulation and were dropped. Rule-based on purpose: the owner will let RL decide the order later |
| Build one small component, then fetch materials (5 s of placing, 30 s of walking) | **One trip per run**: `supply.batch` takes the items of the unit at hand and of the following units of the area, as many whole units as fit in the pack (slots, minus the tools and 3 spare); the trip is made only when the unit lacks something |

Simulation (`tests/test_build_plan_pure.js`, the iron farm, one simulated builder per area, blocks walked plus 2 per level): one area 185 stations / 2401 walked; three areas 224 stations in all, the busiest area 91 stations / 1509 walked, so a bot walks 40 % less than one builder alone; areas hold 475 / 353 / 460 cells. Offline only: the live result is below.

### Live results of the areas (T26 world 7, 3 bots, no teleport, 20 minutes, cells right as the bots see them)

| run | 2 min | 4 min | 8 min | 12 min | 16 min | 18 min | what it showed |
| :-- | --: | --: | --: | --: | --: | --: | :-- |
| 1 (areas, window as before) | 46 | 63 | 88 | 143 | 414 | 497 | bots took floating pieces (seeds) at once; one bot 495 s on a gate at the top; idle 30-57 % |
| 2 (seeds last, help after 6 s, unit budget) | 111 | 217 | 435 | 533 | 786 | 831 | a bot with a full pack failed `missing_item` for 10 minutes |
| 3 (+ surplus back to the chest, idle prefetch) | 157 | 391 | 536 | 609 | 780 | 851 | a bot stranded on a wall for 12 minutes (no move from its cell) |
| 4 (+ escape ladder) | 14 | 34 | 474 | 538 | 739 | 817 | the key unit of the tower failed at 17 s and nobody took it for 230 s |
| 5 (+ noShun, partial instead of failed, step off) | 225 | 406 | 594 | 817 | 900 | 918 | the tail: 18 pours into a flowing-water cell, floating pieces whose temporary support has no standing place |
| 6 (+ pour check) | 206 | 435 | 593 | 664 | 807 | 813 | a bot stood in a wall cell for 8 minutes, no edge within 3 below (the jump had placed a wall under its feet) |
| 7 (+ jump for full cubes only) | 162 | 435 | 604 | 733 | 766 | 785 | bots stranded on the wall lines between the water channels of the plate |
| 8 (+ step off onto stairs, shortest fall) | 226 | 450 | 539 | 563 | 589 | 591 | **worse**: the step off moved the three bots from one wall compartment into the next for ten minutes, so the escape ladder never reached its last rung |
| 9 (+ third strand within 4 min: descend) | 198 | 436 | 579 | 748 | 882 | 912 | no strand logged; the tail as in run 5 |

Old typical: 650-860 at 20 minutes, best 965 (18 minutes). The acceptance (the whole structure, strict or static, within 20 minutes) is **not met**: no run finished; the runs that held (5, 9) reach 912-918 of 1288 at 18 minutes, the others 785-851, and the variance between runs of the same code is about 10 %. What the four observations explain, and what is left:

- **Early phase 3 to 5 times faster**: 400-450 cells at 4 minutes, 540-600 at 6-8 minutes (before: 589 at 14 minutes at the best). Healthy units place 18 to 24 cells in 5 to 20 seconds (about 0.8 s a cell including the walk).
- **No bot frozen by the causes found**: a full pack (restock reported `free-slots 0`), a bot standing in a wall cell where the planner finds no move (`partial plan, 0 moves`), the key unit shunned after one failure, floating pieces taken at the start. Each of them cost one bot 8 to 12 minutes in a run.
- **Left**: the tail, from minute 10: stone-brick walls and glass at +13 to +21 levels, dirt columns that hang from a top arm tip, floating pieces whose temporary support has no standing place inside the walls (`no standing cell within reach ... (it is inside rock)`, parked as stuck), water cells that hold flowing water (level 1) beside a source, and the compartments of the plate (walls 1.5 high). There the cost is about 3.5 s of bot time a cell, which is 25 minutes for three bots even with no idle time. These are structure-specific cases, not a rule of the four observations; whether they can be closed within the 20 minutes is open (**not proven impossible**).
- Offline (`tests/test_build_plan_pure.js`): one builder alone walks 2401 blocks in 185 stations; with three areas the busiest area walks 1509 blocks (91 stations).

Ledger and timeline of a run: `scripts/t26/place_c.js` prints `[ledger log]` (who claimed what when) and `[units left]`; `BUILD_TRACE=1 NAV_TRACE=1` give per-unit and per-walk lines with seconds.

## The test `place_c` (rewritten)

`scripts/t26/run.sh N place_c.js [BOTS=3] [LIMIT_MIN=20 = 60 / BOTS] [TRIALS=1]` (`BUILD_TRACE=1 NAV_TRACE=1` for the per-unit and per-walk trace). The owner's bar: 80 % of the trials match AND the build takes at most one hour / bots. Offline: `tests/test_build_plan_pure.js` walks the plan with a simulated builder (1288 cells, about 170 stations); `scripts/t26/view_probe*.js` compare a bot's view with the server.

## Results of the rewrite (2026-11-18, T26 world 7, three bots, no teleport; run = 20 minutes)

| run | cells right at the end | what stopped it |
| :-- | --: | :-- |
| nb3 | 116 (4 min) | tower top: no move at all (ground 4-8 below the edge) |
| nb7 | 225 | waterlog pours "not confirmed": the bot compared a boolean property to the string `'true'` (the stairs were waterlogged on the server) |
| nb10-nb11 | 91-115 | an idle bot stood inside a cell of the ring: three others failed there; units that failed held the start window |
| nb12-nb13 | 268 / 236 | waterlogged stairs flooded the cells of walls built later (no containment); native stations in another compartment of the platform |
| nb15 | 589 (14 min) | bridges planned from a stair, a bot stood on another bot's leftover block |
| nb16 | 395 | livelock: 600 zero-second "wait" cycles for a place held by a stopped bot; three bots each took all 24 stairs |
| nb17 | 619 (12 min, 50 cells a minute at the best) | bots standing on each other's leftover temporary blocks; stations walled off |

| nb18-nb19 | 619 / 688 | units stuck behind a blocked start window (all bots idle); wall compartments |
| nb20 | **965 (18 min)** | water pours from under the platform, waterlog without a ray, a few stuck units at the top |
| nb21-nb25 | 731 / 645 / 686 / 862 / 863 | a top unit that failed (trapdoor right-click) held up the dirt columns that hang from it; no standing place from inside a compartment; temp support against a non-solid block |
| nb26 (45 min limit) | 744 at 30 min | the same build, slower (variance 550 .. 800 cells at 16 min between runs of the same code) |

**State at the end of the session: the acceptance is NOT met.** 0 of 26 full runs finished the structure; the best is 965 of 1288 cells in 18 minutes with three bots and no server move (the old best: 445 cells in 58 minutes), typically 650 to 860 cells at 20 minutes. Fluids (36 sources, 12 waterlogged blocks), the lava, the repeaters and the beds have been placed live in the tail tests (`PREFILL=980`) only in part; the strict / static verdict was never reached. What is known to cost time: stuck units hold what hangs on them (the dirt columns hang from a top arm tip), compartments of the platform, supply trips from the platform (a descent and a climb each), run-to-run variance of 40 %.

(The old best: 445 cells in 58 minutes.)

## Results of the first build (2026-11-17, superseded by the rewrite above)

**The acceptance (five builds of the iron golem trap, 50 % must match) is NOT met: no build was finished. Best state: 62 of 1282 cells right after 4 minutes with two builders, then a stall (below).** What was verified and what was not:

| | Status |
| :-- | :-- |
| Fabric transport without handshake, bypasses or chat hardening | works: every bot of every run logged in and ran on 26.1; `tests/test_transport_platform_pure.js` |
| Syncmatica handshake, list and download against the owner's real server (`fabric26-survival-op`, placement `easy-ironfarm` at 319 65 247, the older 6394-byte file) | works, hash checked, file parsed (45 x 23 x 44, 5440 blocks); golden packets in the test |
| Syncmatica share (upload) and the announcement to another bot, on world 7 | works (`place_c`: the sharer uploads, the builder gets `register_metadata`, downloads, hash ok, parses, places); a file the server already holds is not requested again (`share` resolves on its own idle timer) |
| `.litematic` reader, material list, placement with rotation / mirror | unit-tested; the owner's `easy-ironfarm-fixd.litematic`: 45 x 23 x 46, 1514 blocks, 19 item types (+ 36 water and 1 lava bucket for 1 + 36 fluid sources and waterlogged stairs) |
| Build with block states (recipes), fluids last, temporary chains, state check | the simulated-server test builds the whole structure (every buildable cell right, fluids last, no temporary block left, `tests/test_build_litematic_pure.js`); live: the first layers are placed right (62 cells, signs, hoppers, chests ...) |
| Supply from tagged chests | works (`fetch-item` takes from the `free` chests); fixed along the way: `withdraw` took one item at a time when a chest held fewer than a stack and then gave up (now takes what there is) |
| Fluids (`pour`), waterlogging, repeater delay by right-click, beds, redstone / piston states, the composter | NOT reached live (the build stalls in the first layers); only the simulator exercises them |

**Review 2026-11-17 (owner: "no defect in the blueprint, the system is fragile"):** see LESSONS L20 for the sign experiment (the server refuses a sign on a sign; a sign placed against a temporary block pops when it is removed). Found and fixed since: the placement model for signs and torches (a side face gives the wall variant), the order of placement (a growth order: every cell next to something that stands; temporary chains 87 -> 32 and temporary blocks 151 -> 64 in the simulation, the floating components and the corner marker glass 21 up remain), the walker's drop limit (3 -> 8 for a build bot: it stranded on its own floating blocks), supply trips by NAV. Live (run `pc19`): 60 of 1282 cells after 4 minutes, then no progress for 14 minutes: temporary supports high above the deck are refused with `unreachable: no standing cell within reach of the target` (the bot cannot stand near a cell it must support), 12 parked units.

**Update 2026-11-18 (owner: signs hang on signs with a SNEAKED click, the blueprint is fine; ignore nothing, run it end to end).** Right: a plain click on a sign opens its editor; `isInteractive` now includes signs, so the recipe click is sneaked, `plan.unbuildable` is empty for the iron farm (nine signs, material list 9 oak_sign) and attached blocks are ordered after their support (a wall sign after the block behind it, which for six of them is another sign). Not yet confirmed live that the server accepts the sneaked sign-on-sign click (the first rows of signs were not reached in the runs below). Fixed since, each found in a live run: the pillar jumped off-centre and its head brushed the next column (`pillar_jump stuck` 30 times); temporary blocks are removed blind and not collected (`collect_drop` and `dig` were most of the bots' time); the walker stranded on its own floating blocks (drop limit 8 for a build bot); supply trips by NAV and, at height, by a server move (`teleport: near` in `place_c`, counted as `serverMoves`: the walk down from a platform 12 above the deck does not exist); supply twice the list plus 1024 cobblestone (three builders each took a stack and starved the others).
**Live result, T26 world 7, three builders, runs `pc25`..`pc29`: still no finished build.** Best: 445 of 1288 cells right after 58 minutes (`pc27`); the rate was 10 to 14 cells a minute for the first 40 minutes and fell when the work moved to the platform at height 11 to 14 (bots idle at the phase gates, units parked with `unreachable: no standing cell within reach of the target`, a router `stuck` at a wall block of the platform). One builder fell off the deck into the ocean (140 blocks) in `pc25`. Open, in order: (1) reaching cells at height 10+ (the two dirt ramps, the platform arms): the NAV fallback fails and its reason was only just put into the unit detail (`detail.nav`); (2) idle bots at phase gates; (3) falls off the deck edge; (4) fluids, waterlogging, redstone states, signs on signs never reached live.

**(Superseded by the update above) The iron farm cannot be built exactly in survival (as measured): six `oak_wall_sign` cells (a 3 x 3 block of wall signs, 3 x 2 of them hung on other wall signs) have no support the game accepts** (LESSONS L20). The plan reports them (`plan.unbuildable`) and the reference copy of `place_c` leaves them out. Say this to the owner: with these cells the file is not buildable by survival means at all, whatever the bots do.

Causes found and fixed during the runs (each in a commit): the "needs a support" rule matched trapdoors (`door$`); attached blocks were ordered per row, not per height (a torch hangs on a block of the next row); a cleanup mined the structure's own block where a temporary one had been; `place` refused any block over a chest the bot had placed; a wall top could not carry a torch; the planner had no chain for a lone block 21 cells up (the corner marker); containers were approached by the on-foot command only.

**Open, in the order that blocks most:**
1. **The builder strands itself.** A floating component (the dirt fragments of the cut terrain at height 3) is reached over a temporary pillar; after the temporary blocks are taken away the bot stands on the floating block, 5 above the deck, and the NAV planner finds no way down (`unreachable {goal: reach block, expanded: 8}`), so the next supply trip fails and the worker waits for an item that is in a chest. Needed: a descent that places its own temporary stair (or the pillar is kept until the bot is down), or a bot that never leaves the ground for these cells (place from a pillar beside, then climb down it).
2. **Speed.** The first layers (many small floating pieces, each with a temporary chain that is built, climbed and dug up) ran at 5 to 10 cells a minute; a whole structure is hours for one bot, five trials tens of hours. `BOTS=n` builders on one job is in the harness (the ledger shares the rows) but was not measured past two bots.
3. Fluids, waterlogging and the circuit's derived states (see the table) have not been seen live.

Run: `scripts/t26/up.sh 7 --new` then `scripts/t26/run.sh 7 place_c.js LIMIT_MIN=240 TRIALS=5 BOTS=3`; read `[progress N min]` lines (the bot's own view, a diagnostic) and the report in `/mnt/data/forgeaip-play/t26/out/<RUN>/place_c-w7.json` (strict and static verdicts, differing cells, `unbuildable`, problems).
