# NATIVE-v1: the bot's own player physics, inventory clicks, dig time and container contents instead of mineflayer's

`TASK-20261125-076` (owner list 5, Large 4 and Large 3.4; contract in [OWNER-LIST-5](../proposed/OWNER-LIST-5.md)). Built and tested offline on 2026-11-25 (stage A), wired and
measured live on the Fabric 1.21.1 test world 7 on 2026-11-26 (stage B). **State (2026-11-27):** every part is on `main`; **native is the default on Fabric 1.21.1**
(the test worlds and the 1.21.1 creative console), where the same-seed comparison of section 7 found it not worse; **mineflayer's stays the default everywhere else** (the
Forge 1.20.1 play console, the 26.1.2 consoles: nothing compared there). One place decides (`src/native/index.js`: `enabled(part, bot)`, `ACCEPTED`); `NATIVE_PHYSICS`,
`NATIVE_INVENTORY`, `NATIVE_DIG`, `NATIVE_INPUTS` `=1` / `=0` force a part on or off on any version. `set_contents` is always available.

## 1. What still came from mineflayer (measured 2026-11-25, the bot path: everything but the legacy `bot_actuator.js` / `src/actuator/`)

The owner's belief was that only inventory handling and physics simulation still came from mineflayer. **Corrected:** movement and placement decisions were already the
repository's own (the body sends `block_dig` / `block_place` itself), but the world and chunk state, entities, block data (collision shapes, dig time), recipes, chat, the
item codec and the physics loop's position packets also came from mineflayer / prismarine. Counted with grep over `src/` (lines / files) and decided per item:

| Area | Module | Uses on the bot path | Decision, state |
| :-- | :-- | :-- | :-- |
| Wire format, login, compression | minecraft-protocol | every packet | **keep**: it is the protocol; version data, not behaviour |
| Version data | minecraft-data, prismarine-registry | registries, shapes, items, attributes | **keep**: data; every native module reads the connected version's data from it |
| Player physics | mineflayer `physics` plugin + prismarine-physics | `bot.physics.simulatePlayer` every tick, `physicsEnabled` (rl/env.js), the fall guard's wrapper | **ported** (`src/native/physics`, `NATIVE_PHYSICS=1`); the plugin's tick loop and its position / look packets stay (protocol: the 1.21.2+ flags of the move packets) |
| Inventory and windows | mineflayer `inventory` plugin, prismarine-windows | `bot.inventory` 93 / 31, `clickWindow` 8 / 4, `currentWindow` 11 / 4, `openContainer` / `openBlock` / `openFurnace` 6 / 3, `equip` 6 / 2, `toss*` 3 / 2 | **ported** (`src/native/inventory`, `NATIVE_INVENTORY=1`): every click path is native; `bot.inventory`'s read API stays as a view the native client keeps equal |
| Dig time | prismarine-block `digTime` (12 / 6) | body, block.js, rl/controls.js | **ported** (`src/native/dig.js`, `NATIVE_DIG=1`) |
| mineflayer `dig`, `placeBlock`, `activateBlock` | mineflayer | work/service/force.js, work/bot/reflex.js, work/bot/bed.js | **ported** to the body's own inputs (`src/skills/inputs.js`, `NATIVE_INPUTS=1`) |
| Item stacks | prismarine-item | the slot codec (components) | **keep** as the item wire codec; native code uses its own stacks `{name, count, comp}` |
| Recipes | prismarine-recipe (`recipesFor` / `recipesAll` 8 / 4, `bot.craft` 1) | craft, stack/obtain.js, rl/skill_space.js, work/bot/env.js | **keep** (data); `bot.craft`'s clicks run on the native click with `NATIVE_INVENTORY=1`. No failure caused by the recipes was found (the one craft failure, section 4, was a state id) |
| World and chunks | prismarine-chunk, mineflayer `blocks` plugin (`blockAt` 114 / 28) | everywhere | **keep**: chunk parsing is the chunk packet's wire format; the repository reads states itself (`skills/world.js`) |
| Block shapes | prismarine-block `shapes` | physics, geometry | **keep** (data) |
| Entities, health, food, chat | mineflayer plugins | reflexes, attack, router, reports | **keep**: protocol state tracking |
| Use / attack / swing | `activateItem`, `useOn`, `attack`, `swingArm` (19 / 6) | body, reflexes | **keep**: one packet each |
| Pathfinder, collectblock | mineflayer-pathfinder, mineflayer-collectblock | legacy actuator and `mod_interaction_executor.js` only | not on the bot path |

