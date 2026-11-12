# COMMAND-STACK-v1: every command passes the router and an expert with preconditions before it reaches the body (2026-11-12)

`TASK-20261112-062`. The owner's design rule of 2026-11-12: the lowest instruction a bot accepts is a machine-language instruction that checks its own preconditions and halts on an invalid one; only an expert (called by the router) or a debugging session may issue it; the operator, Pit and Build speak only to the top of the stack.

## Why (measured on 2026-11-12, owner's try-out on `Work1`, then a code audit)

Of the commands the owner sent from the console, `mine` and `place` worked only within a few blocks, `bridge`, `tunnel` and `activate` failed on missing preconditions, `gather` on an item-name mismatch (`redstone_dust`; the item is `redstone`). The audit found:

- `_exec` (`src/work/service/commands.js`) gives only `move_to` the long-walk path (`env.travel`: router, legs, movement expert). Every other command goes straight to `skills.execute`, whose command function **walks by itself** (`approachBlock`, `approachUntil`: a plain planner, 1200 ticks) before it acts. A command is therefore not an instruction but a macro with hidden microcode, and the microcode is what fails beyond a few blocks.
- Wired experts: `move` and `unstick` only ([EXPERTS-v1](../implemented/EXPERTS-v1.md)). The 12+ item experts and the XGBoost/LightGBM router of [MOE-v1](MOE-v1.md) are Python-only. The "99 %" of the router is agreement with the hand-written rules on sampled states, not task success.
- Callers of the lowest layer: `env.js` (9 sites), `commands.js` (4), `gather.js` (3), `moves.js`, `intents.js`, `run_skill_env.js`, `experts/index.js`. Nothing forbids a human or a job from calling it.

## The stack

```
operator (console)  ·  Pit  ·  Build  ·  gather            top: goals ("mine 16 iron_ore", "dig this chunk"), never a command
        │
ROUTER  (rule-based; teacher = rules + success/failure signal; learned router only when it beats the rules on the real-world copy)
        │  writes an ordered list of expert calls, checks the order's preconditions against the world model
EXPERTS (move, unstick, mine, place, craft, ... ; each declares `requires(world, pack, args)`; a learned policy picks HOW, never WHETHER the precondition holds)
        │  emits instructions
INSTRUCTIONS (the 15 commands, made atomic: no walking inside; `precondition_failed {need: ...}` and halt)
        │  per-tick frames
BODY (keys, look, hotbar, attack/use, Q/F)   ->   transport (mineflayer: protocol, chunks, inventory, physics)
```

Debugging bypass: the operator's "Debug" page (setting `rawCommands`, default off) calls the instruction layer directly and says so on every result.

## Rules

1. **An instruction never walks.** `mine`, `place`, `activate`, `attack`, `pickup`, `tunnel` get a precondition set instead of an approach: target chunk loaded; target within reach (`BLOCK_REACH`) and visible from the current feet cell, or (for the blind work-layer variants) within `BLIND_REACH`; item in the pack; cell holds what the command expects (`mine` of air is `invalid_target` already). A missing precondition ends the command at once with `reason: precondition_failed` and `detail.need` naming it (`in_reach`, `line_of_sight`, `stand_cell`, `item`, `chunk_loaded`). The reasons taxonomy of `src/skills/runner.js` gets this one entry.
2. **An expert owns its preconditions.** `requires()` returns the list of unmet conditions and, for each, the expert that can satisfy it (`in_reach` -> `move`, `line_of_sight` -> `move`, `item` -> the item expert, `stuck` -> `unstick`). The router reads that, never guesses.
3. **The router composes, rule-based.** Input: a goal and the world model. Output: the shortest chain of expert calls whose preconditions are met in order. A failed call returns to the router with the unmet condition; the router retries once with the missing expert in front, then reports. The rules are the teacher: the generated chains are labelled by whether the server confirmed the goal state and by length, which is the signal a later learned router and the experts' RL need.
4. **The top never names an instruction.** The console form "mine x y z" becomes the goal `have-broken(x,y,z)`; `place` -> `have-placed`; `gather` -> `have-count(item, n)`; Pit units -> `have-dug(cell)` from a station. The forms stay; what they send changes.
5. **Mineflayer stays behind one interface.** Today it is used as protocol, chunk and inventory state, and the physics step (`Body` calls `setControlState`); pathfinding and digging are the repository's own in the action layer (the old pathfinder lives only in the legacy actuator). `fromBot` (`src/skills/world.js`) is already the read model and `Body` the write side. Replacing mineflayer means replacing protocol, chunk parsing, inventory and physics: large, and the physics is what makes a frame trustworthy. Decision: keep it, close the interface (nothing outside `src/transport`, `world.js`, `body.js` touches `bot.*`), reconsider after the stack works.

## Build order (each step measured on the real-world copy, `scripts/real/`, with a negative control; the simulator is a smoke test)

1. `precondition_failed` for the six commands and a `requires()` per command (pure functions, unit tests); no behaviour change for callers that already stand in reach.
2. Router v0 (rules): goal -> chain, with `move` / `unstick` / the existing item scripts as the experts; the console forms send goals. `mine` and `place` beyond 5 blocks are the first acceptance test (target: >= 80 % at 5-40 blocks on natural terrain, as the movement standard).
3. Gate: `rawCommands` setting; `_exec`, `gather`, `env.exec` callers move to the router; a test fails if a module outside the router and the expert folder imports `skills.execute`.
4. Per-command experts for the rest (`activate`, `tunnel`, `bridge` as an expert with its own stand-cell search, `attack`); name aliases (`redstone_dust` -> `redstone`) in the goal parser, not in the instruction.
5. Learned routers and experts replace rules only where the real-world copy shows they win.

## Risks to settle before step 1 ships

- The item experts of MOE-v2 were trained in the simulator, where `mine` and `place` include a short walk. Making the instruction atomic changes their action semantics: retrain, or keep a `walk_in_reach` macro-candidate in the simulator that the router replaces with an explicit `move` in the real stack. Not decided.
- Pit and Build call `mine` and `place` thousands of times per job from a station. They already stand in reach, so they must pass the new check at no cost (no extra raycast per call beyond the one `mine` does today); measure the unit rate before and after (baseline 50-58 units per minute in the last pit).
- The `precondition_failed` check duplicates what `approachBlock` does inside; remove that internal walk only after step 2 is live, or `mine` regresses for every caller at once.
