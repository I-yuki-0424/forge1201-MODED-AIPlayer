# GOAL

## Purpose

An autonomous player for **modded Minecraft 1.20.1 (Forge 47.x)**: Mineflayer drives the body, an LLM
(Ollama-compatible endpoint) chooses actions, and this repository supplies what stock Mineflayer lacks on
Forge: the FML3 login handshake, the remapped block registry, mod-aware inventory/pathing, and a
supervising parent process. Design detail: [ARCHITECTURE.md](../ARCHITECTURE.md).

## Research role and direction (decided 2026-10-30)

This repository is where the owner's research theme **Decision-Process-order-driven (DPOD)** started (DPOD is
only a repository name, not a pseudonym). DPOD itself is pure RL research and stays that way. Here the owner
applies the same stance to a real game agent: **control belongs to an RL policy, not to an LLM**, which is
the opposite of the current trend of handing everything to an LLM.

Target split (details and tasks: [ROADMAP-20261030-rl-platform.md](../proposed/ROADMAP-20261030-rl-platform.md)):

- **RL policy** picks every in-game action from game state, at game speed.
- **LLM** (GPT-OSS 20B class) runs once per instruction, outside the control loop, only to convert a
  natural-language instruction into a schema-validated goal for the policy. No game state in, no actions out.
- Today's code is the reverse (an LLM plans the actions, `agent_manager.js` / `llm_client.js`); moving it to
  the target split is tasks 008, 009 and 013 in [STATE.yaml](STATE.yaml). Nothing has been implemented yet.

State of the link to DPOD on 2026-10-30:

- DPOD's experiments run on **Craftax-Classic**, a Minecraft-like JAX simulator, not on Minecraft itself
  (`Decision-Process-order-driven/CLAUDE.md`). Its docs contain no reference to this repo or to Mineflayer.
  No code connects the two.
- Whether DPOD's decision model (Transformer + MDP) is the policy here, or another learner is, is an open
  owner decision (task 013). Results on Craftax do not carry over; this repo is the real-game evaluation side.
- DPOD's rules (leakage and oracle checks, pre-registered experiments, positive control before a null result)
  apply to any RL work done here. Read that repo's `CLAUDE.md` and `docs/core/MASTER_GUIDANCE.xml` first.

## Success criteria

1. The bot logs in to a Forge 1.20.1 modded server, survives chunk/registry sync, and walks/mines without
   pathfinder crashes (covered by `npm test`, 7 files).
2. Actions complete or fail with a recorded reason; a stuck bot is detectable from `ai_debug_<bot>.json`
   and the debug trace without a human watching.
3. Anything learned or decided is recorded in the knowledge-DB so it is not re-derived.
4. (Direction) The LLM is confined to instruction-to-goal translation; behaviour is diagnosable from logs
   alone (tasks 006, 008).