Why JavaScript and not Rust (the owner's "Rust by default"): the physics runs once per tick inside the existing Node bot process (20 bots in one console process) and the
consoles mount the main checkout read-only without a build step; a native addon or a sidecar would add a build, a binary per platform and an IPC hop per tick for about
0.1-0.2 ms of work (TASK-078 measured 108-187 us per bot tick for client physics). The Rust simulator (`tools/sim`, TASK-078) shares the trace format (section 6).

## 2. Physics (`src/native/physics`)

One client tick in the game's own call order (`player.js`): `Entity.baseTick` (fluid heights, currents, lava, eyes in water, swimming), `LocalPlayer.aiStep` (keys to impulses,
sneak and item-use factors, sprint start / stop), `LivingEntity.aiStep` (tiny speeds to zero, ground / water / lava jump, x 0.98, `travel`), `travel` (water, lava, ground
and air; `moveRelative` with the 65536-step sine table; climbing; friction; gravity), `Entity.move` (stuck-in-block factor, sneak-edge back-off, collision with step-up,
flags, supporting block, fall distance, slime and bed landings, slime `stepOn`, inside-block effects, speed factor) and the pose (standing 1.8, crouching 1.5, swimming 0.6).
Floats where the game declares floats. Version differences are data (`versions.js`, by data version).

Interface: `Physics(registry).simulatePlayer(state, world)` takes and returns mineflayer's `PlayerState`, so mineflayer's physics loop and the fall guard
(`src/build/fallguard.js` wraps this function) run on it unchanged. With `NATIVE_PHYSICS=1` it is installed at login (before any fall guard), and the server is told when
the physics stops or starts a sprint the key did not (mineflayer tells it only on key changes).

**Evidence against the server (Fabric 1.21.1, world 7, seed -6595408585636639720).** 16 movement cases recorded with carpet fake players: a fake player is a `ServerPlayer`,
so the server runs the game's own player physics for it; the scarpet app `scripts/native/ntrace.sc` drives it with `/player` actions tick by tick and logs its state after
every tick (`scripts/native/fake_trace.sh`, cases in `fake_cases.js`). The traces are golden files in `npm test` (`tests/golden_native/srv_*.jsonl`).
Replay (`scripts/native/replay_report.js`):

| Case | Native: worst position error | prismarine-physics (mineflayer's) |
| :-- | :-- | :-- |
| walk, sprint-jump, sneak at an edge, slab step, stairs, ladder (climb and hold), water swim-up, packed ice slide, slime drop, cobweb fall | 0 to 6.6e-7 (bit-exact in 8 of these 10; in 14 of all 16) | within 1.8e-6 |
| soul sand walk | **0** | off by 2.71 blocks (from tick 2) |
| honey jump | **0** | off by 1.25 (from tick 1) |
| powder snow sink | **0** | off by 1.71 (from tick 6) |
| scaffolding climb | **0** | off by 3.98 (from tick 1) |
| bubble column | **0** | off by 0.48 (from tick 2) |
| crouch under a 1.5 gap | **0** | off by 1.68 (from tick 36) |

Offline (`tests/test_native_physics_pure.js`, 58 tests): vanilla figures (walk 4.317 m/s, sprint 5.612, sneak 1.295, jump peak 1.2522, ladder 2.35), the parts (axis order,
the 1e-7 collision tolerance, sine table, attributes), every special block, the fall guard on top, the golden traces.

## 3. Dig time (`src/native/dig.js`)

`getDestroyProgress` / `getDestroySpeed` of 1.20-1.21 from the version's data (hardness, the tool multipliers of the block's material, the harvest tools) and the player:
efficiency from the held tool in either item shape (list or 1.20.5+ components), haste / conduit power, mining fatigue, the 1.21 attributes `block_break_speed` and
`submerged_mining_speed`, eyes in water, in the air. The client adds the per-tick progress as a float and breaks at >= 1.0; the tick count is that float sum. Against
prismarine-block on every 1.21.1 block x 18 tools (`tests/test_native_wire_pure.js`): 12 658 equal, 5 534 one tick longer and 888 one tick shorter (float vs double
arithmetic: prismarine computes `ceil(1 / progress)` in doubles), one exact-1.0 boundary two ticks apart; no other difference. The server accepts a finish at 70 % of its own
count (`ServerPlayerGameMode`), and the body waits one spare tick, so neither direction is refused; the live check is the dig-heavy `mine_b` comparison (section 7).

