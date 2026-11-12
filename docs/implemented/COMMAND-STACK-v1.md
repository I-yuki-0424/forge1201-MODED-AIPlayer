# COMMAND-STACK-v1: every command passes the router and an expert with preconditions before it reaches the body (2026-11-12)

`TASK-20261112-062`. The owner's design rule of 2026-11-12: the lowest instruction a bot accepts is a machine-language instruction that checks its own preconditions and halts on an invalid one; only an expert (called by the router) or a debugging session may issue it; the operator, Pit and Build speak only to the top of the stack.

## Why (measured on 2026-11-12, owner's try-out on `Work1`, then a code audit)

Of the commands the owner sent from the console, `mine` and `place` worked only within a few blocks, `bridge`, `tunnel` and `activate` failed on missing preconditions, `gather` on an item-name mismatch (`redstone_dust`; the item is `redstone`). The audit found:

- `_exec` (`src/work/service/commands.js`) gives only `move_to` the long-walk path (`env.travel`: router, legs, movement expert). Every other command goes straight to `skills.execute`, whose command function **walks by itself** (`approachBlock`, `approachUntil`: a plain planner, 1200 ticks) before it acts. A command is therefore not an instruction but a macro with hidden microcode, and the microcode is what fails beyond a few blocks.
- **Correction (owner, 2026-11-12): the `place` timeout (`ticks 1200, phase walk`) was not an unloaded chunk.** The bot walked and the target was simply a little too far to reach inside the budget. Every command carries a fixed tick budget whatever the distance (`move_to` 1200, `place` 1200, `mine` 1200, `src/skills/index.js`), so the cause is an inappropriate budget, nothing else. An earlier note named an unloaded chunk as a candidate; it was wrong.
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

The owner's correction of 2026-11-12 (what a precondition is, and who knows what) replaces the first draft of these rules. The first draft was textbook: every layer made itself robust (an instruction that walks, an expert that names its own remedy, a router that retries once). That is what produced the failures, because it hides the state from the one component that can decide.

1. **An instruction has a flat set of preconditions, each decidable from the current state alone.** `mine`: the block is within a few blocks (`BLOCK_REACH`) and the right tool for it is held. That is all. It does not walk, does not equip, does not know whether the bot is stuck or why it is far. If a condition fails it returns at once, before any key is pressed, with a reason from a closed vocabulary and the measured value (`too_far {dist}`, `wrong_tool {need}`, `air {block}`, `item_missing {item}`); it never suggests a remedy. Same for `place`, `activate`, `attack`, `pickup`, `tunnel` (`tunnel`: floor solid and a cell to dig, as `tunnelProblem` already says). The reasons taxonomy of `src/skills/runner.js` gains these names; `invalid_target` / `not_visible` stay as they are.
2. **An expert refuses only for its own preconditions, nothing else.** Same rule as for the instruction: unique, decidable, no map from a missing condition to the expert that fixes it. A learned policy decides how to act inside the preconditions, never whether they hold. An expert does not refuse "because the router may be wrong".
3. **The router alone holds the remedy knowledge, and it decides from the whole state, not from the error code.** `mine` returns `too_far`; the router also reads the state (stuck? tool in the pack? hurt? chunk loaded?) and picks the chain. Far and not stuck: `move`, `equip`, `mine`. Far and stuck: `unstick`, `move`, `equip`, `mine`. One error, two chains. Rule-based table in one file, tested on the real-world copy; the teacher is the rules plus the server's confirmation and the chain length (the signal a later learned router and the experts' RL need). No generic "retry once".
4. **Budgets belong to the work an instruction does.** Instructions that do not walk get a small constant budget. `move`'s budget is a function of the path (distance x ticks per block + planning), replacing the fixed 1200 that made a slightly longer walk end as `timeout`. A `timeout` that made progress is not a failure for the router: it issues `move` again from where the bot stands.
5. **The top never names an instruction.** The console form "mine x y z" sends the goal `have-broken(x,y,z)`; `place` -> `have-placed`; `gather` -> `have-count(item, n)`; Pit units -> `have-dug(cell)` from a station. Aliases (`redstone_dust` -> `redstone`) live in the goal parser. Debugging bypass: setting `rawCommands` (default off) calls the instruction layer directly and marks every result as raw.
6. **Mineflayer stays behind one interface.** Today it is protocol, chunk and inventory state, and the physics step (`Body` calls `setControlState`); pathfinding and digging are the repository's own (the old pathfinder lives only in the legacy actuator). `fromBot` (`src/skills/world.js`) is the read model and `Body` the write side. Replacing mineflayer means replacing protocol, chunk parsing, inventory and physics. Decision: keep it, close the interface (nothing outside `src/transport`, `world.js`, `body.js` touches `bot.*`), reconsider when the stack works.

## Build order (each step measured on the real-world copy, `scripts/real/`, with a negative control; the simulator is a smoke test)

1. The precondition check (pure function of world and pack, unit tests) in front of the six commands, with the closed reasons of rule 1; the approach walk inside them stays until step 2 is live.
2. Router v0 (rules): (goal, state) -> chain, with `move` (budget by path length) / `unstick` / `equip` / the existing item scripts as the experts; the console forms send goals. `mine` and `place` beyond 5 blocks are the first acceptance test (target: >= 80 % at 5-40 blocks on natural terrain, as the movement standard).
3. Gate: `rawCommands` setting; `_exec`, `gather`, `env.exec` callers move to the router; a test fails if a module outside the router and the expert folder imports `skills.execute`.
4. Per-command experts for the rest (`activate`, `tunnel`, `bridge` as an expert with its own stand-cell search, `attack`); name aliases (`redstone_dust` -> `redstone`) in the goal parser, not in the instruction.
5. Learned routers and experts replace rules only where the real-world copy shows they win.

## Risks to settle before step 1 ships

- The item experts of MOE-v2 were trained in the simulator, where `mine` and `place` include a short walk. Making the instruction atomic changes their action semantics: retrain, or keep a `walk_in_reach` macro-candidate in the simulator that the router replaces with an explicit `move` in the real stack. Not decided.
- Pit and Build call `mine` and `place` thousands of times per job from a station. They already stand in reach, so they must pass the new check at no cost (no extra raycast per call beyond the one `mine` does today); measure the unit rate before and after (baseline 50-58 units per minute in the last pit).
- The check duplicates what `approachBlock` does inside; remove that internal walk only after step 2 is live, or `mine` regresses for every caller at once. Holding the right tool is a precondition too, so `holdItem` inside `mine` goes the same way (Pit relies on it today: the router must put `equip` in front for it).
