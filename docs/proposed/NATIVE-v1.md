# NATIVE-v1: the bot's own player physics, inventory and container contents instead of mineflayer's (stage A, offline)

`TASK-20261125-076` (owner list 5, Large 4 and Large 3.4; contract in [OWNER-LIST-5](OWNER-LIST-5.md)). Stage A (2026-11-26): the dependence measured, the native physics, inventory
and the container instruction built and tested offline, nothing wired into the transport yet. Stage B (after TASK-074's transport is on `main`, world slot 7) wires them as
the default with a switch back, runs the live comparisons and moves this file to `docs/implemented/`.

## 1. What still comes from mineflayer (measured 2026-11-25, the bot path: everything but the legacy `bot_actuator.js` / `src/actuator/`)

The owner's belief: only inventory handling and physics simulation still come from mineflayer. **Corrected:** movement and placement decisions are the repository's own
(the body sends `block_dig` / `block_place` itself), but the world and chunk state, entities, block data (collision shapes, dig time), recipes, chat, the item codec and the
physics loop's position packets also come from mineflayer / prismarine. Counted with grep over `src/` (lines / files):

| Area | Module | Uses on the bot path | Decision |
| :-- | :-- | :-- | :-- |
| Wire format, login, compression | minecraft-protocol | every packet | **keep**: it is the protocol; version data, not behaviour |
| Version data | minecraft-data, prismarine-registry | registries, shapes, items, attributes | **keep**: data; every native module reads the connected version's data from it |
| Player physics | mineflayer `physics` plugin + prismarine-physics | `bot.physics.simulatePlayer` every tick (1 file + the fall guard's wrapper), `physicsEnabled` (rl/env.js) | **ported** (`src/native/physics`); the plugin's tick loop and its position / look packets stay (they are protocol: the 1.21.2+ flags of the move packets) |
| Inventory and windows | mineflayer `inventory` plugin, prismarine-windows | `bot.inventory` 93 / 31, `clickWindow` 8 / 4, `currentWindow` 11 / 4, `openContainer` / `openBlock` / `openFurnace` 6 / 3, `equip` 6 / 2, `toss*` 3 / 2, `setQuickBarSlot`, `heldItem` 20 / 9 | **ported** (`src/native/inventory`); stage B: `bot.inventory`'s read API stays as a view fed by the native state (93 call sites unchanged), the clicks and screen helpers go native |
| Item stacks | prismarine-item | the slot codec (components) | **keep** as the item wire codec; native code uses its own stacks `{name, count, comp}` |
| Recipes | prismarine-recipe (`recipesFor` / `recipesAll` 8 / 4, `bot.craft` 1) | `craft`, `stack/obtain.js`, `rl/skill_space.js`, `work/bot/env.js` | **later**: recipes are data; `bot.craft`'s click sequence becomes native clicks after wiring |
| World and chunks | prismarine-chunk, mineflayer `blocks` plugin (`blockAt` 114 / 28, `bot.world`, `findBlocks`) | everywhere | **keep for now**: chunk parsing is the chunk packet's wire format; the repository already reads states itself (`skills/world.js`) |
| Block data | prismarine-block (`shapes`, properties, `digTime` 12 / 6) | body, block.js, build/move.js, 26.1 patch in fabric_bot.js | shapes **keep** (data); `digTime` **later, small** (vanilla getDestroyProgress; already patched once for 26.1 item components) |
| Entities, health, food | mineflayer `entities`, `health` plugins (34 / 18, 40 / 21) | reflexes, attack, router targets | **keep**: protocol state tracking |
| Chat | mineflayer `chat` (7 / 5) | reports, `say` | **keep**: protocol (signing, 1.19+) |
| Use / attack / swing | `activateItem`, `useOn`, `attack`, `swingArm` (19 / 6) | body, reflexes | **keep**: one packet each; **later** trivial |
| Digging, placing outside the body | `bot.dig` (work/service/force.js), `placeBlock` (work/bot/reflex.js), `activateBlock` (work/bot/bed.js) | three places | **later**: move to the body's own packets |
| Pathfinder, collectblock | mineflayer-pathfinder, mineflayer-collectblock | `mod_interaction_executor.js` and the legacy actuator only | not on the bot path |

Why JavaScript and not Rust (the owner's "Rust by default"): the physics runs once per tick inside the existing Node bot process (20 bots in one console process) and the
consoles mount the main checkout read-only without a build step; a native addon or a sidecar process would add a build, a binary per platform and an IPC hop per tick for
about 0.1-0.2 ms of work (078 measured 108-187 us per bot tick for client physics). The Rust simulator (`tools/sim`, TASK-078) shares the trace format below.

## 2. Native physics (`src/native/physics`, 42 tests in `tests/test_native_physics_pure.js`)

One client tick in the game's own call order (`player.js`): `Entity.baseTick` (fluid heights, currents, lava, eyes in water, swimming), `LocalPlayer.aiStep` (keys to
impulses, sneak and item-use factors, sprint start / stop), `LivingEntity.aiStep` (tiny speeds to zero, ground / water / lava jump, x 0.98, `travel`), `travel` (water,
lava, ground and air branches; `moveRelative` with the 65536-step sine table; climbing; friction; gravity), `Entity.move` (stuck-in-block factor, sneak edge back-off,
`collide` with step-up, collision flags, supporting block, fall distance, landing on slime / beds, slime `stepOn`, inside-block effects, speed factor) and the pose
(standing 1.8, crouching 1.5, swimming 0.6). Floats where the game declares floats (`Math.fround`). Version differences are data (`versions.js`, by data version): the
sneak-edge probe (1.20.5), the jump that keeps upward speed (1.20.5), attribute modifier ids (1.20.5), step-up candidates (1.21.2), double-argument sine (1.21.2),
normalised input (1.21.5).

Interface: `Physics(registry).simulatePlayer(state, world)` takes and returns mineflayer's `PlayerState`, so mineflayer's physics loop, the fall guard
(`src/build/fallguard.js` wraps this function; tested on top of it) and the simulators run on it unchanged. What `PlayerState` does not carry (fall distance, pose,
sprinting, swimming, eyes in water, supporting block, stuck factor) is kept per physics object (one per bot). `install(bot)` puts it under a mineflayer bot,
`restore()` puts mineflayer's back.

Measured differences from prismarine-physics (each a test): collision axis order (Z before X when |x| < |z|), the crouching box 1.5 high (passes under a 1.5 gap),
the sine table (headings differ by up to 2 pi / 65536), soul sand and trapdoor ladders on 1.21 (prismarine's feature table drops both for 1.21), honey jump factor 0.5
(prismarine 0.4), cave / weeping / twisting vines climbable, powder snow (sinking without leather boots, the falling shape), scaffolding (stand on top, sneak down, climb
inside), cobweb and berry-bush stuck factors, slime `stepOn`, beds, bubble columns per cell, the lava height rule, the supporting block, fall distance. Agreement where
prismarine is right: flat walk / sprint / sneak / jump / strafe within 2e-5 per tick on 1.20.1 and 1.21.1, free fall exact, deep still water within 1e-6. Vanilla figures:
walk 4.317 m/s, sprint 5.612 m/s, sneak 1.295 m/s, jump peak 1.2522 landing on tick 12, ladder 2.35 m/s (each within 0.002 m/s or better).

## 3. Native inventory (`src/native/inventory`, 24 tests in `tests/test_native_inventory_pure.js`)

- `menu.js`: the slots of the chest (9xN), hopper, dispenser / dropper, shulker box, player inventory, crafting table and furnace menus, and `doClick` for every mode:
  PICKUP (left / right, outside the window), QUICK_MOVE (each menu's `quickMoveStack` and `moveItemStackTo`), SWAP (hotbar keys, off hand), CLONE (creative: no-op),
  THROW, QUICK_CRAFT (drags), PICKUP_ALL; slot rules (result slots take only and give the whole stack, armour slots, fuel slot, no shulker box in a shulker box).
  Plain left / right / throw clicks agree with prismarine-windows on 400 random clicks.
- `windows.js`: the protocol client: open / close, `window_items`, `set_slot` (window -1 = the carried stack, -2 = the player's inventory), `set_cursor_item` (1.21.2+),
  `set_player_inventory`; a click is predicted with the game's rules and sent with the slots it changed and the carried stack; **the server's packets overwrite the
  prediction** (`stats.corrections` counts the ones that differed); `sync()` asks for the full state (a no-op drag end with state id -1, the server answers `window_items`).
- **The click trouble the owner saw on 26.x** (probe `scripts/native/probe_click_wire.js`, mineflayer 4.39): (a) the server's corrections of the carried stack (`set_slot`
  window -1 up to 1.21.1, `set_cursor_item` from 1.21.2) are dropped by mineflayer: after a click the server corrected, mineflayer's cursor stays wrong until the next full
  `window_items` and the next click carries it; (b) from 1.21.5 (all 26.x servers) the click carries `HashedSlot` and mineflayer writes hash 0 for every component, so each
  click with an enchanted, damaged, named or filled item is a mismatch the server corrects. (a) is handled here on every version; (b) does not arise on 1.21.1 (full items)
  and here a stack without components is sent exactly, one with components with the hash the server gave or 0 (the server's correction is taken). Whether a server mod
  added to the conflicts is a stage B measurement (`stats.corrections` per run on the 1.21.1 mod set).
- `contents.js`: block entity `Items` (1.20.5+ `count`, older `Count`), comparator signal (`1 + floor(14 x fullness)`, float maths), the fewest items for a strength, click
  plans that set a container's contents from the pack (planned on a copy with the game's rules), and **the build job's hook** (section 4).

## 4. Container contents (owner Large 3.4)

- Instruction **`set_contents {x, y, z, contents: [{slot, item, count}], exact?}`** or **`{x, y, z, signal, item, exact?}`** (`src/skills/commands/container.js`): opens the
  container with the use key like a person, plans and sends the clicks (native client), grades from the server's full window contents, re-plans once from the server's state.
  Containers: chest / trapped chest (54 when joined), barrel, shulker boxes, hopper, dropper, dispenser. Result: `{block, size, slots, signal, corrections}`.
- Preconditions (`src/skills/preconditions.js`): `chunk_loaded`, `in_reach` (the aim reach), `item_in_pack` with the goal's total per item (a signal goal counts from the
  block's size). Router (`src/stack/router.js`): routed like `activate` (`ROUTED`, `targetOf`): obtain first, then move / travel; no new remedy.
- **Build-job hook for 075 / 081** (they own `src/build`, `src/work/jobs`): `require('src/native/inventory').blueprintContainers(bp, origin)` returns
  `[{x, y, z, block, args}]` for every container of a blueprint with items (Litematica tile entities; stacks with components left out); after placing such a block, run
  `{name: 'set_contents', args}` through `env.command`. `containerMaterials(bp)` gives `[{item, n}]` to add to the build's material list so the supply holds them.
- Test blueprint `tests/fixtures/sorter-cell.litematic` (writer `scripts/native/make_sorter_cell.js`): a filter hopper (18 cobblestone + 1 stick in each other slot,
  locked by a redstone block, over its chest) read by a comparator (strength 1), and a barrel read by a comparator at strength 3 (247 cobblestone).
- Server-graded test `scripts/native/container_a.js` (world slot 7): the blueprint's blocks set up empty by commands, a supply chest with exactly the items, a kit of tools
  and food; the bot withdraws and runs `set_contents` per container through the console; judge: `data get block` Items equal the blueprint's, the filter chest empty, the
  comparators' `OutputSignal` 1 and 3; `CONTROL=noop` must fail. `scripts/t26/run.sh 7 ../native/container_a.js`.
- Offline: `tests/test_native_container_sim.js` (7 tests): the real instruction on a bot with the native physics against a modelled server that applies clicks with the
  game's rules, corrects predictions and eats a first click; schema, preconditions, router chain, the hook on the test blueprint.

## 5. Trace format

The movement traces use TASK-078's format ([SIM-PARITY-v1](SIM-PARITY-v1.md) section 5, format 1; the world lines `hello`, `st`, `chunk`, `blk`) plus the `tick` line:
`{"t":"tick","ms","tick","row":[t, phase, keys, x, y, z, vx, vy, vz, yaw, pitch, onGround, slot]}`, the runner's row shape and units (keys `FBLRJSNAU`, then `Q` / `X`;
yaw / pitch in mineflayer's radians; onGround 0 / 1), with the state AFTER the physics tick that ran with `keys`, unrounded. The first `tick` line is the start state.
Reader / replayer: `src/native/trace.js` (`parse`, `traceWorld`, `replay`). `tests/golden_native/*.jsonl` are replayed in `npm test` (tolerance 1e-5, 2e-5 for the
generated ones); today they are generated from prismarine-physics where it is right (`scripts/native/make_golden.js`); stage B adds server traces next to them.

## 6. Known gaps (stage A)

- Physics, not modelled: elytra, riding, creative flight, entity collisions and pushing (boats, shulkers, other players), the client's push out of a block it is inside,
  world border, fall damage (not movement). Unverified against the game (each marked in `versions.js` or the code, checked by the stage B traces): the five version
  thresholds, the sneak key taking effect in the tick it is pressed (the game may read the previous tick's), the bot's sprint key as a hold (released = no sprint),
  `isSolidFace` of falling water approximated by a full cube, swimming details.
- Inventory: fuel and smeltable tables are heuristics of the vanilla data (a wrong shift-click prediction in a furnace is corrected by the server); crafting results and
  remainders are the server's; brewing stand, anvil, merchant, enchanting, beacon, loom, grindstone, stonecutter, smithing and cartography screens are not modelled (they
  open; no native clicks); 1.21.5+ component hashes are not computed; bundles; curse of binding.
- `set_contents` needs room in the pack for what `exact` takes out; it does not fetch from supply chests itself (the build job's supply does, or `withdraw`).
- From TASK-075 (noted for the native wiring): `src/work/bot/moves.js` pillar and descend dig and place "blind" through the block under the feet (`frame.cell`), which a
  vanilla client could not click. The native physics does not change it; it is in the action layer's body (`cell` frames), not in this task's files.

## 7. Stage B (needs 074's transport on `main` and world slot 7 of the 1.21.1 test worlds)

1. Wire in `src/transport` behind settings `nativePhysics` / `nativeInventory` (default on, `0` = mineflayer's): `physics.install(bot)` before the fall guard, sprint state
   changes sent as entity actions; native windows attached at login, `bot.inventory` read API fed from them, `clickWindow` / `openContainer` / `craft` / furnace helpers native.
2. Physics traces on the 1.21.1 server: carpet fake players (server-side vanilla movement) driven by `/player ... move|jump|sneak|sprint|look` with a scarpet app writing
   one `tick` line per tick; cases: flat, slabs and stairs, edges while sneaking, ladders / vines / scaffolding, water, lava, ice, soul sand, honey, slime, cobweb, powder
   snow, bubble columns; golden files into `tests/golden_native/`.
3. `move_a`, `mine_b`, `place_a` with native and with mineflayer's modules on the same seeds (`SEEDS=...`), three worlds each; native must not be worse.
4. `container_a` on three new worlds (100 % required) and its negative control; `stats.corrections` per run reported.
5. This file to `docs/implemented/NATIVE-v1.md` with the numbers.
