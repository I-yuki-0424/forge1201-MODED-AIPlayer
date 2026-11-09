# EXPERTS-v1: the trained movement and stuck-escape experts in the bots (2026-11-09)

`TASK-20261109-046`, part 3. The RL experts of [MOE-v2](../proposed/MOE-v2.md) that reached high accuracy in the simulator (`move`, `unstick`) now run inside the work layer on the real game, and take over the moves that used to end in a server teleport or a failed walk. Nothing else of MOE-v2 is wired (the ore, crafting and chain experts are not used by any bot yet).

## What a bot does differently

| Situation | Before | Now (setting `experts`, default on) |
| :-- | :-- | :-- |
| the escape ladder's `return` fix (`env.recover`): the bot is 3+ levels from its last good place, or 24+ blocks away, up to 60 blocks | the server `tp`s it back (`env.back`), or the planner walks it (and walked into pits) | the **stuck-escape expert** (levels) or the **movement expert** (distance) takes it back on foot, digging and climbing; the server moves it only if that fails |
| a recovery `lift` (`purpose: 'recover'`) | `tp` to the nearest standable cell | the stuck-escape expert walks, digs and climbs to that cell first; `tp` only if it fails, and not at all with setting `teleport = off` |
| a long walk where no leg can be walked (`env.travel`, `bot/travel.js`: `unreachable`, `stuck`, `timeout`, `not_visible`) | the walk fails | the movement expert takes the bot toward the target inside the loaded chunks, then the legs go on |
| operator commands (Movement group) | - | `expert_walk x y z` and `expert_escape [x y z]` (without a cell: the open ground around, found from the loaded chunks by `src/experts/ground.js`) |

Every use writes one line to the service log (`<bot>: the unstick expert got the bot from ... to ... in N steps, S s: <why>`) and counts in `rec.expertUses`. Setting: `PUT settings {experts: false}` turns all of it off. Job moves (`purpose: 'job'`: pit exits, `rejoin`, `goBack`) are unchanged: they stay server moves or pillars.

## How it works

```
src/experts/policy.js    the trained network (moe/policy.py) in plain JavaScript; weights models/experts/{move,unstick}.json (moe/export.py from the final.npz of /mnt/data/forgeaip/moe2/pc-runs/c4)
src/experts/features.js  moe/features.py in JavaScript: observation -> context vector and candidate rows (+ masks: the expert's action space, the distraction filter)
src/experts/space.js     SkillSpace (src/rl/skill_space.js: the same 64 candidates the simulator was ported from) + the scan of the target, scan moves, progress and `seen` columns
src/experts/runner.js    observe, ask the network, run the chosen command through the action layer, until at the target / budget / cancelled / no progress (sample, then give up)
src/experts/ground.js    the open ground above a stuck bot (for expert_escape without a target)
src/experts/index.js     walk(bot, target), escape(bot, target), drive(bot, name, target, opts)
```

The experts choose among the action layer's own commands (`move_to`, `mine`, `tunnel`, `attack`, `pickup`, `eat`), so every rule of the work layer still applies: the bot's cancel (attacked, drowning, operator), fixtures (a chest that is not the bot's own is never broken), tool rules. They see one target cell (group `way` of the simulator's scan); for the stuck-escape expert the caller names the cell (the last good place, a standable cell, or the ground above).

## Checks

- **Parity** (`tests/test_experts_pure.js`, in `npm test`): 28 observations recorded from the simulator, the context vector, candidate rows, mask and scores of the JavaScript code equal the Python ones (worst difference 6e-6 in a score), the greedy action is the same in all 28; runner tests for budget, cancel, fatal reasons and the stall rule.
- **Live, real Forge server** (`scripts/work/expert_live.js`, the demo server, stone arena in the sky, graded by the server's position of the bot): 13 of 13. Open ground 30 blocks (2 steps, 7 s); round a 41-block wall (3 steps, 8 s; the plain planner: 10 s); shafts 4 / 8 / 14 deep (4 / 8 / 14 steps, 10 / 25 / 48 s: a staircase up); sealed pockets 6 / 12 under the surface (7 / 13 steps, 23 / 46 s); `expert_escape` without a target from 6 and 10 deep; the escape ladder from 9 levels down with `teleport = off`; a walk out of a walled courtyard where no leg can be walked; and no server move in any of them.
- **Not measured**: how often the experts are used in a real pit job, and what they cost there. After the console restart, `health.jsonl` (`time.lift`, `time.recover`, `failed`) and the log lines above are where to look.

## A bug found by the live check, fixed in `src/skills/world.js`

`fromBot(bot)` kept the world model of a bot for good once built. A model built before the world object had its state-id readers (or kept past a respawn / dimension change, when mineflayer builds a new world object) has no `sid`: no reach flood, no filter on candidates, `blockAt` for every lookup. The first live run of the stuck-escape expert was offered moves out of a shaft that no planner can walk and failed 0 of 5; with the model rebuilt it passes 5 of 5. The model is now rebuilt when `bot.world` changes or when it lacks `sid` while the world has the readers. This is shared code (the work layer, the RL env, the LLM bot): a bot that had the stale model now gets the fast path.

## Limits

- Only `move` and `unstick`. The scan is the one target cell the caller gives; the log/coal/iron groups of the simulator's scan are not computed on the live side.
- The experts **dig**. Stuck inside the owner's build, an escape can break blocks of it (only boxes that are not the bot's own are protected). That is the price of getting out; turn `experts` off to go back to the old ladder.
- The numbers of MOE-v2 (0.98-1.00) are simulator numbers; the live check is 13 cases on a flat stone arena, not natural terrain, lava, water or mobs.
- The experts act at about 1-3 s per command (the action layer's own speed); a 14-level shaft takes 48 s.
