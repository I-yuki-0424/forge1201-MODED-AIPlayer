# Documentation map

Read order for a new session: [core/MASTER_GUIDANCE.xml](core/MASTER_GUIDANCE.xml) (rules) →
[core/GOAL.md](core/GOAL.md) (purpose, DPOD link) → [core/STATE.yaml](core/STATE.yaml) (what is happening now).

| Where | What | Changes how |
| :-- | :-- | :-- |
| `core/` | Rules, goal, live task state. The only files an agent must read at boot. | Edited in place; `STATE.yaml` after every code change |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Original design spec: FML3 bridge, registry injector, middleware, process model | Rarely; code wins on conflict |
| [LESSONS.md](LESSONS.md) | Incidents and the rule each one produced (read before changing LFS, Node, ports) | Append |
| `guides/` | How-to for operators and AI agents ([AI_DEBUGGING.md](guides/AI_DEBUGGING.md)) | Edited |
| `references/` | Facts: [variable_map.md](references/variable_map.md) (env vars, IPC), `forge-fml3/` (Forge source copies used to reverse-engineer the handshake, LGPL-2.1, not built), `PROJECTSTART_MANUAL` moved to archive | Rarely |
| `proposed/` | Specs not yet built: the 2026-10-30 RL-platform roadmap (tasks 006-014), goal-decomposition tree, future improvements, the pending world-validation task | Moves to `implemented/` when done |
| `implemented/` | One file per finished task or bugfix (`TASK-…`, `BUGFIX-…`, `VDS-001`) | Append only |
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

1. Pick or create an entry in `core/STATE.yaml`; large specs go to `proposed/` and are referenced by `spec_ref`.
2. Implement; run `npm test` (see [../CLAUDE.md](../CLAUDE.md) for the docker command).
3. Update `STATE.yaml` (`recent_changes`, `smoke_status`), move the spec to `implemented/`, commit as
   `TASK:<id> <type>: <description>`, push.
