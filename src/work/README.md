# src/work: the pure-bot work layer (bots that need no decisions)

Bots that dig pits, build structures, collect items and carry out one-off commands, beside the RL agent (nothing here is in the RL action space).
Spec and history: [WORK-CONSOLE-v1](../../docs/implemented/WORK-CONSOLE-v1.md), [WORKERS-v1](../../docs/proposed/WORKERS-v1.md). The page is `public/work/`.

```
console.js     entry point (node src/work/console.js); compose files point here
web/           the HTTP console: nothing here knows what a bot is, it calls the service
service/       WorkService: the one object everything goes through (a class in several files, one per concern)
jobs/          what a crew does together: the ledger and the job kinds
bot/           what ONE bot does: loop, environment, recovery, defence, upkeep, scripts, tagged blocks
operator/      what a person sees and sends: command forms, inventory pages
world/         the world as data: map from region files, NBT text
display/       the in-game display (particles)
escalation.js  request to the DPOD router (not wired into any job)
```

## "I want to change ..."

| I want to change ... | file |
| :-- | :-- |
| how a pit is cut up, lanes, haul road, how a unit digs | `jobs/pit.js` |
| who gets which unit, leases, retries, stuck units | `jobs/crew.js` |
| how a structure is built (scaffold, order) / edited | `jobs/build.js` / `jobs/blueprint.js` |
| "collect N of X" | `jobs/gather.js` |
| the loop of a bot at work: claim, run, wait, fix, retry | `bot/worker.js` |
| what a job may ask of a bot (execute, recover, discard, tools) | `bot/env.js` |
| moves only the work layer uses (climb, pillar) / leaving a pit | `bot/moves.js` / `bot/exit.js` |
| water rules / defence / problem log and glow | `bot/water.js` / `bot/guard.js` / `bot/problems.js` |
| what a bot keeps, throws away, puts in which chest | `bot/janitor.js`, `bot/discard.js` |
| scripts (recovery when a tool or item is missing; one tool script per class: replace-tool/-sword/-axe/-shovel) | `bot/script.js` |
| which containers a bot may use (10 chunks, Ender first) / getting it to a chest in another layer | `bot/sites.js` (`reachable`, `sources`) / `bot/reach.js` |
| the dump at the end of a finished job | `bot/enddump.js`, `_endDump` in `service/workers.js` |
| the final sweep of a pit (every chunk from the top, leftovers sent back) | `jobs/pit_sweep.js` |
| tagged blocks, purposes, labels, links, portals | `bot/sites.js` (rules), `service/library.js` + `service/links.js` (service) |
| Ender Storage (colours, what is inside) | `world/enderstorage.js`, `service/ender.js`; opening the chest: `transport/forge_windows.js` |
| what a bot never breaks / what it picked up again | `skills/fixtures.js` (rule), `bot/janitor.js` (the shulker depot) |
| long walks, portals, routes across dimensions | `bot/travel.js`, `bot/portal.js`, `bot/route.js`, command `journey` in `service/commands.js` |
| dimensions: names, limits, designated ranges, 1:8 conversion / jobs and commands in another dimension / the server jump | `world/dimensions.js` / `_dimSpec`, `checkRange`, `_enterDim` (`service/jobs.js`, `service/workers.js`), `_serverJump` in `service/commands.js` |
| work over an abyss (bridge, sneak walk back) / what is under a cell | `bot/bridge.js` (`workOver`, moves `bridge`, `sneak_walk`) / `bot/abyss.js` |
| breaking bedrock (frame, WIP) / villager trades (WIP) | `bot/bedrock.js` (setting `bedrockExploit`) / `bot/trade.js` (commands `trades`, `trade`) |
| the layer gate (a layer is read before the layer below opens) / the check itself | `needCheck`, `checkDone`, `requeueUnit` in `jobs/crew.js` / `checkLayer` in `jobs/pit.js`, hook in `bot/worker.js` |
| the shared list of placed blocks (water seals, pillars ...): registered, forgotten when broken, cleaned up / beds and blocks over chests | `bot/temps.js` (+ `place {temp}` and `mine` in `skills/commands/block.js`) / `skills/fixtures.js` (`isBed`, `coversContainer`) |
| automatic retry of stuck units (setting `autoRepair`) | `_maybeFinish`, `_watchRepair` in `service/workers.js` |
| the map's layer view (Nether) and its controls | `sliceColumns` in `world/mca.js`, `public/work/map.js`, `dimPicker` / `sliceControl` / `selectTools` in `public/work/widgets.js` |
| the trained movement / stuck-escape experts (when they run, the setting, the commands) | `useExpert`, `expertMove`, `expertEscape` and the `return` / `lift` / `travel` hooks in `bot/env.js`; the experts themselves in `src/experts/` ([EXPERTS-v1](../../docs/implemented/EXPERTS-v1.md)) |
| reflexes (fall, lava) / how a stuck bot gets out | `bot/reflex.js` / `bot/escape.js`, `recover` and `lift` in `bot/env.js` |
| routines (a script repeated until Stop), tool durability policy | `runLoop` in `bot/script.js` + `service/library.js`; `skills/options.js` (`toolPolicy`), `bot/moves.js` (`stash_worn`) |
| lines at beds and containers (FIFO, time limit, sent away) / the bed command | `bot/queue.js` (`Gates`) + `queued` / `reserve` in `bot/env.js` / `bot/bed.js`, `_setSpawn` in `service/commands.js` |
| a floor, a wall or room walls of one block (the Place page) | `jobs/layout.js` (cells), `createLayout` / `previewLayout` in `service/jobs.js`, `public/work/page_place.js` |
| a pillar with no blocks (digs one from the undug pit) / a bot put back on its feet when it gives up | `harvestBlock` in `bot/moves.js`, `env.within` / `env.goBack` in `bot/env.js`, `bringBack` in `bot/worker.js` |
| the roster, reconnecting, bot views | `service/bots.js`, `service/views.js` |
| creating, starting, pausing jobs | `service/jobs.js` |
| the worker loop's reaction to failures (retire, cool down, restock) | `service/workers.js` |
| failure memory (same failure twice parks a unit, a failed unit on hold) / bots stranded far from the job | `failureSig`, `Ledger.fail` in `jobs/crew.js` / `env.rejoin` in `bot/env.js`, `goToStation` in `jobs/pit.js` |
| where the bot time goes (activity per bot, standing still, health row) / what the page shows a bot doing | `service/health.js` (`act`, `sub`, `phase`, `sample`), `bot/worker.js` (`act`), `_actView` in `service/index.js` / `botActivity` in `public/work/widgets.js` |
| how many bots use one chest at once | `Gate` slots in `bot/queue.js`, `_slotsFor` in `service/index.js`, setting `chestSlots` |
| picking bots by number (from..to) | `botsInRange`, `_withRange` in `service/jobs.js`, `botRangePicker` in `public/work/widgets.js`, Jobs page |
| one-off commands from the page | `service/commands.js` (forms: `operator/catalog.js`) |
| anything that needs RCON (kit, players, terrain) | `service/operator.js` |
| what is drawn in the game | `display/overlay.js` (what and when), `display/shapes.js` (lines), `service/display.js` (the data) |
| a new HTTP route | `web/routes/*.js` (one file per area) and its test in `tests/test_work_console_pure.js` |
| authentication, sessions, security headers | `web/server.js`, `web/http.js`, `web/access.js` |
| the page | `public/work/page_<name>.js` (one per page), shared pieces in `ui.js` and `widgets.js` |

## Rules of the layout

- A new feature gets its own file in the folder of its role, and a test file of its own (`tests/test_work_<feature>_pure.js`, added to `npm test`).
- A file has one job and says it in its first comment line. Past about 250 lines or two jobs, split it.
- `WorkService` parts are classes whose methods are copied onto the service (`service/index.js`): `this` is the service, so a part can call any other part.
- Routes return a value (sent as JSON 200) or `undefined` (not mine); only `web/server.js` writes responses.
- The tests need no server and no Node on the host: `docker run --rm --network none -v "$PWD":/w -w /w node:20-slim npm test`. Live checks against a real
  server: `scripts/work/*_live.js` (see WORK-CONSOLE-v1).
