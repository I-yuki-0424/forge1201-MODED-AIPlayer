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

## Results (2026-11-17, T26 world 7, Fabric 26.1.2 with Syncmatica 0.3.20)

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

**The iron farm cannot be built exactly in survival: six `oak_wall_sign` cells (a 3 x 3 block of wall signs, 3 x 2 of them hung on other wall signs) have no support the game accepts** (LESSONS L20). The plan reports them (`plan.unbuildable`) and the reference copy of `place_c` leaves them out. Say this to the owner: with these cells the file is not buildable by survival means at all, whatever the bots do.

Causes found and fixed during the runs (each in a commit): the "needs a support" rule matched trapdoors (`door$`); attached blocks were ordered per row, not per height (a torch hangs on a block of the next row); a cleanup mined the structure's own block where a temporary one had been; `place` refused any block over a chest the bot had placed; a wall top could not carry a torch; the planner had no chain for a lone block 21 cells up (the corner marker); containers were approached by the on-foot command only.

**Open, in the order that blocks most:**
1. **The builder strands itself.** A floating component (the dirt fragments of the cut terrain at height 3) is reached over a temporary pillar; after the temporary blocks are taken away the bot stands on the floating block, 5 above the deck, and the NAV planner finds no way down (`unreachable {goal: reach block, expanded: 8}`), so the next supply trip fails and the worker waits for an item that is in a chest. Needed: a descent that places its own temporary stair (or the pillar is kept until the bot is down), or a bot that never leaves the ground for these cells (place from a pillar beside, then climb down it).
2. **Speed.** The first layers (many small floating pieces, each with a temporary chain that is built, climbed and dug up) ran at 5 to 10 cells a minute; a whole structure is hours for one bot, five trials tens of hours. `BOTS=n` builders on one job is in the harness (the ledger shares the rows) but was not measured past two bots.
3. Fluids, waterlogging and the circuit's derived states (see the table) have not been seen live.

Run: `scripts/t26/up.sh 7 --new` then `scripts/t26/run.sh 7 place_c.js LIMIT_MIN=240 TRIALS=5 BOTS=3`; read `[progress N min]` lines (the bot's own view, a diagnostic) and the report in `/mnt/data/forgeaip-play/t26/out/<RUN>/place_c-w7.json` (strict and static verdicts, differing cells, `unbuildable`, problems).
