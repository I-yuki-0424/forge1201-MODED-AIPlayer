# COMMAND-STACK-v1: the owner's layered architecture (operator, router, experts, atomic instructions, body) and its first implementation (2026-11-12)

`TASK-20261112-062`. This is the owner's architecture in its original form, recorded as the rule for every change to how a bot is told to act; the second half says what was built from it on 2026-11-12, what was measured, and what is still open.

## The architecture (owner, 2026-11-12)

The analogy is a CPU. What is finally handed to the bot is a machine-language instruction, itself broken down into logic-gate-level frames: one tick of keys (forward, back, left, right, jump), look, hotbar, attack/use. That is the lowest layer (`src/skills/body.js`, carried to the server by mineflayer). Humans send instructions straight to a CPU almost only in a research lab, because that layer has very few safeguards and can even accept impossible instructions. The same holds here: if a person, or a running Pit, calls this layer directly, the bot does the thing that was asked whether or not it can be done, and fails in ways nobody can read.

```
operator (console) · Pit · Build · gather · routines          the very top: they ask for a result ("have-broken(x,y,z)"), never a single instruction
        │
ROUTER      basically rule-based, built on the premise that a teacher exists; writes the order of expert calls
        │
EXPERTS     the assembly-language level: each has preconditions, each acts through instructions; learned (RL) inside its preconditions
        │
INSTRUCTIONS  the machine-language level (`mine`, `place`, `move_to` ...): check the preconditions, act, or halt with a named error: the LAST safeguard
        │
BODY (frames: keys, look, hotbar, attack/use, Q/F)  ->  transport (mineflayer: protocol, chunks, inventory, physics)
```

### Rules

1. **Apart from debugging, the lowest instruction that can be sent corresponds to a machine-language instruction.** Like a micro-architecture that raises an error and halts on an invalid instruction (a move with a null operand), an instruction with an unmet precondition returns an error and does nothing. Only a debugging session (setting `rawCommands`) or an expert called from the router may issue one.
2. **What stops an expert from issuing a bad instruction is the RL part**, the idea of the DPOD project this system's RL is based on: the physical layer is judged by reinforcement learning alone. If the model is wrong it fails; the MoE structure exists to lower that failure rate, and what must be redone after a failure is small, so the cost is low.
3. **A precondition is something that can be decided uniquely, from the current state alone.** An expert or instruction does not refuse "because the router may be wrong"; it refuses only when one of its own preconditions does not hold. `mine`: the bot is within a few blocks of the block, and the right tool for breaking it is in the hand. It does not care whether the bot was far away when called, or stuck, and it does not walk, equip or name a remedy. When called while far it returns "far from the block" (`precondition_failed`, `in_reach`, with the measured distance) and halts.
4. **The router alone holds the remedy knowledge and decides from the whole state, not from the error.** Given "far", and in fact "stuck", it runs Unstick, Move, then Mine; given "far" and not stuck, Move then Mine. The router is basically rule-based. It can have a teacher because success and failure can be told apart (a genetic algorithm can do it) and the model that reaches the goal by the shortest route is the correct one; that is what makes reinforcement learning of experts and, later, of the router possible.
5. **The operator and the built-in mechanisms (Pit, Build) issue from the very top of the stack.**
6. **Mineflayer is a dependency the owner is willing to drop.** Today it is protocol, chunk and inventory state, and the physics step (`Body` calls `setControlState`); pathfinding and digging are the repository's own (the old pathfinder lives only in the legacy actuator). Replacing it means replacing protocol, chunk parsing, inventory and physics. Decision for now: keep it, and close the interface (nothing outside `src/transport`, `world.js`, `body.js` should touch `bot.*`), then reconsider.

### The lesson that fixed the design

The first draft of the stack was textbook: every layer made itself robust (an instruction that walks and swaps tools by itself, an expert that names the expert that fixes its missing condition, a router that retries once). That is what produced the failures of 2026-11-12, because it hides the state from the one component that can decide, and it duplicates a weaker movement inside every command. Small, flat, fail-fast instructions with a closed error vocabulary, and one decider, is the opposite, and is the rule.

## Why (measured on 2026-11-12, owner's try-out on `Work1`, then a code audit)

`mine` and `place` worked only within a few blocks, `bridge`, `tunnel` and `activate` failed on missing preconditions, `gather` on an item-name mismatch (`redstone_dust`; the item is `redstone`). The audit found:

