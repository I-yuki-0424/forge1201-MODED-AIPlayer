# RL-MOVE-v3: one learned movement policy for the pure bots, trained on the PC's GPU (2026-11-11)

**Built the same day: see [MOVE-v3](../implemented/MOVE-v3.md) (what was built and measured) and [PIT-EXPERT-v1](../implemented/PIT-EXPERT-v1.md).** This file stays as the design and its reasons; where the build differs (19 actions, a 2,964-number observation, a mask from the rules, JAX scenario worlds of 40 x 32 x 40, a walk that refuses far targets and falls back to the old chain) MOVE-v3 says so.

One policy that walks, bridges, climbs, descends and digs a bot to a target cell, replacing the chain waypoint router -> path calculator -> escape heuristics -> expert fallback.

## Why (owner, 2026-11-11, and the logs behind it)

- Bots wander at short range without working (Work1, Work7: death loop at the End entrance platform), fall through drift, overshoot and broken scaffolding, mine where nothing needs mining (the platform's obsidian).
- Measured on the live pit (docs/implemented/WORK-CONSOLE-v1.md v21): the waypoint router's success went 16 % -> 43 % -> 73 % while the failures were *missing actions* (go down, bridge, place), not bad waypoints. The old legs fallback succeeded 0 of 14. So the unit to learn is the whole route at cell level with the full action set, not waypoints for a path calculator that has no `descend`, `bridge` or `pillar`.
- Owner decision: path calculation moves into RL; the system's movement becomes native to the policy; RL is rebuilt; the PC's resources may be used, on the GPU.

## What it replaces and what stays

| Stays | Replaced by the policy |
| :-- | :-- |
| Body, `skills/commands/*` (the actuators), the reflexes (fall, lava), the ledger and the posts, the temp-block registry (own blocks only) | `env.travel` (router + legs + expert), `goToStation` walking/bridging/rise/descend choices, `climbTo`, `leavePit` choices, the escape ladder's movement fixes |

The policy chooses; the existing commands execute (`move_to` one step, `place` blind, `mine` blind, `pillar`/`descend`/`bridge` as primitives). No new way of touching the world.

## Interface

- **Action** (discrete, one per decision, about 1 per 0.3-1 s): 4 walk steps (N E S W: walk, step up 1, drop up to 3), 4 diagonal-safe variants are *not* needed; `place_front_down` (bridge cell), `place_under` + `pillar_up`, `descend_1`, `dig_front`, `dig_up`, `dig_down` (only own blocks or inside the pit), `wait`, `sidestep_away` (spacing). 14 actions.
- **Observation**: ego-centred voxel patch 9 x 7 x 9 (solid / air / fluid / danger / own-temp / other-bot's-temp / other bot: 7 channels), target vector (dx, dy, dz clipped and scaled), blocks in the pack (temp-block count, pickaxe yes/no), own temp blocks standing within reach, nearest bots (dx, dz), time since the last progress. No oracle: only what the bot's chunk model gives.
- **Reward**: +1 on arrival (cell within `near`, level within `nearY`), -1 on death (fall damage model), -0.01 per decision, -0.05 per block left standing at the end, -0.2 per block placed on another bot's scaffold or within 1 block of another bot, +0.02 per block of progress toward the target on the way (shaping, removed in the second phase).
- **Export**: a small MLP (two layers of 256) as JSON, evaluated in plain JS (`src/experts/route/policy.js` already does this for 474 parameters; same loader, new shapes).

## Simulator (JAX, on the GPU)

A voxel world of 64 x 64 x 64 cells per env, thousands of envs in parallel (`vmap`), one `lax.scan` per rollout. Physics at cell level (not the engine's): standable = solid below, free feet and head; walk / step up 1 / drop up to 3 free; falls of 4 or more cost health by the vanilla formula (death at 20); place needs a face to place against (blind placement is allowed as in `descend`: any face of a solid block in reach); dig removes a solid cell the bot can reach and returns the block to the pack. Other bots are moving obstacles driven by the baseline policy.

Scenario generator (from the live logs, the failure geometry):

1. leftover column over a dug pit (the bot on top, the work 3-40 levels below);
2. a ledge across a gap of void, 3-14 blocks, and a target on the far side;
3. the End entrance: a platform, a void, an island, stations 20-60 blocks across and 0-20 levels above or below;
4. an open pit with walls (no road), the bot at the rim, the work at the front layer;
5. a crowd: 10-20 bots in one chunk with temp blocks standing;
6. noise: the stopping offset of the body (up to 0.25 off the cell centre), a missed placement (5 %), a dig that takes 2-3 times as long.

## Training

PPO, GAE, 2 phases (shaped, then unshaped), 4,096 envs x 128 steps per update, MLP 256 x 256 with a recurrent-free design (the patch and the progress timer carry the state), 20-50 M decisions. **On the GPU**, in WSL2 on the PC.

Facts found on the PC (2026-11-11), because the previous runs were pinned to the CPU (`JAX_PLATFORMS=cpu` in `scripts/moe/pc.sh run`):

- RTX 3060 Ti, 8 GB; the owner's desktop already holds 3.7-4.7 GB and 40 % of the GPU while they play (Minecraft client, browsers, Discord). JAX's default preallocation of 75 % of the card (6 GB) fails with `CUDA_ERROR_OUT_OF_MEMORY` beside that. **Set `XLA_PYTHON_CLIENT_PREALLOCATE=false`** (and `XLA_PYTHON_CLIENT_MEM_FRACTION=0.35` as a cap): a 4096 x 4096 matmul then runs at about 7 TFLOPS on the shared card. (That the OOM was why the earlier jobs went to the CPU is my reading, not verified.)
- Keep the footprint under 3 GB and the duty cycle polite while the owner plays (quiet hours of the old supervisor: 12-18 JST paused; the owner plays at night, so the training uses `nice`, a small batch and a `pause` file the owner can touch).
- The WSL disk was 164 GB on C: (147 GB of old exchange logs in `~/x`): compressed in place (gzip, verified, 8.3 GB left), then `fstrim` + `wsl --shutdown` + `Optimize-VHD -Mode Full`: 26 GB, C: free 66.8 -> 307 GB. Do this again when `~/x` grows (the script is `scripts/pc/compress-x.sh`).

## Milestones (each ends with numbers, in this order)

1. **Simulator + baseline.** JAX env with the six scenarios; a scripted baseline (BFS over the same action set) as the reference. Gate: the baseline solves scenario 1-4 above 90 % and its failures are the live ones (replay of 20 recorded live cases from `problems.jsonl`: position, target, neighbourhood).
2. **PPO on the GPU.** Gate: the policy beats the baseline on held-out maps (death rate and blocks left standing included), 95 % Wilson intervals, 3 seeds.
3. **Runtime.** JS evaluation of the exported MLP; a shadow mode on the live console (the policy proposes, the old chain acts, disagreements are logged), then a switch per scenario (`setting router: 'rl3'`), the old chain as fallback.
4. **Live A/B** on the pit: the same job with the old chain and with the policy on half of the bots each; measured: units per minute, deaths per hour, forced pushes per hour, temp blocks standing.

## Not decided

- Whether the target is always a cell (stations, chests) or sometimes a region (the pit's work area); the first version takes a cell and a `near` radius, as the router does.
- Whether other bots should be simulated with the policy itself (self-play) from the second phase on.
- Mining decisions stay with the pit job (what to dig is the ledger's business); the policy only digs to get through.
