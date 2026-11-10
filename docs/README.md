# Documentation map

Start of a session: search the knowledge-DB and run `schedule_check` (runtime state lives there since MASTER_GUIDANCE v11), then read
[core/GOAL.md](core/GOAL.md) (purpose, DPOD link) or [ARCHITECTURE.md](ARCHITECTURE.md) only for the sections the task needs. The rules are
[core/MASTER_GUIDANCE.xml](core/MASTER_GUIDANCE.xml); [core/STATE.yaml](core/STATE.yaml) is a frozen v10 snapshot (history, not updated).

| Where | What | Changes how |
| :-- | :-- | :-- |
| `core/` | Rules (`MASTER_GUIDANCE.xml`), goal (`GOAL.md`), frozen v10 state (`STATE.yaml`). Read only the parts a task needs. | Edited in place; `STATE.yaml` no longer updated |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Original design spec: FML3 bridge, registry injector, middleware, process model | Rarely; code wins on conflict |
| [LESSONS.md](LESSONS.md) | Incidents and the rule each one produced (read before changing LFS, Node, ports) | Append |
| `guides/` | How-to for operators and AI agents ([AI_DEBUGGING.md](guides/AI_DEBUGGING.md)) | Edited |
| `references/` | Facts: [variable_map.md](references/variable_map.md) (env vars, IPC), `forge-fml3/` (Forge source copies used to reverse-engineer the handshake, LGPL-2.1, not built), `PROJECTSTART_MANUAL` moved to archive | Rarely |
| `proposed/` | Specs not yet built: WORKERS-v1 (pure bots: crew ledger, open-pit and structure jobs, inventory upkeep, play world; code in `src/work/`, first slice built), RL-TRAINING-v2 (reward, skill-level actions, curriculum, training operation), SIM-RUST-v1 (the Rust simulator and its validation against the real server), TRAIN-STATUS-v1 (learning-status record and the stop-and-rethink verdict), the 2026-10-30 RL-platform roadmap (tasks 006-014), goal-decomposition tree, future improvements, the pending world-validation task | Moves to `implemented/` when done |
| `implemented/` | One file per finished task or bugfix (`TASK-…`, `BUGFIX-…`, `VDS-001`); [MOVE-v3.md](implemented/MOVE-v3.md) is the learned cell-level walk (simulator, policy, live measurements) and [PIT-EXPERT-v1.md](implemented/PIT-EXPERT-v1.md) the open-pit station planner; [RL-INTERFACE-v1.md](implemented/RL-INTERFACE-v1.md) is the RL environment, action space, goals, server and measurements; [SKILLS-v1.md](implemented/SKILLS-v1.md) is the action layer (14 commands from player inputs, failure taxonomy, debugging, measured success rates, the LLM intent layer); [WORLD-v1.md](implemented/WORLD-v1.md) the persistent build world (connect, mods, snapshots, test copies, the LLM bot and its vault record); [MODPACK-v1.md](implemented/MODPACK-v1.md) the mod set (vanilla + Create + optimisation, client install) and the bot's exact mod block/item table; [EXPERTS-v1.md](implemented/EXPERTS-v1.md) the trained movement and stuck-escape experts in the work layer (hooks, setting, live checks); [ROUTE-v1.md](implemented/ROUTE-v1.md) the chunk-exit movement router (learned exit choice per chunk + the path calculator, waypoints in the destination chunk, training simulator, measured error rates and compute load); [MOE-v1](proposed/MOE-v1.md) the expert catalogue, router and training on the VPS (`moe/`); [MOE-v2](proposed/MOE-v2.md) the target scan, movement and stuck-escape experts, the stall reflex and training on the PC, with the architecture diagram [moe-v2-architecture.svg](diagrams/moe-v2-architecture.svg); [WORK-CONSOLE-v1.md](implemented/WORK-CONSOLE-v1.md) the web console for the pure bots on the play world (bots, pits, structure editor, builds, security basis, aux-mod decision) | Append only |
| `archive/` | History before the 2026-10-30 cleanup: old state, activity log, task index, plans. Not maintained | Never |

## Knowledge-DB

Everything under `docs/` is indexed automatically after each push (search path prefix
`repos/forge1201-MODED-AIPlayer/`), which makes it searchable from every other repo's sessions. Two
consequences:

1. Give each doc a specific first heading and a one-sentence opening: the index summarises from them.
2. Problems that cost real time (cause, fix, failed attempts) go to the knowledge-DB as a `rare-case`
   note (`record_memory`), not only here. This repo's entries are tagged `forge1201-moded-aiplayer`.
   Short rule-shaped lessons also go to [LESSONS.md](LESSONS.md).

Related notes already in the knowledge-DB: `repo-notes/decision-process-order-driven/` (research method
failures: e.g. check a positive control before trusting a null result), `LLM-records/` (operational fixes).

## Task workflow

1. Pick or create the task in the knowledge-DB (schedule entry + one memory record, MASTER_GUIDANCE `<task_tracking>`); large specs go to `proposed/` and are referenced by `spec_ref`.
2. Implement; run `npm test` (see [../CLAUDE.md](../CLAUDE.md) for the docker command).
3. Record the change and `smoke_status` in the knowledge-DB, move the spec to `implemented/`, commit as
   `TASK:<id> <type>: <description>`, push.
