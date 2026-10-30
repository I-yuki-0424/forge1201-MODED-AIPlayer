# Roadmap 2026-10-30: from LLM-driven bot to an RL platform with a narrow LLM front-end

**Status (updated 2026-10-30 late): first slice implemented**, see [RL-INTERFACE-v1.md](../implemented/RL-INTERFACE-v1.md): an RL environment on a live Forge server driven over DPOD's file API (013 interface, 007 server and first measurements, 008 goal contract without the LLM, 006 event emitter, 009 transport extraction). Everything else below is still description only; per-task status is in `core/STATE.yaml`. Each section is the spec
behind one task in [core/STATE.yaml](../core/STATE.yaml) (`TASK-20261030-006` to `-014`; the owner's 8 items map to 006, 007, 008, 009, 010, 011, 014 (item 7) and 012 (item 8); 013 is the RL interface spec that replaces the earlier 005). Written from the
owner's brief of 2026-10-30. Where the brief was ambiguous the interpretation is stated, and facts not
checked are marked *unverified*.

## Direction

The 2026 trend is to hand control to an LLM. The owner rejects that for this system. The target split:

- **RL policy** chooses every in-game action, at game speed, from game state.
- **LLM** (GPT-OSS 20B class) runs *once per instruction*, outside the control loop, and only translates a
  natural-language instruction into a machine-readable goal for the RL policy. It never sees game state
  per tick and never emits actions.
- **DPOD** stays a pure RL research repository. Whether its decision model becomes the policy here is an
  open question, decided in task 013, not assumed.

Order of dependency: 009 (code structure) and 006 (logging) come first because every later task needs
them; 007 (fast server) gates RL work; 010 (VPS) needs 007 and the auth fix `TASK-20261030-003`; 008 (LLM
role) and 013 (interface) are specs that can proceed in parallel; 011 and 012 are credential chores that
unblock 008 and any LFS use; 014 is a standing rule that applies to all.

---

## TASK-20261030-006 — Log-only debuggability (monitoring)

**Goal.** Any bot behaviour, including a freeze, a loop or an unexplained action, can be diagnosed from logs
alone, without watching the game and without re-running it.

**Why.** The past cost was behaviour nobody could explain. Today's evidence is scattered: `bot_system.log`
(free text), `ai_debug_<bot>.json` (a snapshot overwritten every 5 s), `ai_history_<bot>.log`,
`debug_trace.jsonl` (written by `src/debug_trace_logger.js`, 10 MB before the August LFS incident), and the
Visual Debug System of `docs/implemented/VDS-001.md`. They share no correlation key.

**Description.**
1. One structured event stream (JSON lines, versioned schema) for every bot: `ts`, `tick`, `bot_id`,
   `run_id`, `action_id`, `parent_action_id`, `component`, `event`, `level`, and typed payloads. Free-text
   logging is allowed only as a field of a typed event.
2. Cover the full causal chain: instruction received → (LLM translation, task 008) → goal → policy decision
   (observation hash, chosen action, alternatives if any) → actuator routine start/phase/end with an
   explicit end reason from a closed list (`done`, `timeout`, `cancelled`, `stuck`, `no_path`, `kicked`, ...)
   → world feedback. Include the state needed to judge it: position, health, inventory delta, pathfinder
   status, loaded-chunk count, server ping/TPS.
3. Record enough to replay: world seed, server config hash, mod list hash, RNG seeds, policy checkpoint id,
   and the raw input sequence. A run can be reproduced or at least compared (RL runs are not bit-reproducible
   by default; see the knowledge-DB note on non-reproducible scores in `repo-notes/decision-process-order-driven/`).
4. Storage and tooling: append-only files with rotation and a size cap (the 2026-03 audit measured ~90 MB/day
   for 3 bots, `docs/archive/IMPROVEMENTS_2026-03-27.md`; *not re-measured*), compacted into columnar files
   for queries. New tooling in Rust (project default; the Node runtime only emits). A query CLI answers fixed
   questions: why did action X end, what was the last state before a stall, which component first logged an
   error, what changed between two runs.
5. Detectors fed by the stream, not by eyes: no-progress watchdog, action-loop detector, error-rate alarm,
   desync (client vs server position).
6. Redaction: never log `OLLAMA_API_KEY`, tokens, or raw chat from other players beyond what debugging needs.

**Acceptance (log-only test).** A fixed set of at least 10 injected faults (stuck in terrain, pathfinder
timeout, kicked, registry desync, LLM timeout, action cancelled mid-way, ...) is each diagnosed correctly by
someone who sees only the logs. Zero faults require attaching a debugger or watching the client.

**Depends on:** 009 for clean component boundaries (log `component` = module). **Existing code touched:**
`debug_trace_logger.js`, `bot_actuator.js`, `agent_manager.js`.

---

## TASK-20261030-007 — Light, rebuildable Forge 1.20.1 server for RL speed

**Goal.** A Forge 1.20.1 server in Docker that rebuilds from scratch with one command and is fast enough that
the server is not the RL bottleneck.

**Description.**
1. Reproducible build: image pinned by digest, Forge version pinned (47.4.10 in the current compose, to be
   re-checked), mod set pinned by hash, world generated from a fixed seed or a flat/test preset
   (`TestWorldGenerator` in `aux_mod` and `docs/implemented/TASK-20260409-003-test-world-auto-generation.md`
   already generate a 9-zone world). `docker compose up --build` from a clean checkout gives an identical
   server; reset-to-snapshot in seconds.
2. Weight reduction: headless; minimal view and simulation distance; only the mods the experiment needs
   (a "vanilla-plus-Forge" profile and a "modded" profile, selectable); no console spam; JVM flags and heap
   sized for the host (the VPS has about 11 GB shared RAM and 6 vCPU, see task 010); no persistent saves for
   training runs (tmpfs world).
3. "RL speed": real Minecraft ticks at 20 TPS, so one environment advances at most 20 steps per second of
   wall time. Options to evaluate, in this order: (a) many parallel lightweight servers/bots, (b) uncapping
   or scaling the server tick loop through the existing Java companion mod (`aux_mod`) or a tick-control
   coremod so ticks run as fast as the CPU allows, (c) action repeat. Whether stock Forge 1.20.1 has a tick
   rate command is *unverified* (vanilla's `/tick` appeared in a later version, believed 1.20.3). The bot
   side must also keep up: Mineflayer physics runs on its own 50 ms clock and would need the same scaling.
   Deliverable is a measured answer, not an assumption.
4. Measure and publish: server TPS and MSPT under N bots, bot steps/s, reset time, RAM/CPU per environment,
   as numbers in the knowledge-DB. Define "keeps up" as a target set by the RL side (task 013), for example
   a stated steps/s per environment.
5. Observation channel: let the server-side mod export state the client protocol makes costly (block
   registry already exported by `BlockRegistryExporter`), so the policy needs not infer it from packets.

**Constraints.** Ports bound to `127.0.0.1` (Docker bypasses `ufw`); no root needed (rootless Docker as
`coder`); memory cap per container.
**Depends on:** `BUGFIX-20261030-002` (Node 22 host marker) only if Node is upgraded.

---

## TASK-20261030-008 — LLM role: instruction → RL goal, nothing else

**Goal.** A hard, testable boundary: the LLM converts a natural-language instruction into a structured goal
that the RL policy consumes, and does nothing else. The conversion is within GPT-OSS 20B's capability.

**Interpretation.** "when used as content" is read as "when used on user-provided content (instructions)".
If it meant something else, this task needs a one-line correction by the owner.

**Description.**
1. Contract: input = one instruction string (plus a small, fixed, static context such as the list of known
   goal types and item names, never live game state). Output = JSON that validates against a versioned
   schema (goal type, target item/block/entity from the game registry, quantity, constraints such as
   dimension or area, priority, success predicate). Unknown or unsatisfiable instructions yield an explicit
   `unsupported` result with a reason, never a guess that executes.
2. Mechanism: constrained decoding or JSON-schema output plus strict validation and one bounded retry;
   target names are checked against the registry (the mod dictionary `mod_blocks_dictionary.json`, 2,361
   blocks at last test) so the model cannot invent identifiers. Temperature low; deterministic seed where
   supported.
3. Isolation: the LLM client lives behind one interface called at instruction time only. It is not reachable
   from the per-tick path, receives no observation, cannot call actions, and its output is data, not code.
   Remove LLM calls from `agent_manager.js` planning and `bot_actuator.js` decisions as part of task 009,
   or gate them behind the interface.
4. Evaluation: a labelled set of instructions (English and Japanese, ambiguous and impossible ones
   included) with gold structured outputs; report exact-match and field-level accuracy, `unsupported`
   precision, and latency. Capability of GPT-OSS 20B on this task is *unverified* and is the first thing
   to measure. Instructions in the held-out set are never used for prompt tuning.
5. Failure behaviour: if the LLM endpoint is down or returns invalid output, the bot keeps executing the
   current goal and reports the problem (no fallback to free-form LLM control).
6. Endpoint: current default `OLLAMA_MODEL=gpt-oss:20b-cloud`, URL via `.env`. Credentials: task 011.
   Where the model runs (owner's PC GPU vs Ollama cloud) matters for the VPS deployment in task 010.

**Acceptance.** Schema-validity rate and accuracy thresholds fixed *before* the first measurement; static
check (dependency graph via scip-neo4j) shows no path from the LLM client to the per-tick decision code.

---

## TASK-20261030-009 — Subdivide the code, one role per part

**Goal.** Make faults local and explainable and fixes reusable, to remove the three historical time sinks:
unexplained behaviour bugs, poorly reusable code, and "fix candidates kept missing".

**Current state (measured 2026-10-30).** `src/bot_actuator.js` is 6,688 lines; `src/agent_manager.js` 1,340;
`src/web_ui_server.js` 646; the split in `src/actuator/` (`ctx`, `environment`, `flight`, `tools`, `utils`) is
the beginning, not the end.

**Description.**
1. Define layers and one-line roles, then enforce them: *transport* (login, FML3 bridge, registry), *world
   model* (state read from the bot/registry, no side effects), *skills* (single-purpose routines: walk, mine,
   craft, fight, each with explicit inputs, outputs and end reasons), *policy interface* (what the RL policy
   sees and calls, task 013), *supervision* (processes, recovery), *ops* (WebUI, logging). A module has one
   reason to change and a stated size budget.
2. Dependency rules written down and checked: no cycles, lower layers do not import upper ones, the LLM
   client is imported only by the instruction front-end (task 008). Check with scip-neo4j
   (`get_symbol_dependencies`) in CI or a script; keep `analyze_change_impact` output with every refactor PR.
3. Extract by characterisation: before moving a routine, capture its behaviour with the structured logs
   (task 006) or a unit test, move it, compare. Small steps, each commit passing `npm test`.
4. Error taxonomy: closed set of failure reasons shared by all skills so every failure is named.
5. Bug-fix protocol (the "fix candidates kept missing" problem): a bug is not fixed until it has (a) a
   reproducer (a log slice or a test) that fails, (b) a recorded hypothesis and the evidence that excludes
   the alternatives, (c) the fix, (d) the same reproducer now passing. Fix attempts that do not change the
   reproducer are recorded as failed methods in the knowledge-DB, which is how the next attempt avoids them.
6. Reuse: pure logic (parsing, planning helpers) has no dependency on Mineflayer, so it is unit-testable and
   reusable outside the bot (including by the RL harness).
7. Language: existing code stays Node.js/Java. New standalone components (log tooling, possibly the
   environment harness) default to Rust.

**Acceptance.** No source file above the agreed size budget; `bot_actuator.js` reduced to composition; the
dependency rules pass; test count grows with each extraction; every skill documents inputs, outputs and end
reasons in `docs/`.

---

## TASK-20261030-010 — Run bot system and server on the VPS, defended with Cloudflare

**Goal.** Bot and Minecraft server run on the VPS; the owner can log in and watch; the attack surface is as
small as Cloudflare allows without hurting availability.

**Description.**
1. Capacity first: the VPS is shared (about 11 GB RAM, 6 vCPU; code-server, Nextcloud, Collabora, MariaDB,
   honeypot, dashboard, collector already run). Set a hard memory/CPU cap for the server and bot containers
   and check headroom before deploying (`free -m` showed ~5.6 GB available at the time of writing). A GPU
   is not available on the VPS, so the 20B LLM stays on the owner's PC or in Ollama cloud (task 008, 011);
   the VPS must reach it through a protected path.
2. No public ports. Containers publish on `127.0.0.1` only; after any container change verify with `ss -ltn`
   (Docker bypasses `ufw`). SSH stays behind `ssh-vps.i-yuki.com`; do not reopen port 22.
3. Web UI (WebUI, debug views) through Cloudflare Tunnel + Cloudflare Access with the same pattern as
   `vps-dashboard`: Access JWT + allowed email + WebAuthn (YubiKey), CSRF on writes. Prerequisite:
   `TASK-20261030-003` (the WebUI currently has no authentication of its own and binds `0.0.0.0`).
4. Minecraft client access is the hard part: the game protocol is raw TCP, which Tunnel's public hostnames
   do not carry for ordinary clients. Candidate designs: (a) Cloudflare WARP private-network route to the
   tunnel so the server has no public address (the owner's PC already runs WARP; best fit), (b) `cloudflared
   access tcp` on the client, (c) Spectrum (believed Enterprise-only; *unverified* for the Workers Paid
   plan). Choose (a) unless a test shows a problem; never publish 25565.
5. Server hardening: `online-mode=true` plus whitelist, RCON off or loopback, minimal mods from a pinned list,
   non-root container, read-only root filesystem where possible, no egress beyond what is needed, world and
   config backups through the existing `vps-backup` (do not add data to git).
6. Availability within the defence: prefer rate limits and challenges over hard blocks on the owner's own
   paths, no geo-block that can lock the owner out, health checks and `Restart=` so a crash recovers, and
   the break-glass path (SSH via the existing hostname) kept working. Test the lock-out case on purpose.
7. Deploy checks per the operating prompt: dependency advisories (`npm audit`, Java dependencies), code
   analysis, `nmap -sC` level scan from outside shows nothing unexpected, unauthenticated `curl` is
   rejected. Record the basis in the knowledge-DB, then deploy.
8. Steps that need root (units, firewall) go through the Credential-broker route (`run` with `sudo`), not
   around the sudo allowlist. Registration of the long-running service: task 014.

**Depends on:** 007, `TASK-20261030-003`, 011 (LLM key), 014.

---

## TASK-20261030-011 — Ollama API key via Credential-broker

**Goal.** The bot's LLM client works again with a key that never touches git, logs or chat.

**Description.**
1. The owner believes the key has expired. This is *unverified*: first confirm with one authenticated call
   to the configured `OLLAMA_URL` and read only the HTTP status (401/403 vs 200); do not print the key or
   the response body.
2. Ask the broker how the key is held. The broker's documented services are github, cloudflare,
   huggingface and vps; whether an Ollama entry exists is *unverified*. If there is none, the owner adds it
   to the vault (Ollama account page, new key), and the broker is the only place it lives.
3. Delivery: broker `run` (which injects credentials into the command's environment and scrubs output) or a
   short-lived token into the process environment; no key in `.env` on the VPS if the broker can supply it.
   `.env` on the owner's PC stays git-ignored. Rotation procedure written down.
4. Code touchpoints (no change in this task unless needed): `src/llm_client.js` (strips BOM and control
   characters), `PUT /api/config` in `src/web_ui_server.js` (can replace the key in-process; must not be
   the persistence route and must not log bodies).
5. Record in the knowledge-DB each escalation and its reason, never the value.

---

## TASK-20261030-012 — LFS token via Credential-broker

**Goal.** Decide whether Git LFS is still needed and, if so, give it a credential that is not stored on disk.

**Description.**
1. Background: `.lfsconfig` points LFS at a Hugging Face repo
   (`I-yuki-0424/Forge1201-AiPlayer-System`). This VPS has no Hugging Face credential, so
   `git-lfs` runs with `smudge --skip`, and old pointer objects were never fetchable
   (`docs/LESSONS.md` L1). The tracked tree now has no LFS files; only `*.tar.gz` and `*.whl` are LFS rules.
2. Request through the broker: service `huggingface`; read permission first, to learn whether the objects
   behind the pointer commits (for example the 10 MB `debug_trace.jsonl.bak`) exist on the remote; write
   permission only if a decision is made to use LFS again. Exact permission names come from the broker's
   error list (*unverified*). Writes need the owner's approval in the broker admin page, as for all writes.
3. Never hardcode, echo or commit the token; pass it to git-lfs per command through the broker `run`
   mechanism rather than writing it into git config.
4. Decide and record: if nothing in the repo needs LFS (training artefacts and logs live in object storage
   or are regenerated), delete `.lfsconfig` and the archive rules, and close this task without a token.

---

## TASK-20261030-013 — RL interface and evaluation protocol (spec)

**Goal.** Specify how an RL policy observes and controls the bot, and how it is evaluated, before any
training code exists. Replaces the earlier `TASK-20261030-005`.

**Description.**
1. Observation: a fixed-size numeric vector or small structured tensor built only from game state the bot
   legitimately has (health, hunger, inventory counts, nearby block types, entities, position, goal vector
   from task 008). No oracle information from the server (no hidden-state leak), consistent with DPOD's
   leakage rules.
2. Action space: a closed set of skills from task 009 (walk-to, mine, craft, attack, place, eat, ...) with
   continuous or discrete parameters, each a multi-tick routine, so the policy acts at the skill level
   (an options layer over `EXECUTE_ACTION` verbs); versus low-level controls (move/look/jump/use) for
   raw-control RL. State the trade-off and pick one with a stated reason. DPOD's discrete Craftax action
   space is not comparable.
3. Reward and termination from the goal's success predicate (task 008) plus shaped terms that are logged
   separately so credit assignment can be debugged (task 006).
4. Environment API: a Gym-like reset/step interface over the fast server (task 007), vectorised, with
   determinism controls and per-step wall time reported.
5. Evaluation protocol: pre-registered success metric, fixed evaluation seeds distinct from training and
   tuning seeds, at least 5 seeds per claim, positive control before any null result is reported (the DPOD
   knowledge-DB note on learners that cannot use even a leaked answer applies), no claim from a single run.
6. Open question for the owner: is the DPOD decision model (Transformer + MDP) the policy here, or a
   different learner? DPOD's current evidence is only on Craftax-Classic and does not carry over.
   Hand the answer to DPOD's own protocol (its `CLAUDE.md` and `docs/core/MASTER_GUIDANCE.xml`).

---

## TASK-20261030-014 — Register long-running work on the schedule

**Goal.** Nothing long-running is stopped silently by an automatic restart; every such job is visible and
survives one.

**Evidence.** The schedule shows a VPS reboot window (`rootwatch-maint`, tentative) on 2026-10-31
03:00–06:00 JST, and `rootwatch` and system updates restart services without asking.

**Description.**
1. Rule (already added to `MASTER_GUIDANCE.xml`): before starting any job expected to run more than a few
   minutes (training, server soak test, crawl, build), `schedule_check` the resource, then `schedule_add`
   a `hold` (renewable by moving `end`) or a `session`, and `schedule_define_job` for anything recurring.
   Record the result with `schedule_record_run`. Update or close the entry when the job ends.
2. Make jobs restart-safe, not just visible: a systemd (user) unit or container `restart:` policy, state
   checkpointed to disk so a restart resumes (the bot already writes `data/queue_checkpoint_<bot>.json`;
   RL training needs its own checkpoints and resumable run ids), and an idempotent start command.
3. Avoid running through maintenance windows: pick start times from `schedule_check` free slots, or accept
   the restart and verify resume.
4. Each task in this roadmap that runs long (007 soak tests, 010 deployment, any training in 013) names its
   schedule entry in `STATE.yaml` when it starts.

**Acceptance.** A deliberately restarted test job resumes from its checkpoint and its schedule entry shows
the run.