## 4. Inventory (`src/native/inventory`)

- `menu.js`: the slots of the chest, hopper, dispenser / dropper, shulker box, player inventory, crafting table and furnace menus, and `doClick` for every mode (PICKUP,
  QUICK_MOVE with each menu's `quickMoveStack`, SWAP, CLONE, THROW, QUICK_CRAFT, PICKUP_ALL) with the slot rules. Plain clicks agree with prismarine-windows on 400 random clicks.
- `windows.js`: the protocol client. A click is predicted with the game's rules and sent with the slots it changed, the carried stack and the clicked window's own state id;
  the server's packets overwrite the prediction (`stats.corrections`); `sync()` asks for the full state.
- `mineflayer.js` (with `NATIVE_INVENTORY=1`): `bot.clickWindow`, `transfer`, `putAway`, `moveSlotItem`, `putSelectedItemRange` and the windows' `deposit` / `withdraw` run on
  the native click (mineflayer's own strategies, MIT); mineflayer's window objects are kept equal to the native client and get the cursor corrections mineflayer drops.
- **The 26.x click trouble** (offline probe `scripts/native/probe_click_wire.js`, mineflayer 4.39): (a) mineflayer drops the server's corrections of the carried stack
  (`set_slot` window -1 up to 1.21.1, `set_cursor_item` from 1.21.2), so its cursor stays wrong after a click the server corrected; (b) from 1.21.5 (all 26.x servers) the
  click carries `HashedSlot` and mineflayer writes hash 0 for every component, so every click with an enchanted, damaged or named stack is a mismatch the server corrects.
  (a) is handled natively on every version; (b) does not arise on 1.21.1.
- **Measured on 1.21.1 with the test-world mods** (click probe `scripts/native/click_probe.js`, world 7, seed -4038785274222633619): 14 operations (deposit / withdraw of an
  enchanted+damaged pickaxe, a named sword and plain stacks, 2x2 and table crafts, a smelt, two equips, a drop, `set_contents`), the bot's 46 slots compared with the server's
  (`data get entity`) after each: **0 conflicts with mineflayer's clicks (ck2-mf) and 0 with the native ones (ck3-native)**. The native client's corrections: 0 in every
  container operation; 26 in crafts and the smelt, which are the result slots and the furnace's progress the server computes (not predicted, by design). The 1.21.1 mod set
  (carpet, lithium, servux, syncmatica, shulkerfix, simple-autopickup ...) adds no click conflict either way. Found and fixed on the way: the native client used one state id
  for all windows; after a chest closed, an inventory click carried the chest's id and the next 2x2 craft ended `not_confirmed` (ck2-native).

## 5. Container contents: `set_contents` (owner Large 3.4)

- `set_contents {x, y, z, contents: [{slot, item, count}], exact?}` or `{x, y, z, signal, item, exact?}` (`src/skills/commands/container.js`): opens the container with the use
  key, plans the clicks on the game's rules, sends them on the native client, grades from the server's full window contents, re-plans once. Preconditions
  (`src/skills/preconditions.js`): `chunk_loaded`, `in_reach`, `item_in_pack` (the goal's total); router (`src/stack/router.js`): routed like `activate`.
- Build-job hook (for TASK-081, which owns `src/build`): `blueprintContainers(bp, origin)` gives `{name: 'set_contents', args}` per container of a blueprint with items;
  `containerMaterials(bp)` the items to add to the supply.
- Test blueprint `tests/fixtures/sorter-cell.litematic`: a sorter's filter hopper (18 cobblestone + 1 stick in each other slot, locked by a redstone block, over its chest)
  read by a comparator (strength 1), a barrel read by a comparator at strength 3 (247 cobblestone).
- **Server-graded test `scripts/native/container_a.js`** (bot withdraws from a supply chest, then one `set_contents` per container through the console; judge: `data get block`
  Items equal the blueprint's, the filter chest empty, comparators' `OutputSignal` 1 and 3), native modules on, Fabric 1.21.1, world 7:

| Run | Seed | Result |
| :-- | :-- | :-- |
| cta-1126-0050-1 | 6437837307004410460 | PASS (hopper signal 1, barrel 3, 0 corrections) |
| cta-1126-0050-2 | -3946844572123308776 | PASS |
| cta-1126-0050-3 | -4038785274222633619 | PASS |
| cta-1126-0050-noop (control) | -4038785274222633619 | FAIL as required (containers empty, comparators 0) |

  **3/3 on three new worlds, control 0/1.** Before these, one run (ct-n1, seed -6595408585636639720) failed at its first step: both `withdraw`s from the supply chest answered
  `invalid_target` within a second (the report did not yet carry the failure detail), and `set_contents` then had no items. The rerun on the same world passed (ct-dbg). The
  cause was not identified; `withdraw` is the existing gui command, not this task's code.

## 6. Trace format

TASK-078's format ([SIM-PARITY-v1](SIM-PARITY-v1.md) section 5, format 1: `hello`, `st`, `chunk`, `blk`) plus the `tick` line:
`{"t":"tick","ms","tick","row":[t, phase, keys, x, y, z, vx, vy, vz, yaw, pitch, onGround, slot]}` (the runner's row shape and units; the state AFTER the tick that ran with
`keys`, unrounded; the first `tick` line is the start). Reader / replayer: `src/native/trace.js`.

## 7. Native vs mineflayer on the test-world tests (same seeds, Fabric 1.21.1, world 7)

`scripts/native/compare.sh TEST SEED`: the test with mineflayer's modules, then with the native ones, each on a new world of the same seed.

`scripts/native/compare_report.js` puts the runs side by side. Native = `NATIVE_PHYSICS=1 NATIVE_INVENTORY=1 NATIVE_DIG=1 NATIVE_INPUTS=1`, mineflayer = all four `=0`.
Peaceful except `move_a` (Normal). Run 2026-11-26 12:44 to 2026-11-27 04:55 on code d7e9ac76 (after the swim fix below); results `/mnt/data/forgeaip-play/t26/out/cmp-<test>-<seed>-{mf,native}`.
`mine_b` is one trial per world and fails in both modes on 1.21.1 (as in TASK-074's own runs: unreachable stations, the 4 h limit), so its units are compared too.

| Test | Seed | mineflayer: passed, mean s per trial, deaths | native: passed, mean s, deaths |
| :-- | :-- | :-- | :-- |
| place_a | 7601 | 4/4, 31 s, 0 | 4/4, 31 s, 0 |
| place_a | 7602 | 4/4, 31 s, 0 | 4/4, 32 s, 0 |
| place_a | 7603 | 4/4, 31 s, 0 | 4/4, 31 s, 0 |
| move_a | 7601 | 3/4, 1385 s, 1 | 3/4, 1364 s, 4 |
| move_a | 7602 | 2/4, 1050 s, 2 | 4/4, 1308 s, 0 |
| move_a | 7603 | 4/4, 1171 s, 0 | 3/4, 1245 s, 1 |
| mine_b | 7601 | 0/1 (59/63 units, 4 stuck), 5861 s, 1 | 0/1 (62/63 units, 1 stuck), 4889 s, 0 |
| mine_b | 7602 | 0/1 (64/64 units, 12 pumpkins left), 4600 s, 0 | 0/1 (64/64 units, 12 pumpkins left), 4549 s, 0 |
| mine_b | 7603 | 0/1 (14/70 units, 10 stuck, 4 h limit), 14403 s, 1 | 0/1 (14/70 units, 5 stuck, 4 h limit), 14404 s, 0 |

**Verdict: native is not worse.** place_a 12/12 either way; move_a mineflayer 9/12, native 10/12; mine_b fails in both modes on every seed, and native has as many units
done or more, as few stuck or fewer, and no death against two. One number is worse with native: move_a deaths, 5 against 3. Four of the five are one bot: 7601 native MvE7,
stuck on the east line (z -8) at **x 671, y 69, z -8** (NAV: 30 segments, 3 pillars, "8 segments without getting closer", 549 s waited for the night), killed there by a
drowned, two zombies and a stray between 04:26 and 04:28 UTC. The pre-fix native run of the same seed stopped on the east line too (z -1, at **x 687, y 71**), while
mineflayer's two east bots on that seed (lines z -2 and z 5) got through. The other failures: native 7603 MvE7 at **x 703, y 64, z 3** (38 segments, 7 fights, 1 death);
mineflayer 7601 MvW7 at **x -592, y 69, z -2**, 7602 MvE7 a walk that timed out four times at **x -33, y 62, z -18**, 7602 MvS7 at **x -148, y 61, z 189**. **For 075 / NAV:** seed 7601
around x 670-690 on z -8..-1 stopped the native east bot twice and is worth a look as a movement case (a new world of seed 7601, `scripts/t26/up.sh 7 --new --seed 7601`).

**Before native becomes the default anywhere else** (the orchestrator's condition, 2026-11-27): the same comparison on that platform and version, same seeds, server-graded.
For the Forge 1.20.1 play console that means a disposable copy of the play world (`scripts/world/test-up.sh`, never the play world) with its mod set (Create and the rest of
`modpack/forgeaip-create.lock.json`): move_a- and mine_b-type runs on natural terrain there, place on mod blocks, and the click probe (`scripts/native/click_probe.js`) with mod
items in containers (Create's items carry NBT and the FML3 registry gives mod ids); `src/native/physics` reads block shapes from the version's data, so mod blocks' collision
boxes must come from `src/transport/mod_registry.js`' table, which is not yet checked against the native physics. Then add `forge 1.20.1` to `ACCEPTED`.

**move_a found a real difference, and its cause was in the walk, not in the physics.** The first `move_a` 7601 pair (2026-11-26 01:20-02:11, before the fix):
mineflayer 4/4, 0 deaths; native 1/4, 6 deaths, three of them `drowned` in the server log within the first 11 minutes, the other bots stuck after their deaths. Under
water the game's sprint is swimming, and a swimming body moves along its look (`Player.travel`: the look's y pulls the vertical speed). The walk (`src/skills/motion.js`)
held sprint in water ("the way a player swims against a current") and left the pitch where the last dig or place had put it, usually pointing down: on the native physics
the bot swam along the bottom (offline: sprint + jump + forward, look 0.5 rad down, the body stays at the bottom; without sprint it surfaces in 2 s, test in
`test_native_physics_pure.js`). prismarine-physics has no swimming, so this never showed with mineflayer's physics. Fix: in water the walk looks level and sprints only
with the head out of the water; the breath reflex lets go of sprint and looks up; the fight reflex does not sprint in water. The table above is on the fixed code (both modes).

## 8. Known gaps

- Physics not modelled: elytra, riding, creative flight, entity collisions and pushing, the client's push out of a block it is inside, world border. Version features checked
  only on 1.21.1: the 1.21.2+ step-up candidates, the double-argument sine and the 1.21.5 normalised input are written from the game code and not yet traced. The bot's
  sprint key is a hold (released = no sprint); the sneak key acts in the tick it is pressed (the traces drive fake players by actions, which agree).
- Inventory: fuel and smeltable tables are heuristics of the vanilla data (a wrong furnace shift-click prediction is corrected by the server); crafting results are the
  server's; brewing, anvil, merchant, enchanting, beacon, loom, grindstone, stonecutter, smithing screens keep mineflayer's click; 1.21.5+ component hashes are not computed.
- `set_contents` needs room in the pack for what `exact` takes out and does not fetch from supply chests itself.
- From TASK-075: `src/work/bot/moves.js` pillar and descend dig and place "blind" through the block under the feet (`frame.cell`), which a vanilla client could not click.
  Not changed here (the body's `cell` frames, not this task's files).
