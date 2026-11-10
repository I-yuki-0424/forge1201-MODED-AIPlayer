# ROUTE-v1: the chunk-exit movement router, a learned policy plus the path calculator (2026-11-10)

`TASK-20261110-056`. Movement in the work layer is now planned chunk by chunk: a small learned policy chooses where the bot leaves each chunk, the path calculator (`move_to`, the A* of `src/skills/planner.js`) walks between two such points, and in the destination chunk the policy makes waypoints. It replaces the old 40-block legs of `bot/travel.js` as the first thing `env.travel` tries; the legs and the trained movement expert of [EXPERTS-v1](EXPERTS-v1.md) stay as the fallback.

## Why (measured on the live play console, 2026-11-09 06:26 to 2026-11-10 07:14 UTC)

Of 26,000 problem records, the movement ones were not long horizontal walks. The big groups were `janitor_failed unreachable` at the approach to a container (`could not get to the container (42 / 59 / 62 / 108 levels away; unreachable)`, about 12,000 with the `start cell not standable` and `reach block` records beside them) and `unit_failed unreachable` at `station` (`too far from the station to dig a corridor toward it`, about 1,800) and `rejoin` (about 2,000). With `teleport` off, the server `lift` that used to bridge those levels refuses, the old `travel` never looked at levels (a leg ends within 24 levels of where it starts), and the planner's own search (6,000 cells) runs out in a big open pit before it finds the one-block haul road. The health rows of the last three hours before the deploy: 54 % of unit attempts failed (almost all `unreachable`), 6.7 of the 20 bots working on average, event-loop lag 0.4 s on average, 8 s at worst.

## How it walks (`src/experts/route/`)

```
candidates.js  chunk line, exit cells, waypoint cells, what lies ahead of a cell, the path calculator's reach (Dijkstra, sliced)
features.js    DK = 18 numbers per candidate, DC = 8 of context (the contract with models/experts/route.json)
policy.js      score = linear term + 16-unit tanh network over [candidate, context] (474 parameters); the linear term starts as a heuristic
router.js      route(env, to, opts): the loop; same call and result as travel.js
stats.js       counters (window per health row, totals)
tools/route/   the simulator (sim.js), one episode, thread pool, eval.js, train.js (evolution strategies), bench.js
```

1. **Chunks.** The next chunk is the next one on the straight chunk line between the bot's chunk and the target's. The candidates are the standable cells of the first row of the chunk beyond each side of the bot's chunk (16 columns per side, the two cells per column nearest the bot's level, any level between the bot's and the target's, +-6): the sides toward the target (`fwd`), the sides across (`lat`, to go round a wall or a lake), and the sides behind only after two stalls. The policy scores them; the highest score is walked with `move_to`. A move that fails is remembered (tabu) and the next decision sees it; four failed exits in a row end the walk with the failure's reason.
2. **Destination chunk.** When the bot stands in the target's chunk it makes one waypoint per 3 blocks (rounded down) of the straight-line distance to the arrival point (3-D when the level is known): the policy chooses among the cells within 2 blocks of the ideal point, the last waypoint is the arrival point itself. *Reading of the instruction:* "one for every third (rounded down) of the straight-line block distance" was taken as `floor(d / 3)` waypoints, one per 3 blocks; the other reading (waypoints at 1/3 and 2/3) would be a one-line change in `waypointCount`.
3. **Not going back and forth.** Every chunk entered is counted (`visits` is a feature); a leg that ends in a chunk already walked and brings the bot no closer than 2 blocks counts toward a stall; 8 of them end the walk `stuck`. A leg into a new chunk is exploration and resets the count (going round a wall gets no closer for a while).
4. **Levels.** A target may carry `level` instead of `y` (a chest, a station: a block, not a cell). The walk then ends within `near` blocks across and `nearY` levels (default 8) of it, with no exact last step. `reach.js` (a container in another layer) and `pit.js` (`goToStation`, before it gives up) use it; the old legs, as fallback, cannot judge a level and a walk that ends at the right place across but not at the level is reported `unreachable`.
5. **What it sees.** Only what the bot has itself: the loaded chunks (`kindAt`), and the reach of its own path calculator within 32 blocks (2,500 cells). No oracle. The policy never sees the target's surroundings beyond the view distance.
6. **Failure.** If the router fails, `env.travel` tries the old legs, then the movement expert, exactly as before (setting `router: false` skips the router). The caller sees one result; `stats.js` counts the router's own outcome and the final one separately.

