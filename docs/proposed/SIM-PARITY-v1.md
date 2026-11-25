# SIM-PARITY-v1: the Rust simulator against the real server, command by command (TASK-20261125-078, stage A 2026-11-25)

The owner's report (problem list 5, Large 2): results of the Rust simulator `tools/sim` often differ from the real server; run the same
world and the same bot actions on both, watch whether they match, fix what does not, and make it practical for testing (Medium 3: "make use
of the Rust server"). This document is stage A, done offline: what the simulator already simplifies, the recorder and the replayer, the
parity level aimed for, a first measured comparison of the testing-backend options, and the live runs stage B needs. Stage B (on the
Fabric 1.21.1 test worlds of TASK-074, world slot 5) records the corpus, measures, fixes category by category, and ends in
`docs/implemented/SIM-PARITY-v1.md`. Numbers marked (est.) are estimates, not measurements.

## 1. Which simulator

| Simulator | What it is | In the parity work? |
| :-- | :-- | :-- |
| `tools/sim` (Rust, std only) | Command-level (semi-Markov) simulator of the action layer on worlds read from real region files: each command is one transition (outcome, reason, ticks, position, blocks, inventory), world clocks in between. Built for the RL skill environment on Forge 1.20.1 (SIM-RUST-v1 sections 9-12). | **Yes**: this is the "Rust server". |
| `rl3/` (Python/JAX) | Cell-level movement simulator for training the learned walk `move3` and the pit station network (MOVE-v3, PIT-EXPERT-v1). | **No.** The T26 standard moves bots with NAV (`navigator` default `nav`, `src/work/service/index.js`); `move3` runs only with `navigator: legacy`. rl3's contract with the live code is its own golden files (`tests/golden_*.json`). If `move3` comes back, the recorder's per-tick traces (`SIMREC_TRACE=1`, section 5) are the input its parity check would replay. |
| `scripts/work/sim_plan.js` | Plan-level simulated builder (does a blueprint place completely, in which order). | No: it simulates the plan, not the server. |

## 2. What `tools/sim` knowingly simplifies (from the code and SIM-RUST-v1), with the expected effect

Each line names where it is, what the server does instead, and the divergence category (section 4) it should produce. The list is the
"before" hypothesis; stage B's corpus says which ones matter and how much.

**World and tables**

1. **Block states are dropped** (`export.rs`, `tile.rs`: ids only). No orientation (stairs, logs, hoppers, comparators), slab halves, door/bed
   halves, waterlogging, fluid levels, snow layers. Effect: every orientation-dependent placement compares equal by name only; fluid levels
   cannot be simulated. Categories: `placement_rules`, `fluids`.
2. **Shapes are full cube or nothing** (`gen_data.js kindOf`: `boundingBox === 'block'` -> solid). Slabs, stairs, carpets, paths (15/16),
   soul sand (14/16), chests, hoppers, fences and walls (1.5 high), glass panes all count as full cubes or as passable. Effect: wrong step-up
   and jump heights, wrong headroom, aim rays blocked or not where the server differs. `collision`, `movement_reach`.
3. **Version**: the built-in tables are minecraft-data **1.20.1** (the RL vocabulary). Since this task `gen_data.js` also writes
   `data/data-1.21.1.json` (1,060 blocks; 58 new names such as `short_grass` (was `grass`), tuff and copper families, `crafter`, `vault`),
   and the replayer picks the tables of the trace's version. The rules in `sim.rs` still use 1.20.1 names (`replaceable()` lists `grass`):
   the fixture test shows the divergence this causes. minecraft-data 1.21.1 lists **1,470 recipes against 2,409** for 1.20.1 (to verify:
   tag ingredients may be missing). `placement_rules`, `recipes`.
4. **Drops** (`break_block`): the first entry of minecraft-data's drop list, always one item, straight into the pack. No loot tables (ores
   with counts such as lapis 4-9, gravel -> flint, leaves -> sapling/stick chances), no Silk Touch or Fortune, no item entities. `drops`.
