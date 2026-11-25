# NAV-v1: one deterministic movement planner that owns its temporary blocks

`TASK-20261114-063` (owner 2026-11-14, problems 1 and 2). Every walk of the work layer (`env.travel`: journeys, pit stations, the router's `travel` and `unstick` steps, the old expert
hooks) is planned by `src/nav/plan.js` and carried out by `src/nav/go.js`. The previous chain (voidnav -> learned walk move3 -> chunk router -> old legs -> movement expert) stays behind the setting
`navigator = 'legacy'` as the rollback.

## Why (the shared cause of the owner's four temporary-block symptoms)

| Owner's symptom | Cause in the old code |
| :-- | :-- |
| up or down for no reason, then an error, then a forced kill left the blocks | the learned walk (move3) chose `pillar` and `descend` one cell at a time where walking worked; the five movers fell back to each other, each starting where the last one had left the bot and its blocks; the forced kill (`service/force.js`, on by default) killed bots in error loops |
| a block placed for no reason, never broken | the same policy; a placement the server applied after the 12-tick confirmation window was registered by nobody (pillar, descend and bridge registered only after the confirmation) |
| "stack, stack, break only one below" | move3 calls `pillar {levels: 1}` once per decision: every call starts with no previous block, so it never breaks the one below; a failed break of the lower block was swallowed |
| the cleanup walks with the same behaviour and adds blocks | cleanup used the same chain of movers |

## The planner (`src/nav/plan.js`)

A* over feet cells. Moves and costs: walk 1 (diagonal 1.41), up 1.3, drop 1-3 blocks 1 + 0.3 per block, swim 2.5, climb 1.5, **dig** a body cell 3 + hardness factor (never beside a fluid,
never a fixture, never another bot's block or feet), dig down, **pillar 8**, **bridge 8** (only where no ground lies within three below). The plan is first searched **on foot only** (exact A*,
no dig, no block); only when that cannot reach the goal are all moves allowed (weighted A*, 1.5). Cells dug by the path are air for the moves after them (a turning staircase does not stand on
its own dug step). Goals: a cell, a column at a level, the surface (`seesSky`: nothing but air or glass to the top). Beyond the loaded chunks the plan is partial: the reachable cell nearest the
target, penalised for depth under the start.

## The walker (`src/nav/go.js`)

Segment by segment: plan, cut into steps (walks are one `move_to` to the end of a run of walking moves; a column of pillar moves is ONE `pillar` move; a run of bridge cells is one `bridge`
move without `keep`, which takes each block away once passed), run, replan. Temporary blocks:

- registered **before** the click (pillar, descend, bridge, shelter cover), forgotten only when the world shows the cell empty;
- a climb of n levels leaves one block (under the feet at the top), a bridge leaves one (under the feet at its end); after every walk or dig step `tidy` breaks this bot's movement blocks within
  reach, never walking for it; at the goal the bot steps off its last block onto natural ground and breaks it;
- the cleanup never places a block (`noPlace`); a block it cannot reach stays registered and is reported (`sweep` -> `cells`), it is no longer forgotten (it stood in the world in
  nobody's list, TASK-20261125-075; `skills/commands/block.js` `place {temp}` registers before its click too).

Safety: the **watch** stops a step when a hostile mob comes within 4.5 blocks (a creeper 7; a shooter within 16 when the bot was hurt a moment ago) and fights it with the action layer's
`attack`; hunger is fed between steps. The **night shelter** (`src/nav/shelter.js`): from sunset (time of day 11800) under the open sky the bot digs three blocks down, puts a cover over its head,
waits for the morning (23400), breaks the cover and climbs out. Ends: the goal, `stuck` (the same step failed four times at one place, or eight segments without getting closer), `died`,
`cancelled`.

## The router (`src/stack/router.js`, problem 2)

The router now reads an instruction's preconditions from the state **before** the instruction runs and writes the chain from them (it used to run the instruction and plan only after
`precondition_failed`); the jobs go through it by default (`stackJobs` on). Movement goals reach NAV through `env.travel`.

## Measured

On the T26 worlds (docs/implemented/TEST-WORLDS-T26.md). Smoke on one world (not evidence): move_a at 150 blocks 4/4; move_b from a cave 112 levels deep: surface in 350 s by a dug staircase.
Suites: see the results table of TEST-WORLDS-T26.md.