## The policy and its training

The score of a candidate is `lin . x + w2 . tanh(W1 x + b1)` over 21 candidate numbers and 9 context numbers. The linear term starts as a hand-written heuristic (reach of the path calculator, progress, level gain, no tabu, no turning back, inertia along a wall, sides and frontier only when the front is blocked), so an untrained policy is the heuristic, never random. It is trained on the simulator by **evolution strategies** (`tools/route/train.js`: antithetic sampling, centred ranks, Adam; no gradient through the environment; 34 generations of 16 members x 24 episodes, about 25 minutes on 3 niced cores, only the linear term evolved: with the 450 hidden weights as well the first run, 44 generations, did not move off the heuristic).

The simulator (`tools/route/sim.js`) is a height-field world with eight kinds of obstacle (open ground, a ridge with one gap, a U-trap, a steep-banked lake, a canyon with one bridge, a cliff with one ramp, a deep pit with a haul road and a far target, the same pit with a chest on the rim 20-80 levels above), the real `planner.js` as path calculator with the work layer's budget (6,000 cells, five re-plans after a partial path, `motion.js`'s walk loop), and the bot's view limit (9 x 9 chunks). Arrival is judged by the simulator, not by the walk's own word. Return = arrival (600) - blocks walked - 25 per failed move - 0.005 per planner cell.

### Held-out test, 240 episodes (30 per kind; seeds used neither for training nor for choosing the policy)

| | arrived | failed `move_to` / call | failed `move_to` / episode | planner cells / episode |
| :-- | --: | --: | --: | --: |
| old legs (`travel.js`) | 47.5 % (114/240) | 14.3 % | 0.57 | 8,285 |
| router, heuristic weights | 73.3 % (176/240) | 11.3 % | 1.09 | 8,306 |
| router, trained weights (**shipped**) | **74.2 % (178/240)** | 13.5 % | 1.25 | 10,531 |

By kind (30 each), old legs / shipped router: open 30 / 30, ridge 30 / 30, U-trap 30 / 30, lake 7 / 20, canyon 15 / 14, cliff 0 / 19, pit 2 / 21, chest on a rim 0 / 14.

What this says, plainly:
- **The structure is what wins, not the learning.** Trained against heuristic weights is +0.9 points (2 episodes of 240) with a 95 % interval of about +-5.5 points, and the trained policy has the lower return (97.9 against 110.4) and more failed moves. It was shipped because it is the policy chosen by the validation set (as asked: a rebuilt RL model); deleting `models/experts/route.json` gives the heuristic, which the held-out test cannot tell apart from it. Whether more learning (PPO on the real chunk data, a curriculum of failures from the live log, the hidden layer with more episodes) would add anything is open.
- **Per walk the failure rate halves (52.5 % -> 25.8 %); per `move_to` it is about equal (14.3 % / 13.5 %), per episode it is higher (0.57 -> 1.25 failed moves).** The router tries exits the old legs never tried; most failed moves are cheap (a move that is unreachable is rejected at once), and a failed exit is followed by another, not by giving up. The canyon (a ravine whose bridge is 15-70 blocks along the edge) is not better than the old legs: the router follows a wall by inertia, but loops between chunks it has walked more often than it finds a bridge outside its view.
- Not measured in the simulator: the old fallback (the trained `move` expert after a failed leg), because it needs the Rust simulator of [MOE-v2](../proposed/MOE-v2.md); the comparison above is router against the old legs alone.

### Real Forge server (demo, flat world, obstacles built with `/fill`, graded by the server's position of the bot): `scripts/work/route_live.js`

Run with the shipped model (the first run, with the first heuristic version, gave the same outcomes): router 4/4, old legs 3/4. Open ground 200 blocks, a wall 30 high across the way with a gap 60 blocks aside, and a U-trap that opens away from the target: both arrive (router 54 s in 9 decisions, old legs 59 s; the first heuristic version needed 14-16 decisions and 59-62 s). A level 30 above with only a one-wide staircase up its face (a block target, only the level asked): the router climbs it (70 s, one failed move), the old legs fail `stuck` at the foot. n = 4 scenarios, so this is an existence check, not a rate; a lake, a canyon and a pit as deep as the simulator's cannot be built in a flat world (the bottom is 3 blocks down).

