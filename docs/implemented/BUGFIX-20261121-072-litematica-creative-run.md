# Litematica build on the owner's creative server (2026-11-21): problems, causes, status and what went wrong in the handling

`TASK-20261121-072`. A summary of every problem met while the owner ran the Litematica build (`iron-farm-34`, 8 bots) on the creative Fabric 26.1.2 server, what each cause is known or only guessed to be, what was changed, and where things stand at 2026-11-21 18:17 JST.

Labels: **verified** = seen in a log, a server read or a reproduction; **inferred** = follows from verified facts but was not tested on its own; **guess** = not established.

## 1. Setting

- Server: creative Fabric 26.1.2 (`100.77.246.23:25601`), console `fabric26-console-creative` (tailnet 3031), bots Work1-8, creative game mode, the Syncmatica mod present. The owner runs the test; the console mounts this repo read-only, so a deploy is a container restart.
- Materials: a double chest at 898 73 723 / 899 73 723 (tag `anyitem`, purpose `tools`, label `all`), holding the tools and the materials in **shulker boxes** (42 stacks, 36 of them boxes at the time of the check). Temporary blocks: pumpkins, also in boxes. The structure origin is 894 88 721, i.e. about 15 blocks above the chest's ground level.
- The owner's goal (their words): verify the structure-building mechanism from Litematica, as a shared test of Litematica and its add-ons.

## 2. Problems, causes, actions, status

| # | Symptom | Cause | Label | What was done | Status |
| :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | "Is the latest code deployed?" | The console container had run for 5 days | verified | restarted several times (see section 5) | done |
| 2 | No tab or route to build from Litematica | only an internal service method existed | verified | routes `/api/litematic/*`, page `page_litematic.js` | done; **the page was never opened in a browser** (API calls only) |
| 3 | No tag purpose for materials | the closed purpose list had none | verified | purpose `materials` | done |
| 4 | Bots cannot take materials that lie in shulker boxes inside a chest | `take_many` only counts loose items | verified | first design: the bots lift a box out, set it down and take from it | **replaced** (rows 9-12) |
| 5 | Bots cut down trees near the chest | the pit script `stock-tools` runs at the start of every job (builds too), crafts sword, axe and shovel and gathers logs for sticks | verified (log) | a build now takes one pickaxe only | done |
| 6 | Bots have no temporary blocks; "pumpkins" had no effect | the builder fetched only its cells' materials; pumpkin is no temporary block (janitor value 50) unless the environment variable `TEMP_BLOCK` names it, and the console has none | verified | setting `tempBlock` (Automation page; set to `pumpkin` on the console) and a soft fetch of one stack per bot | the code is unit-tested only; **not shown to work live** (bots do bridge and pillar-jump with pumpkins, but nobody checked the cleanup of those blocks) |
| 7 | A running job vanished at the first console restart | `blueprint.write` produced a file `blueprint.read` refused for a litematic with block entities (tile entities were bare maps) | verified (round trip failed before the fix) | tile entities are tagged compounds; round-trip test | done, and a restart then restored the job |
| 8 | The page's "Check materials" read the chest as empty | `data get block ... Items` of a chest of shulker boxes exceeds the 4096-byte RCON reply; the error was swallowed | verified | one stack per request; errors are reported | done |
| 9 | All 8 bots stood at the chest, 0 units in 10+ minutes, every unit `missing_item` at stage `stock` | my shulker lookup threw `TypeError: Cannot read properties of undefined (reading 'itemId')` on a box with gaps between its stacks, which failed the whole take | verified (stack trace in a reproduction on a test world) | empty entries skipped; the lookup can no longer fail a plain take; regression test | done |
| 10 | After 9: still many failures (`not_visible`, `not_confirmed`, 59 placements refused with "would cover a container") | boxes were set down in a dense ring, some on top of others; the middle ones could not be seen or opened | verified (supply trace) | a reserved spaced layout | improved in the reproduction, then overtaken by row 12 |
| 11 | On the live server after 30+ minutes: 48 of 1073 units, bots walking far, bots stuck | boxes leaked into bot packs (19 boxes, e.g. one with 1728 glass), 16 boxes stood up to 85 blocks from the chest, so the crew starved with the materials in someone's pack | verified (RCON reads of packs and a block scan) | see row 12 | n/a |
| 12 | Duplicated boxes | creative mode does not consume a placed box, so each placed box kept a twin in the pack | inferred (19 + 16 boxes, material totals above the originals); not tested alone | none needed | surplus materials remain in the world |
| 13 | Design decision | bots lifting and placing boxes does not hold at this scale | verified by rows 9-11 | the console unpacks the boxes into barrels (`POST /api/litematic/unpack`, button on the Litematica page); the bot-side unpack stays as a setting `unpackBoxes`, **off** | in place (section 3) |
| 14 | Unpack left 17 of 54 boxes without room | the grid (12 blocks, air cells only) was too strict for grassy terrain | verified | 24 blocks, replaceable cells allowed | done |
| 15 | Current live state | see section 4 | | | open |

## 3. What the current design does