5. **Dig time** (`dig_plan`): vanilla hardness x tool multiplier only. No enchantments (the T26 `mine_b` kit is netherite with
   Efficiency 255: instant breaks the simulator would time as tool speed), no Haste, no x5 penalties for digging in water or not on the
   ground, no durability. `dig_time`.
6. **Fluids** (`flow`): water from a dug-open neighbour fills breadth-first, seven cells sideways, at most 400 cells, at once; lava one cell.
   No spreading over time, no source formation, no waterlogging, no current pushing the bot, no bubble columns. `fluids`.
7. **Gravity blocks**: sand, red sand and gravel fall straight down only when the bot digs the cell under them. No concrete powder, anvils,
   dripstone, scaffolding; a gravity block placed over air does not fall. `gravity_blocks`.
8. **No block updates**: torches, rails, redstone dust, plants and carpets stay when their support is dug (the server pops them off and
   drops them); no redstone, pistons, observers, doors. `blocks_other`, `drops`.
9. **Light** is not modelled; only a crude "opaque block overhead" rule gates hostile spawns. `light`.
10. **Tile edge and walker range**: cells outside the recorded or exported chunks read as solid "unloaded"; the walking graph stops at
    1,500 nodes / 18 blocks (the RL candidate list's own limits), where `move_to` and NAV plan across 100+ blocks. `movement_reach` on long walks.

**Movement**

11. **Walker graph** (`flood_n`): eight-neighbour walking, one-block step-up, drops of up to three, ladders and vines; no jumps across
    gaps, sprint-jumps, swimming upwards, pillar or bridge, sneaking at edges, doors, gates or trapdoors. `movement_reach`.
12. **Walking time** (`ticks_for`): distance / 4.317 blocks/s x 1.06 + 5, fitted on 851 `move_to` of the 1.20.1 Forge environment with
    the old skill planner, not NAV. `walk_time`.
13. **Position is a cell**: the bot stands at cell centres; the real body stops up to 0.25 off (modelled only as a fixed aim offset in
    `approach`). No collision with other bots, players or item entities; no knockback except the modelled melee. `collision`.
14. **No fall damage** (the walker never drops more than three). `hunger`/health only through the world clock.

**Commands**

15. **`place`**: REPLACEABLE list (1.20.1 names), a solid neighbour, a stand cell outside the target's column; ignores the `recipe`
    (face, look, sneak: the server derives the state from them), `block` (item -> block, e.g. redstone -> redstone_wire), `fluid`, `temp`,
    placing against interactive blocks, players or bots in the cell; fixed walk + 8 ticks. `placement_rules`, `place_time`.
16. **`mine`**: aim points on full-cube faces only; ignores `collect: false` and `blind`; drops always collected with fixed
    `MINE_COLLECT + MINE_PICKUP` ticks (the test servers' vacuum puts drops straight into the pack: different timing); `protected` fixtures
    unknown. `dig_rules`, `dig_time`, `drops`.
17. **Not modelled at all**: `look_at`, `pour`, `activate` (except beds), `pickup`, `toss`, `deposit`, `withdraw`, `attack` in the
    replay; the runner-level moves of `src/work/bot/moves.js` and `bridge.js` (`pillar`, `descend`, `bridge`, `harvest`, `sneak_walk`); the
    builder's own controls (`src/build/move.js`, 31 direct control calls) and reflexes (`src/work/bot/reflex.js`). Reported as coverage,
    not as divergence.
18. **Atomic preconditions** (`src/skills/preconditions.js`): `precondition_failed` never happens in the simulator.

**World clocks**

19. **Hunger**: exhaustion per walked block fitted (0.02); difficulty ignored (on Peaceful the server neither drains food nor lets health
    wait for it). `hunger`.
20. **Mobs**: four hostile kinds by rule with fitted spawn rates (SIM-RUST-v1 12.3). The replay switches them off: every T26 test except
    `move_a` / `move_b` runs Peaceful.
21. **Ticks** are game ticks; the real `ticks` are counted by the client's runner and include waits for the server under lag.

## 3. Recorder and replayer (built, on main)

- **`scripts/sim/record.js`**, loaded with `node --require` before anything else, wraps the action layer's `execute` and the runner's `run`
  (for the moves that call it directly) and writes one JSONL file per bot. It reads only the bot's own client state, which the server's
  packets keep current, and the results the commands return; it changes nothing the bot does. With the T26 harness:
  `scripts/t26/run.sh N place_a.js NODE_ARGS=--require=./scripts/sim/record.js [SIMREC_DIR=/out/simrec/<run>] [SIMREC_TRACE=1] [SIMREC_R=2]`.
  Cost: a chunk snapshot is 1-6 ms of the event loop and about 4 KB on disk (measured, 1.21.1 prismarine-chunk); radius 2 = 25 chunks the
  first time, then only chunks the bot reaches.
- **`forgeaip-sim replay TRACE.jsonl... [--data data-1.21.1.json] [--rows rows.jsonl] [--json summary.json] [--near 6]`**
  (`tools/sim/src/replay.rs`): builds the world from the first snapshot of every chunk, applies the recorded block updates in time
  order, and for every modelled command puts the recorded bot (cell, the 36 main slots, health, food) into the simulator, runs the command,
  and compares it with what the server did; then undoes the simulator's changes, so the next command starts from the recorded world again
  (teacher forcing: one divergence never carries into the next command). Prints the parity table, writes one row per command.
- Tests: `tests/test_sim_recorder.js` (npm test) runs the recorder on a fake 1.21.1 bot and writes exactly
  `tools/sim/tests/trace_flat.jsonl`; `cargo test` replays that file (world rebuilt, two agreements, one real divergence named
  `placement_rules`, one unmodelled command, teacher forcing).

## 4. What is compared, the categories, and the parity level

Per command, real against simulated: **outcome** (ok and reason), **cell** after (`floor` of the position), **blocks** (the cells that
changed during the command within `--near` blocks of the bot's start, end or target, with their final block name), **inventory** (delta of
item counts in the main slots), **ticks**, **food**.

Categories of a divergence (`categorize` in replay.rs): `movement_reach`, `collision`, `walk_time`, `dig_time`, `dig_rules`,
`placement_rules`, `place_time`, `fluids`, `drops`, `gravity_blocks`, `hunger`, `light`, `recipes`, `inventory_other`, `blocks_other`,
`other_time`. A block difference involving a fluid is `fluids`, one involving a falling block `gravity_blocks`, before any command rule.
Unmodelled commands count as coverage; block names the tables do not know are reported per trace (`data`).

**The level aimed for**, on the corpus of section 7, over the modelled commands:

| Measure | Target | Why this level |
| :-- | :-- | :-- |
| outcome and reason identical | >= 98 % | The router and the jobs branch on the reason (COMMAND-STACK-v1), so a wrong reason is a wrong decision, not noise. A build run is ~10^4 commands; per-command parity below 98 % leaves hundreds of wrong branches per run. Bounded above by the real server's agreement with itself (below). |
| cell, blocks and inventory identical (given the same outcome) | >= 98 % | The tests are graded on blocks and items (T26 standard), so these are the outcome the owner sees. |
| ticks within 10 % or 2 ticks (both ok) | >= 90 %, and the mean ratio simulator / real per command within 0.95-1.05 | Real ticks carry lag stalls and chunk-loading waits, so no fixed per-command tolerance holds for every command; the mean ratio is what makes the simulator's run time a usable estimate of the real one. |
| coverage (share of corpus commands modelled) | reported, not a target | The modelled set grows with the backend decision (section 6). |

**Noise floor first.** Stage B replays a recorded command sequence on a fresh copy of the same seed on the real server (real against
real). If the real server agrees with itself on fewer than 99 % of outcomes (lag, other bots, server-side randomness such as loot), the
target is that rate minus one point; a simulator cannot be held to more agreement than the truth has with itself. Every remaining
divergence is listed by category with its count and an example row.

## 5. The trace format (shared with TASK-076)

One JSONL file per bot (`format: 1`). The world lines are the same for command-level (this task) and tick-level (076) traces:

| Line | Fields |
| :-- | :-- |
| `hello` | `format`, `recorder`, `bot`, `version`, `minY`, `height`, `dim`, `difficulty`, `gameMode`, `world`, `run`, `speed`, `ms` |
| `st` | `id` (the version's block state id), `n` (block name), `p` (properties): once per state id per file |
| `chunk` | `ms`, `tick`, `cx`, `cz`, `minY`, `height`, `enc: "u16le-deflate-b64"`, `cells` (state ids, index ((y - minY) * 16 + z) * 16 + x) |
| `blk` | `ms`, `tick`, `p: [x, y, z]`, `s` (state id): every block update of a recorded chunk, as the server sent it |
| `cmd` | `id`, `layer` (`execute` or `run`), `name`, `args`, `atomic`, `maxTicks`, `ms`, `tick`, `before` (state) |
| `res` | `id`, `ms`, `tick`, `ok`, `reason`, `detail`, `ticks`, `wallMs`, `phases`, `after` (state); `trace` with `SIMREC_TRACE=1` |
| `spawn`, `death` | respawn / dimension change (a new world for the replayer), death |

State: `pos`, `vel`, `yaw`, `pitch`, `ground`, `hp`, `food`, `sat`, `air`, `slot`, `inv` (`[slot, name, count, damage?]`), `dim`.
`ms` is wall-clock epoch milliseconds (orders the files of several bots), `tick` the bot's own physics tick count. The per-tick `trace` is
the runner's own record, one row per tick: `[t, phase, keys (FBLRJSNAU + Q/X), x, y, z, vx, vy, vz, yaw, pitch, onGround, hotbar slot]`.
**Proposal to 076:** its tick-level traces use the same `hello` / `st` / `chunk` / `blk` lines and per-tick rows of that shape (input
frame, then the server-confirmed state), as a `tick` line kind for movement outside the runner; the replayers then share the world reader.

**Adopted by 076 (format 1, no new fields):** `{"t":"tick","ms","tick","row":[t, phase, keys, x, y, z, vx, vy, vz, yaw, pitch, onGround, slot]}`.
The row has the runner's shape and units (keys `FBLRJSNAU` then `Q`/`X`, yaw and pitch in mineflayer's radians, onGround 0/1), with two
differences: the position and velocity are the state AFTER the physics tick that ran with `keys` (the runner records the state before it),
and they are not rounded. The first `tick` line of a file is the start state (its keys are not replayed; fall distance 0, standing pose and
no sprint are assumed). Reader and replayer: `src/native/trace.js` (`parse`, `traceWorld`, `replay`); generated examples and, after stage B,
server traces in `tests/golden_native/` (npm test). Doc: `docs/proposed/NATIVE-v1.md`, "Trace format".

## 6. Testing backends: what each costs and what it can test (first measured estimate)

Measured 2026-11-25 on the VPS (12 threads):
- **Simulator speed**: 229-262 commands per second per core on two natural tiles (`bench_commands`, `cargo test --release -- --ignored`,
  move_to 2.5 ms including the walking graph, mine and place 4.3-5.2 ms, std HashMaps; dense arrays and a cheaper hash would be faster).
  A real command takes 54-90 ticks median (SIM-RUST-v1 section 10), 2.7-4.5 s at 20 ticks/s: **~700-1,200x real time per core** for
  the commands the simulator models.
- **Client cost per bot tick**: prismarine-physics (mineflayer's movement physics, what every bot runs each tick) costs **108-187 us per
  tick** on a 1.21.1 world: one core runs one bot's movement at most **~270-460x real time**, before the bot's own per-tick code.
- **Interface sizes**: the bot code (src/skills, work, nav, build, stack, experts, transport) uses about 80 distinct members of the
  mineflayer bot (`bot.entity` 282 uses, `bot.inventory` 92, `bot.blockAt` 34, `bot.setControlState` 31, `bot.world` 14 ...) and writes
  2 packet kinds itself (`block_place`, `custom_payload`; `body.js` sends `block_dig` / `block_place`). Mineflayer listens to 94 server
  packets and writes 33; the 1.21.1 protocol has 116 + 56 play packets and 9 + 5 configuration packets. The harnesses use ~25 server
  commands (`fill` 33 uses, `execute` 30, `give` 29, `setblock` 24, `tp` 17, `gamemode`, `forceload`, `data`, `clear`, `effect`, ...).
- **What goes through `execute`**: NAV, the pit and the builder issue `mine` (21 call sites), `move_to` (14), `place` (4) through
  `execute`; `pillar`, `descend`, `bridge`, `harvest`, `sneak_walk` through the runner (moves.js); the builder's own movement
  (`src/build/move.js`, 31 direct control calls) and the reflexes (`reflex.js`, 13) through neither.

| Option | What it is | Size (est.) | Lets you test | Does not |
| :-- | :-- | :-- | :-- | :-- |
| **A. Adapter below `execute()` / the runner** | `execute` and `run` answered by the simulator; a fake bot object kept in step with it for everything the jobs read (`bot.entity`, `inventory`, `blockAt`, `world`, `entities`, events). | JS mock ~1.5-2.5k lines + Rust: a service mode over stdin/stdout ~300, the 9 unmodelled commands and 5 moves ~1-1.5k. | The router and job logic on top of the commands: pit decisions, supply, temp-block bookkeeping, RL policies; ~1,000x real time per core. | Anything below a command (body, NAV's step control, the builder's movement, 076's native physics and inventory); its fidelity is capped by section 2 for every command. |
| **B. Packet front end in-process** | Real mineflayer and all bot code unchanged, created with `createBot({client})` (supported by mineflayer 4.39) on a fake client that hands packets as objects to a server side: login/configuration replayed from a captured session, chunks from the recorded or exported world, movement accepted from the client, digging, placement (state from face and look), inventory and windows, item entities, the harness's ~25 commands. | ~4-6k lines (server rules in Rust behind a pipe, a thin JS shim; no wire codec). | Everything the bots do, including NAV, pit, build, the reflexes, and 076's native physics and inventory, which speak packets; virtual time (no 50 ms intervals) bounded by the client: ~270-460x for movement physics alone, less with the bots' own per-tick code (to measure). | The real server's own physics of other entities (mobs, fluids over time, redstone) beyond what the server side implements. |
| **C. Wire-protocol server (1.21.1)** | B plus the codec (VarInt, NBT, chunk and light encoding, registry data in configuration), on a real socket. | B + ~3-4k lines. | As B, with bots in separate processes and the owner's own client able to watch. | As B; the codec is cost without new fidelity. |

**Decision for stage B (mine, within scope):** prototype **B**. A is cheaper, but it cannot run what the owner asked to test (pit and
build movement go below `execute`, and 076 replaces exactly the layers A would mock); C costs the codec without testing anything B does
not. Order: `move_a` first (login, chunks, movement acceptance only), then `mine_b` (digging), then `place_a` (placement), measuring the
speed-up against the real world at the 079 factor and the fidelity (T26 graded results on the same seeds) before building it out. A is
kept in mind for RL policy and router-only tests once B's server rules exist (they are the same rules). The ratio of ticks spent inside
and outside `execute` in real pit and build runs (from the recorder's `ticks` against the run's length) is the first stage-B measurement
that could change this decision.

## 7. Live runs stage B needs (world 5, 1.21.1, after 074; never 03:00-06:00 JST; schedule hold per run)

1. Corpus with the recorder: `move_a` and `move_b` (3 seeds each, `SIMREC_TRACE=1`, shared with 076), `mine_b` (1 seed, full depth),
   `place_a`, `place_b`, `place_c`, one short `build_t`; about 4-6 hours of world-5 time in total (est.).
2. Noise floor: a player script (`scripts/sim/play.js`, stage B) that re-issues a recorded command sequence on a fresh copy of the same seed.
3. The same seeds on the packet front-end prototype, graded the same way, for the speed-up and fidelity of section 6.