### Live on the play console (20 bots, the End pit; deployed 2026-11-10 08:46 UTC, 39 minutes measured; `scripts/work/movement_report.py`)

| | before (3 h) | after (39 min) |
| :-- | --: | --: |
| movement failures (walk failed: container, station, rejoin) per 100 unit attempts | 52.4 | 15.3 |
| movement failures per working bot-hour | 205 | 38 |
| units finished per minute (bots working on average) | 11.1 (5.4) | 20.1 (11.5) |
| event-loop lag, mean / max | 356 ms / 6.8 s | 321 ms / 5.5 s (the restart) |

**Read with care:** the deploy is a console restart, which resets stranded bots, so before and after are not the same population (5.4 against 11.5 bots working). A clean A/B needs the setting `router` switched off and on again on the running console; it was not done (the instruction was to deploy once and hold off). What is solid: the `janitor_failed ... could not get to the container (N levels away)` records, 12,000 in the day before, did not occur once after the deploy (`reach.js` now walks to the level when the server may not move the bot). What is not solved: the End pit's `station ... too far from the station` (242 of the 286 movement failures after) is a void between the arrival platform and the island, which no walk crosses (the level bridge, [WORK-CONSOLE-v1](WORK-CONSOLE-v1.md) v19, is the way); the router is asked there once per unit and fails.

The router's own counters (health row `route`): 441 walks, 85 arrived (19 %); 349 fell back to the old legs, which arrived 4 times; 92 walks ended `ok` in all. These walks are the hard ones (the old code did not try a walk at all in most of these places), most of them in the End.

### Computing load

| | simulator (JavaScript, one thread) | live (20 bots, one Node process) |
| :-- | --: | --: |
| candidates + features + reach search, per decision | 14 ms (p95 21, max 31) | 25 ms on average wall time (sliced: the loop is given back every 600 cells) |
| the policy, per decision | 0.03 ms | 0.04 ms (max 0.8) |
| decisions per walk | 9 | 4.5 |
| path search of `move_to` (the old cost, unchanged) | 3 ms p50, 47 p95 | |

Over the 39 minutes: 1,988 decisions, 51 s of preparation (2 % of one core), 0.08 s of policy; 4,549 bot-seconds walking (9.7 % of the bots' time, which is the walk itself, not computing). The event loop did not get worse (mean 321 ms against 356 ms, median 66 ms, p95 628 ms). **Not critical.** The reach search is the cost (2,300 cells per decision); it is sliced like `planAsync`, and the policy is negligible.

## Where it is wired

`env.travel` (every long walk: rejoin, station, container, operator `move_to`), `reach.walkTo` (a container in another layer when the server may not move the bot: `level` target), `pit.goToStation` (once, before it gives up). Setting `router` (Automation, default on); `models/experts/route.json` (a missing or mismatched file falls back to the heuristic without a message: `defaultModel`); counters in every health row.

## Not done / open

- The End void (a bridge, not a walk), the canyon case, and the policy gain over the heuristic (above).
- The simulator is a height field: no caves, no overhangs, no doors, no other bots; the live results above are the check for that.
- Changing the number of features (`DK`, `DC`) makes `route.json` unreadable; retrain (`tools/route/train.js --linear`) or the heuristic runs.

## Reproduce

```bash
docker run --rm --network none -v "$PWD":/w -w /w node:20-slim node tools/route/eval.js --n 240 --base 3000000 --threads 3 --model models/experts/route.json
docker run -d --name route-train --network none --cpus 3 --memory 2g -v "$PWD":/w:ro -v /mnt/data/forgeaip/route:/out -w /w node:20-slim nice -n 19 node tools/route/train.js --out /out --gens 60 --pop 16 --eps 24 --sigma 0.5 --lr 0.08 --linear
docker run --rm --network none -v "$PWD":/w -w /w node:20-slim node tools/route/bench.js
(cd /mnt/data/forgeaip-play/demo && LIVE_SCRIPT=route_live.js ./live.sh)
python3 -I scripts/work/movement_report.py /mnt/data/forgeaip-play/console-data <split-epoch> 3
```
