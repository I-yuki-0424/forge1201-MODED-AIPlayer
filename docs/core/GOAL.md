# GOAL

## Purpose

An autonomous player for **modded Minecraft 1.20.1 (Forge 47.x)**: Mineflayer drives the body, an LLM
(Ollama-compatible endpoint) chooses actions, and this repository supplies what stock Mineflayer lacks on
Forge: the FML3 login handshake, the remapped block registry, mod-aware inventory/pathing, and a
supervising parent process. Design detail: [ARCHITECTURE.md](../ARCHITECTURE.md).

## Research role (Decision-Process-order-driven)

This repository is where the owner's research theme **Decision-Process-order-driven (DPOD)** started
(DPOD is only a repository name, not a pseudonym). The intent is to put DPOD's decision model, a
Transformer + MDP policy, in charge of this agent's decisions, replacing or constraining the LLM planner.

State of that link on 2026-10-30:

- DPOD's own experiments run on **Craftax-Classic**, a Minecraft-like JAX simulator, not on Minecraft
  itself (`Decision-Process-order-driven/CLAUDE.md`). Its docs contain no reference to this repo or to
  Mineflayer. No code connects the two yet.
- This repo is therefore the **real-game side**: a place where a learned policy can eventually be
  evaluated on actual Forge gameplay. It currently contains no RL training code.
- DPOD's rules (leakage and oracle checks, pre-registered experiments, data-integrity lint) apply to any
  RL work that is done here. Read that repo's `CLAUDE.md` and `docs/core/MASTER_GUIDANCE.xml` first, and
  do not copy results across as if the two environments were equivalent.

Open design question for the link: DPOD's action space is discrete Craftax actions. Here, actions are the
`EXECUTE_ACTION` verbs (`goto`, `collect`, `craft`, `kill`, ...) executed by
[`bot_actuator.js`](../../src/bot_actuator.js), each of which is a multi-tick routine. Mapping between the two
(a thin options layer over those verbs) is not designed yet. See the queued task in [STATE.yaml](STATE.yaml).

## Success criteria

1. The bot logs in to a Forge 1.20.1 modded server, survives chunk/registry sync, and walks/mines without
   pathfinder crashes (covered by `npm test`, 7 files).
2. Actions complete or fail with a recorded reason; a stuck bot is detectable from `ai_debug_<bot>.json`
   and the debug trace without a human watching.
3. Anything learned or decided is recorded in the knowledge-DB so it is not re-derived.