- `_exec` gave only `move_to` the long-walk path (`env.travel`: router, legs, movement expert). Every other command went straight to `skills.execute`, whose function walks by itself (`approachBlock`, `approachUntil`: a plain planner) before it acts: a macro with hidden microcode, and the microcode is what failed.
- **The `place` timeout (`ticks 1200, phase walk`) was not an unloaded chunk (owner's correction): the target was a little too far for a fixed budget.** Every command carried a fixed 1200 ticks whatever the distance.
- Wired experts: `move` and `unstick` only ([EXPERTS-v1](EXPERTS-v1.md)). The item experts and the XGBoost/LightGBM router of [MOE-v1](../proposed/MOE-v1.md) are Python-only. The "99 %" of that router is agreement with the hand-written rules on sampled states, not task success.

## What was built (2026-11-12)

| Piece | Where | What |
| :-- | :-- | :-- |
| Atomic mode | `execute(bot, name, args, {atomic: true})` in `src/skills/index.js`; `Ctx.atomic` in `runner.js` | Checks the preconditions first; returns `precondition_failed` with `detail.unmet` (each `{need, ...measured}`) before any tick. Inside the command, `holdOrFail` (`commands/item.js`) and `approachUntil` (`motion.js`) never swap or walk in atomic mode; `attack` and `pickup` end with `in_reach` instead of chasing. |
| Preconditions | `src/skills/preconditions.js` | `mine` (`in_reach`, `tool_held`, `chunk_loaded`), `place` (`in_reach`, `item_held`), `activate` (`in_reach`, `item_held`), `attack` (`in_reach`, `tool_held`), `tunnel` (`tool_held`); `line_of_sight` comes from the command's own aim geometry. Conditions the command already names (air, a fixture, no tool at all, no solid neighbour) stay `invalid_target`, `protected`, `missing_tool`. |
| Budgets | `walkTicks` in `src/skills/index.js` | `move_to`, `mine`, `place`, `activate`: 1200 (activate 600) + 14 ticks per block beyond 5, at most 6000, instead of a fixed 1200. Applies to the non-atomic path too (every existing caller). |
| Router | `src/stack/router.js` | The rule table `decide` (unmet conditions + state -> steps `travel`, `unstick`, `move`, `equip`), `run` (read state, decide, act, read again; no-progress guard; at most 8 attempts), the closed-region test (`isClosed`: fewer than 300 cells reachable by the planner within radius 32), `standCells` (a standing cell within reach and in view). `ROUTED` = `mine place activate attack pickup tunnel`. |
| Top of the stack | `env.command` in `src/work/bot/env.js`; `_command` in `src/work/service/commands.js` | The operator's commands and `gather` go through the router; `rawCommands` (setting, default off) restores the direct call for debugging. Jobs (Pit, Build, scripts): `env.exec` and `env.gather` go through the router when the setting `stackJobs` is on (default off until measured). |
| Tests | `tests/test_stack_pure.js`, `tests/test_stack_sim.js` (in `npm test`) | Preconditions with measured values; atomic `execute`; the rule table (same error, different chain by state; no-progress; pass-through of non-precondition failures); the real instructions on prismarine-physics (move, equip, mine); service wiring. |
| Live smoke test | `scripts/work/stack_live.js` | Demo server, flat arena, through `runCommand`, graded by the server. |
| Real-world rates | `scripts/real/real_cmd.js` | Copy of the play world, random natural starts and targets, `mine` / `place`, router against raw, negative control. |

## Measured

RESULTS_PLACEHOLDER

## Not done (open)

- **Pit, Build and the recovery scripts still call the instruction layer directly by default** (`stackJobs` off). They stand in reach with the tool in hand by their own scripts; routing them costs one extra `equip` when they do not, and a reach search (sliced, about 25 ms) when they are out of reach. Switch on only after the unit rate is compared (baseline 50-58 units per minute) on the real-world copy.
- Not routed: `craft`, `smelt`, `deposit`, `withdraw`, `eat`, `toss`, `equip`, `look_at`, `bridge`, `journey`, `trade`, `set_spawn`. `craft` and the container verbs still approach by themselves.
- The non-atomic instruction path still walks and equips inside `mine`, `place` and the others: the RL environment, the trained experts and the item experts of MOE-v2 were trained on those semantics (a short walk is part of `mine` in the simulator). Removing the internal walk needs those experts retrained or a simulator macro that the router replaces with an explicit `move`; undecided.
- Only `move` and `unstick` of the experts are wired; the item experts and the learned router are not. The rules are the teacher; a learned router replaces them only where the real-world copy shows it wins.
- The `stuck` test is a heuristic on the planner's reach (a closed region of fewer than 300 cells); a bot in a large closed cave is "not stuck" by it and gets `travel` (which includes the movement expert) before a failure is reported.
- The mineflayer interface is not closed yet (rule 6).
- The failures of `bridge` (a WIP command: stand cell at the bot's own level), `tunnel` (`dy=1` needs a solid block at foot level in front; correct but unexplained in the form) and `gather` (`redstone_dust`: no alias for the item) are not changed by this task. Aliases belong in a goal parser at the top.
