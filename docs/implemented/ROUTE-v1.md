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

RESULTS-PLACEHOLDER
