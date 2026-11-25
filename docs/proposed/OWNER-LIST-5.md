# OWNER-LIST-5: the owner's problem list 5 (2026-11-25) as eight tasks, their order, ownership and definitions of done

The owner's list of 2026-11-25 23:00 JST (five small, three medium, four large problems) split into tasks `TASK-20261125-074` to `-081`, each
worked by one subagent in its own git worktree, coordinated by the main session (the orchestrator). This file is the contract between them:
what each task must achieve, which files it owns, what it must not touch, and when it counts as done. The owner's words come first in each
section; the elaboration below them is the orchestrator's and binds the subagent.

## Rules for every task (on top of CLAUDE.md and docs/core/MASTER_GUIDANCE.xml)

- **Root causes, not stopgaps.** A fix names the cause it removes and shows the evidence (log lines, counts, a server-side scan). "Fewer" is
  not "fixed" when the owner asked for none.
- **Grading is server-side** on the test worlds (TEST-WORLDS-T26.md standard: three new random-seed worlds, `<= 80 %` failure, 90 % WIP, 100 %
  success); simulator and `/fill` arenas are smoke tests. State the world and version with every number.
- **Survival, no cheats** for the bots (no creative flight or items, no placing into air, items only from the real supply). Test-server
  conveniences the owner asked for (pumpkins as the temporary block, drops straight into the inventory, a faster tick rate) are server
  settings, not bot cheats.