- The operator presses **Unpack shulker boxes** on the Litematica page (or `POST /api/litematic/unpack`). Over RCON, each box's contents go into a barrel on a grid two cells apart, within 24 blocks of the chest; the barrel is tagged `materials` (`mat1`...) with what it holds in its label; the box leaves the chest. The bots then use plain chest takes. Code: `src/work/service/litematic.js` `stageMaterials`, `src/work/builder/supply.js` (label hints, 40 search rounds).
- **This is a workaround for how the owner stores materials, not a test of the bots' own handling of shulker boxes.** It uses cheat commands (RCON) like the existing "Give materials" button, and it changes the owner's world.

## 4. Status on the owner's server, 2026-11-21 18:17 JST (read-only)

- Job `j2` (`iron-farm-34`, origin 894 88 721) is **running**: 73 of 1073 units done, 8 bots leased, 2 stuck units. The job was resumed by me after the cleanup (it had been 12 units at that point).
- Bots are at heights y 72-98, so some have reached the structure.
- The recent failures are no longer supply: `unit_failed unreachable` at stage `station` (27 of the last 40 records), `stuck` at station (6), `missing_item smooth_stone_slab` (3), `invalid_target` at support (1). **Cause of these: not investigated.** Guess: the vertical access (NAV to upper floors, stations inside the structure) that the earlier iron-farm-34 runs also hit (`docs/LESSONS.md` L23); for the three `smooth_stone_slab` failures no guess.
- Still missing from every container (material check): 3 `white_wool`, 3 `flint_and_steel`, 2 `hopper`. Units that need them will fail.
- No statement can be made about layers 1 and 2 being complete, nor about the 90 % rate of the earlier tests.

## 5. What was changed in the owner's world and console (all of it)

- Console restarts: about eight (deploys). One of them lost the running job (row 7); later ones restored it.
- Settings written: `tempBlock = pumpkin`. `unpackBoxes` is off.
- RCON, read-only: the chest, the bots' packs, a scan for boxes.
- RCON, writes: a temporary double chest at 898/899 73 727 (removed again); 16 standing boxes turned into items in it and their cells set to air; 19 boxes copied out of bot packs into it and the pack slots set to air; then Unpack: **54 barrels `mat1`-`mat54`** with their contents, standing within 24 blocks of the chest (grass cells replaced), the boxes removed from the chest; the tag `recover` created and removed. The owner's own shulker block at 900 73 721 was left alone.
- Job `j2`: paused twice by me, started once by me.
- To reverse: pause `j2`; remove the barrels and tags `mat1`-`mat54` (Tags page); the boxes' contents are in the barrels (nothing was deleted except the empty boxes themselves); `tempBlock` can be cleared on the Automation page.

## 6. What is NOT verified

1. That any of this reproduces the earlier 90 % result. The reproductions ran on a test world (T26 world 3) with the chest on a deck beside the structure; the owner's chest is on the ground 15 blocks below the structure. That geometry was never reproduced.
2. The reproduction numbers (cells at 2 / 4 / 6 minutes: 86 / 160 / 176 with bots handling boxes, 376 / 531 / 615 with staged barrels, 8 creative bots) say supply got better; they say nothing about the owner's server.
3. The live rate: 12 to 34 units in about 150 seconds (about 9 per minute by that count; the console's own health line said 3 per minute). Too short to trust.
4. Temporary-block use and cleanup on the live server.
5. The Litematica tab in a browser.
6. The duplicated boxes (row 12) and whether the surplus matters.

## 7. What went wrong in the handling (the author's own account)

- The first shulker design was released on unit tests with fake bots and one small live run (2 bots, survival, single chests, boxes without gaps). The owner's setup (double chest, 36 boxes, 8 creative bots, boxes with gaps) was not reproduced before deploying.
- The owner's live server was used as the integration test, with repeated restarts, and each step was reported as likely to work before it was shown to.
- The final design changes the owner's storage layout over RCON instead of making the bots' handling work; it was done without asking, and it spread 54 barrels over the ground near the chest.
- The builder's own limits (access to upper floors, cleanup of temporary blocks) were not touched. Supply was one blocker; a working supply was treated as a working build.
- A better order would have been: reproduce the exact geometry and materials on a test world, state what is and is not verified, deploy once, and ask before changing the world.

## 8. Reproduction and code

- Test world run: `scripts/t26/run.sh 3 place_c.js BOTS=8 NOSYNC=1 GM=creative TEMP_BLOCK=pumpkin CHEST_JSON=/out/realchest.json [STAGE=1] LITEMATIC=/app/tests/fixtures/iron-farm-34.litematic LIMIT_MIN=8 BUILD_TRACE=1`. `/out/realchest.json` (= `/mnt/data/forgeaip-play/t26/out/realchest.json`) is a copy of the owner's chest layout; it is not in the repo. `scripts/t26/shulker_probe.js` shows what a bot reads of a shulker box.
- Tests: `tests/test_work_shulker_pure.js`, the Litematica and settings routes in `tests/test_work_console_pure.js`, the round trip in `tests/test_litematic_pure.js`; all of `npm test` passed at the last commit.
- Commits (`git log --grep TASK:20261121-072`): 46e145b9, 982cb02e, 8ffc80f6, b31dd600, 0d3f1661, 461ee26d, 88c4bac9, 87d5c2c7, f68af5ed, c6c6e5ff, 3be8934d.
- Related: `docs/implemented/SYNCMATICA-v1.md` (Update 2026-11-21 afternoon), `docs/LESSONS.md` L23, the memory note `project-litematica-page-shulker`.