- **Ownership.** A task changes only the files it owns (table below). A change outside them is allowed only when it is small, necessary, and
  named in the commit message; a larger one is reported to the orchestrator first. Never commit `docker/bot.Dockerfile` or `docker/compose.yaml`
  (the owner's uncommitted edits in the main checkout).
- **Git.** Work in your worktree on a branch `t/<id>-<slug>`. Commit small (`TASK:<id> <type>: <description>`, ending with the
  `Co-Authored-By` line). To land a unit: `git fetch origin && git rebase origin/main`, run `npm test` (docker, node:20-slim), then
  `git push origin HEAD:main` (fast-forward only; on rejection rebase again; never force). The main checkout
  `/home/coder/projects/forge1201-MODED-AIPlayer` is mounted read-only by the consoles: only the orchestrator pulls it and deploys.
- **Live resources.** Name every container you start and stop it by name (never by image or `pkill -f` on a pattern your own shell matches).
  Keep runs out of 03:00-06:00 JST (reboot window). Register any job longer than a few minutes on the schedule (`schedule_add`, kind `hold`,
  resources `["vps"]`) and close it. The host has 12 cores / 62 GB shared with other services: use only your world slots (below).
  Never touch `forgeaip-play-console`, the Forge play world, or other repos' services.
- **Records.** Search the knowledge-DB before starting (`repos/forge1201-MODED-AIPlayer/`, `LLM-records/`). Record decisions, results and
  failures (`record_memory`, tags `forge1201-moded-aiplayer` and your task id). Before changing a symbol run scip-neo4j `analyze_change_impact`
  / `get_symbol_dependencies` with `repo=https://github.com/I-yuki-0424/forge1201-MODED-AIPlayer` (check `get_index_status`; if it is not
  active, read the code).
- **Report.** Your final message to the orchestrator: what is done (commits on main), the evidence (numbers, world, version), what is not done
  and why, anything another task must know (interfaces you changed), and what the orchestrator must deploy.

## Order

1. **Wave 1 (now):** 074 (migration; it also builds the 1.21.1 test worlds every later live test uses), 075 (temporary blocks), 076 (native
   physics and inventory), 077 (WebUI and in-game display). 075, 076 and 077 do their offline work (analysis, code, unit tests) first and
   use the 1.21.1 test worlds once 074 has them on `main`.
2. **Wave 2 (after 074 lands):** 078 (simulator parity), 079 (game speed), 081 (build success; it follows 075 on the same files).
3. **Wave 3:** 080 (CI), which runs everything above as a regression suite.

## World slots on the 1.21.1 test worlds (after 074)

| Slots | Task |
| :-- | :-- |
| 1-3 | 074 during the migration; then 075 / 081 |
| 4 | 075 / 081 |
| 5 | 078 |
| 6 | 079 |
| 7 | 076 |
| 8 | 077 |
| 9 | 080 |

Ports: test world N on the tailnet `100.77.246.23:(25620+N)`; the 1.21.1 creative standing server `25620`, its console `3034`.

## File ownership

| Task | Owns |
| :-- | :-- |
| 074 | `src/transport/**`, `scripts/t26/**` and any new version-agnostic test-world scripts, `docker/t26/**` and new server compose/mod locks, version handling in `src/work/world/**`, `docs/implemented/TEST-WORLDS-*.md`, the new migration doc |
| 075, then 081 | `src/nav/**`, `src/build/**`, `src/work/bot/tempblocks.js`, `src/work/jobs/**` (pit, build), `scripts/t26/build_t.js`, `docs/implemented/BUILD-v2.md`, `NAV-v1.md` |
| 076 | new `src/native/**`; wiring into `src/transport/**` only after 074 is on main (rebase first); container commands in `src/skills/commands/**` (new files) and `src/skills/preconditions.js`, `src/stack/router.js` rules for them |
| 077 | `public/work/**`, `src/work/web/**`, `src/work/display/**`, `docs/implemented/WORK-CONSOLE-v1.md` |
| 078 | `tools/sim/**`, `rl3/` only if the movement simulator is part of the parity work, new trace recorder scripts under `scripts/sim/` |
| 079 | `src/transport/time_scale.js` (with 074's agreement), server settings in the test-world scripts (after 074), `docs/implemented/` speed doc |
| 080 | `.github/workflows/**`, `scripts/ci/**`, `docs/implemented/CI-v1.md`; `package.json` test list |

## TASK-20261125-074: move to Fabric 1.21.1 (owner Medium 1, Small 4, Small 5)

Owner: compatibility of Fabric 26.x is poor (the bot's inventory clicks and other mods conflict); the system must not depend on one version;
move to Fabric 1.21.1 and later. On the existing 26.x servers keep the data only of the creative server (not a disposable test server); freeze
and stop everything else. Downgrade the mods to matching versions (CurseForge and the like). On the PC carry the mods and their configs (each
mod's own settings), the Litematica blueprints and, if possible, every key binding from `E:\Minecraft JAVA\instances\fabric 26.3\instance` to
`E:\Minecraft JAVA\instances\Fablic1.21.1`. Match the test servers' version; watch for API changes; item id indexes differ. Add Inventory
Peeker; a debug-logger mod is allowed if needed. Small 4: on the test servers every temporary block is a pumpkin (visibility). Small 5: on the
test servers the items of a broken block go straight into the inventory.

1. **Freeze 26.x.** Stop (do not delete volumes): T26 worlds `forgeaip-t26-1..9` and their watchers `forgeaip-t26-dev-N`
   (`scripts/t26/dev.sh N stop`), `fabric26-survival-hard`, `fabric26-survival-op` and their consoles. Before stopping a console, read its
   `console-data/<name>/state.json`: a running job is paused first and named in the report. Keep `fabric26-creative` and
   `fabric26-console-creative` running and their data untouched. Write down what is stopped, the volume names and how to start each again.
2. **Version-agnostic test worlds.** One configuration (Minecraft version, loader, mod lock) decides the version; nothing else in the
   scripts or the code names a version. New test worlds on Fabric 1.21.1 (slots and ports above). 1.21.1 differs from 26.1 in at least:
   gamerule names (camelCase in 1.21.1), the world folder's dimension layout, protocol details the 26.1 patches in `src/transport` work
   around, item components, carpet script API, Syncmatica protocol version, Litematica schematic data version. Version-gate or remove
   each 26.1-specific patch; numeric item and block ids always come from the connected version's registry. The 26.x creative console still
   runs this code after a deploy: keep it working (a live check of version independence) or report exactly what breaks.
3. **Server mods.** The test worlds' server-side set in its 1.21.1 builds, pinned by sha512 (Modrinth first, CurseForge where needed):
   fabric-api, carpet, lithium, ferritecore, krypton, ksyxis, a light engine like ScalableLux if one exists, servux, syncmatica, appleskin,
   jade, shulkerfix, and an auto-pickup mod (Small 5). ViaVersion only if still needed (the owner's client will be 1.21.1).
4. **Small 4 and 5 on the test servers.** The temporary block is a pumpkin (harness settings and supply chests; the bots' temporary-block
   choice honours it). Drops of a block a bot breaks land in its inventory (verify with a survival bot: the item count rises, no item entity
   is left; a full inventory drops normally). These are test-server settings: production consoles keep their own `tempBlock` setting.
5. **A 1.21.1 creative standing server and console** for the owner's construction tests: new world, seed 1359280 as the 26.x one, the
   same mod set as the test worlds plus whatever the owner's creative tests need (Syncmatica, Servux), owner-only operator `Seia_Y`
   (offline UUID as in `scripts/t26/up.sh`), tailnet ports only (`ss -ltn` check), console rules unchanged (session, CSRF, Host/Origin,
   proxy-header refusal; check unauthenticated requests are refused the same way as on 3031).
6. **PC instance.** Reached over ssh as in `scripts/rl3/pc.sh` (Windows, PowerShell). The source instance is read-only for you. Zip the
   target instance first (next to it, dated). Carry over: every mod of the source in its 1.21.1 build (list mods with no 1.21.1 build and
   what replaced them or that they were left out); `config/` per mod, checked against the 1.21.1 version's options; the Litematica
   `schematics/` (check each file's data version loads in Litematica for 1.21.1; list blocks that do not exist in 1.21.1); key bindings
   (`options.txt` `key_*` lines whose keys exist in 1.21.1, and the malilib hotkeys in the mods' configs); add Inventory Peeker. Do not
   launch the game; the owner checks it.
7. **Code changes for 1.21.1** in the bot: login/configuration, registries, item components or NBT, chat, the Syncmatica client, litematic
   reading, the map view.

**Done when:** 26.x frozen except creative (list in the doc); `npm test` green; each T26 test (`move_a`, `move_b`, `mine_a`, `mine_b`,
`place_a`, `place_b`, `place_c`, `build_t` smoke) run once on three new 1.21.1 worlds with server-graded results set next to the last 26.x
result (a test that fails only on 1.21.1 is a migration bug to fix; one that failed on 26.x too is reported); pumpkins and auto-pickup
verified live; the creative 1.21.1 server and console up and checked unauthenticated; the PC instance carried over with the lists above;
`docs/implemented/MIGRATION-1.21.1.md` written.

## TASK-20261125-075: leftover temporary blocks (owner Large 1)

Owner: temporary blocks from movement, temporary placement and water countermeasures are not broken and remain in large numbers, so
construction is never finished. Breaking right after placing and removing all at the end in one batch were both tried with no effect. Other
projects do not struggle with this; the mechanism should be extremely simple: place it, then break it, immediately once it has served its
purpose. Find out at the root why they are left behind and fix from there. If registration is careless, fix the movement system. If they are
judged still needed, that judgment is fundamentally wrong: "still needed" has not been necessary in any test so far. Keep the site clean.

1. **Ground truth first.** From the hc1/hd1 logs (`/mnt/data/forgeaip-play/t26/out/`) and, once 074 is in, from server-side scans of new
   runs (the box and its surroundings before and after; pumpkins make every temporary block visible), count every leftover block and assign it
   to one cause: (a) placed but never registered (which code path placed it), (b) registered but the release never fired, (c) the release fired
   and the removal failed (unreachable, bot dead, another bot on it, block changed, timed out), (d) kept as "still needed" (which rule).
   The table with numbers is part of the deliverable.
2. **Every placement that is not a blueprint cell or a job's intended terrain change is temporary**: pillars, bridges, stances, posts,
   water stops, shelters, fall guards, scaffolds. It is registered when the server confirms it (not when the bot sends it), with the bot,
   the step that needed it and the stance from which it can be broken.
3. **Lifetime = the step.** The bot that placed it breaks it as soon as the step that needed it is done and before it starts unrelated
   work; if the same support is needed again later, it is placed again. Remove the "kept while work is near" and "still needed" rules
   (`unscaffold` delays, walking blocks kept for 10-90 s, the end-of-run batch). A placement is planned together with its removal: a pillar
   is dug as the bot comes down, a bridge as it walks back; a placement whose removal stance cannot exist is not chosen.
4. **Death, disconnect, preemption:** another bot (or the same bot after a respawn) takes over the removal; nothing is orphaned.
5. **Water countermeasures** that are not part of the job's result are temporary too; blocks a pit job places as its intended terrain
   (lake fill) are not.

**Done when:** the cause table is measured on real runs; at the end of every run on the 1.21.1 test worlds (pit `mine_b`, `move_a`/`move_b`,
a build) the server scan finds **zero** temporary blocks; at any minute a bot has at most two temporary blocks in place (one to stand on,
one to place against) unless the doc names a measured exception the orchestrator accepted; placing pace not worse than hc1 at equal minutes
(state the comparison); registration/release covered by tests in `npm test`.

## TASK-20261125-076: own physics and inventory instead of mineflayer's (owner Large 4, Large 3.4)

Owner: get rid of halfway dependence on external components; the system already handles movement and placement itself, and reportedly only
inventory and physics simulation remain. Built natively, version dependence disappears and they can be made more advanced. Port what is
possible and valuable. Large 3.4: a function to operate the inventory inside blocks (chests for a sorter's filter settings, adjusting
redstone strength); not in the current blueprints, so it cannot be tested with them.

1. **Measure the dependence first:** list every mineflayer / prismarine module the bot path still uses (physics, inventory and windows,
   entities, world and chunks, digging time, placement, chat, protocol) and confirm or correct the owner's "only inventory and physics".
   Decide per item: port, keep (with reason: e.g. minecraft-protocol is the wire format, minecraft-data is version data), or later.
2. **Physics** in `src/native/physics/`: the vanilla player movement for the versions in use (collisions, step-up, sneaking at edges, jump,
   sprint, water and lava, ladders and vines, scaffolding, ice, soul sand, honey, slime, cobwebs, powder snow, bubble columns; elytra out of
   scope). Tested tick by tick against traces recorded on the real server (shared format with 078) and against prismarine-physics on
   generated cases where it is known right. Keep the hook `src/build/fallguard.js` wraps (`bot.physics.simulatePlayer` or an equivalent
   both agree on).
3. **Inventory and windows** in `src/native/inventory/`: slots, cursor, state ids, every click mode, crafting, furnaces, containers; the
   server's reply is the truth and a mismatch resyncs. Find the click conflicts the owner saw with the server mods (26.x and 1.21.1 sets) and
   show they are gone.
4. **Container contents (Large 3.4):** an atomic instruction that puts given items in given slots of a container (filter hoppers and
   chests of a sorter; a comparator's signal strength from item counts, `1 + floor(14 * fullness)` for a non-empty container), with
   preconditions in `src/skills/preconditions.js` and a router rule; the build job sets container contents from the blueprint's tile-entity
   data (Litematica stores them) using items from the real supply. Make a small test blueprint (a sorter cell with a filter hopper and a
   comparator reading a container with a set strength) and grade it from the server (`data get block`).
5. Wiring: native physics and inventory are the default; a setting switches back to mineflayer's for comparison.

**Done when:** the dependence list with decisions is in the doc; native physics and inventory are the default; golden traces pass in
`npm test`; on 1.21.1 test worlds `move_a`, `mine_b`, `place_a` with native modules are not worse than with mineflayer's on the same seeds;
the container test passes server-graded; `docs/implemented/NATIVE-v1.md`.

## TASK-20261125-077: WebUI and in-game display (owner Small 1-3)

Owner: (1) route and marker displays are temporary and disappear at once, hard to follow: keep drawing them as long as they are valid;
(2) probably because of the route display, glass and redstone flicker badly (the blocks exist, their display turns on and off); (3) WebUI:
the map does not update on tabs other than Map; Top=ground in Pit does not work; tabs do not keep their previous selection; tools are
supplied and stored by tags, but tabs (Pit especially) still have half-finished chest selections; the inventory tab is all text and shows
the first block id, so smooth stone slab and smooth stone look the same; take textures from in-game data; show durability as the game does.

1. **Display lifetime:** a route or marker exists exactly as long as what it shows is valid (the bot's current path, a claimed cell, a
   stance) and is updated in place; no periodic kill-and-resummon.
2. **Flicker:** find the cause before changing anything. Candidates: `block_display` entities overlapping translucent blocks, display
   entities killed and summoned every few ticks, block updates from the carpet scripts (`docker/t26/dev.sc`, `vacuum.sc`), lighting.
   Measure with an observer client on a test world (block-change and entity packets for the flickering cells). Fix the cause.
3. **WebUI items** above, each one. The inventory shows icons from the game's own textures (taken from the Minecraft client jar of the
   server's version at deploy or first use, cached on `/mnt/data`, never committed), the item's own name and id (item registry, not block),
   count and a durability bar drawn as the game draws it (bar width `round(13 - 13 * damage / max)`, colour hue `(1 - damage / max) / 3`).
   Selections persist per tab. Remove chest selections that tags replaced (keep anything the server still uses, and say what).
4. Console security unchanged (session, CSRF, Host/Origin, proxy-header refusal, closed validation, strict CSP; textures from the same
   origin).

**Done when:** each item is checked in a headless browser against a disposable test console (never the production consoles) with a
screenshot named in the report; the flicker cause is shown with packet counts before and after; pure parts tested in `npm test`; the
orchestrator deploys.

## TASK-20261125-078: the Rust simulator matches the real server (owner Large 2)

Owner: the Rust server for RL gives results that often differ from the actual server. Run the same world and the same bot actions as the
test server, monitor whether results match, fix what does not, and make it good enough to be practical for testing.

1. Read `docs/proposed/SIM-RUST-v1.md` and `tools/sim` (skill-level: commands as transitions over world matrices from real region files).
2. A recorder for the 1.21.1 test worlds: the box's region before, each command the bot ran with its arguments, and the server-observed
   outcome (position, block changes, inventory, ticks taken, reason). The replayer runs the same commands on the same region in the
   simulator and compares outcome by outcome; every divergence gets a category (movement reach, collision, dig time, placement rules,
   fluids, drops, gravity blocks, hunger, light).
3. Fix the simulator category by category, largest first, until the corpus (traces of move, pit, place and build runs) matches on a level
   you define up front and defend (for example: identical outcome and reason on 98 % of commands, ticks within 10 %), with every remaining
   divergence listed.
4. "Usable for testing" and Medium 3 ("make use of the Rust server"): measure what it would take for the real bot code (pit, build) to run
   against the simulator (a protocol front end speaking 1.21.1, or an adapter below `execute()`), prototype the cheaper one, and report
   the measured speed-up and fidelity before building it out.

**Done when:** recorder and replayer committed; the parity table before and after; the agreed level reached on the corpus; the
testing-backend decision with measurements; `docs/implemented/SIM-PARITY-v1.md`.

## TASK-20261125-079: faster test runs (owner Medium 3)

Owner: one test run takes at least an hour; raise the server's plain processing speed with the time acceleration tried early in RL, and use
the Rust server (078).

1. 1.21.1 has `/tick rate` (no mod needed); the bots scale with `GAME_SPEED` (`src/transport/time_scale.js`, LESSONS L16: every wait
   counted in ticks scales). Measure the tick time of a build batch at 1x and find what limits the rate (bots x speed on one tick thread,
   chunk loading, entity count, lithium settings, view and simulation distance, pregenerated chunks, CPU and memory per container).
2. Find the highest factor at which the T26 tests' results do not change (same seeds at 1x and kx, server-graded), and make it the test
   worlds' default.
3. Hand the slow parts that remain to 078's testing backend where it is faithful.

**Done when:** the measured factor and its evidence (results equal at 1x and kx); wall time of a standard build run before and after; doc.

## TASK-20261125-080: CI over everything (owner Medium 2)

Owner: while Litematica construction is the focus, one part may stop working after another is built (pit, movement, tags). Introduce CI and
test the parts that are not the main focus, to see harmful side effects or unintended improvements.

1. GitHub Actions: `npm test` on every push to main (Node 20), `cargo test` for `tools/sim`, scip-neo4j unaffected.
2. A live regression suite on the VPS (slot 9, at the 079 speed): pit (`mine_b`), movement (`move_a`, `move_b`), tags (supply and storage
   by tag), place (`place_a`, `place_b`, `place_c`), a short build, the container test of 076, on fixed seeds plus one random, on each new
   main commit (debounced) or nightly outside 03:00-06:00. Results kept as history (per commit: pass/fail, rates, times) with the change
   against the previous run shown both ways (worse and better).
3. Results visible to the owner (a page in the console or a static report) without exposing anything new to the internet.

**Done when:** both CI layers run on main; a deliberately broken commit on a branch is caught by the suite (negative control); history
page live; `docs/implemented/CI-v1.md`.

## TASK-20261125-081: make a build finish (owner Large 3.1-3.3)

Owner: no construction has fully succeeded. Known mechanisms are not reused: pit has proven mining, yet removing terrain in the way of a
build is a separate custom system: reuse the dedicated mechanism. (1) Find why the placements left in the last run were left, and resolve
them. (2) Subdividing placement is inefficient: subdividing means dividing the work into chunks that can be placed all at once (a bridge
100 blocks long is one piece of 100), not small 3x3 areas; the current split makes the bots pause and move wastefully. (3) The bots stop for
a few seconds every time: separate the cause (processing time, an error repeated until a retry limit, or bots getting in each other's way).

1. **Clearing = the pit.** Terrain removal before and during a build goes through the pit job's mining (`src/work/jobs`, the pit expert /
   sweep), not a builder-specific digger. Remove the builder's own clearing code once the pit path covers it.
2. **The cells left in hc1/hd1:** list them with the reason each was left (closed in by build order, no stance, supply, temporary block in
   the way, ...) and fix each cause.
3. **Work units by shape:** units are maximal runs that one bot can place in one continuous motion (a line along a bridge or a wall, a
   column, a floor strip walked along), not fixed areas.
4. **Pauses:** instrument each bot's time between consecutive actions; classify every pause over 0.5 s (planning CPU, a repeated error
   and retry, waiting for another bot, waiting for the server); fix by cause.

**Done when:** a full iron-farm-34 build finishes cell-correct on a 1.21.1 test world (server-graded), with zero temporary blocks left
(075's scan); the pause table before and after; the builder's own clearing code removed.
