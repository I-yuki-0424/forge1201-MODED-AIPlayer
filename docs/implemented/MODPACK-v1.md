# Mod set v1: vanilla + Create + optimisation, and the exact mod block/item table the bot needs

`TASK-20261031-020` (2026-10-31). The owner replaced the old 39-mod pack with a minimal set for development: vanilla,
Create as the only content mod, prerequisites and common optimisation only, so the bot's world (and later the RL action
and observation space) does not grow with mods. The set is pinned by sha512 in one lock file; the server, the client and
the bot's block table are all derived from it.

## The set (`modpack/forgeaip-create.lock.json`)

| Jar | Side | Why |
| :-- | :-- | :-- |
| `create-1.20.1-6.0.8.jar` | server + client | the content mod. Its prerequisites are inside the jar (jar-in-jar): Flywheel 1.0.5, Ponder 1.0.91, Registrate 1.3.3, MixinExtras 0.4.1, so no separate dependency jars |
| `modernfix-forge-5.27.91+mc1.20.1.jar` | server + client | faster start, less memory |
| `ferritecore-6.0.1-forge.jar` | server + client | less memory for block states and models |
| `embeddium-0.3.31+mc1.20.1.jar` | client | renderer (Sodium port); Flywheel 1.0 supports it |
| `entityculling-forge-1.11.3-mc1.20.1.jar` | client | skips rendering hidden entities and block entities |

Forge 1.20.1-47.4.10 (unchanged; Create needs 47.1.3 or newer). Considered and left out: Canary (Lithium port, last release
2024-02, changes block-entity ticking that Create contraptions rely on), ImmediatelyFast (the Forge build is labelled for
1.20.4), JEI (optional for Create, not a prerequisite). Change the set only in the lock, then run
`scripts/world/registry-dump.sh` and commit the new table with it (below).

## Server

`scripts/world/up.sh` and `restart.sh` make `/mnt/data/forgeaip/mods` hold exactly the lock's server jars
(`modpack/pack.py server`, sha512-checked, other jars removed) and the server mirrors that folder on start.

## Client (the owner's PC)

Either of:

- **Modrinth App or Prism Launcher:** import `forgeaip-create.mrpack` (Forge and the five jars are installed from the
  pack). Get it from the VPS (PowerShell): `scp vps:/mnt/data/forgeaip/forgeaip-create.mrpack $HOME\Downloads\`.
  `up.sh` rebuilds it from the lock on every start.
- **Official launcher / existing Forge profile:** install Forge 1.20.1-47.4.10 (installer link printed by the script),
  then in a checkout of this repo (PowerShell, no elevation):
  `.\modpack\install-client.ps1` (default `%APPDATA%\.minecraft\mods`; `-ModsDir <folder>` for another instance).
  Jars that are not in the set (for example the old 39-mod pack) are moved to `mods-before-forgeaip-<time>` next to the
  folder, never deleted. Tested with PowerShell 7.4 (two runs: fetch, then all kept); Windows PowerShell 5.1 not tested.

## The bot's block and item table

Measured on a copy of the Create world (2026-10-31) before this change:

| Bot registry | Vanilla blocks | Create blocks | Items |
| :-- | :-- | :-- | :-- |
| none (vanilla minecraft-data) | right | no name, no collision (`boundingBox` empty) | Create items `unknown` |
| old heuristic injector (`src/dynamic_registry_injector.js`) | right | every one named `decorated_pot`, full cube | dirt -> `forge:modid4`, cogwheel -> `metal_girder` |
| **exact table (this task)** | right | real names, properties and collision boxes | right |

Also: with Create the server has 55,524 block states (vanilla 24,135), so chunk sections with a direct palette use
16 bits; prismarine-chunk takes the width from the registry, so without the table those sections decode wrongly.

How it works (`src/transport/mod_registry.js`):

1. The FML3 handshake (disc 3, one `S2CRegistry` per registry) is decoded field by field: name -> id of every block
   and item (Forge `HandshakeMessages.S2CRegistry` + `ForgeRegistry.Snapshot.getPacketData`). Item ids come only from
   here, so items are exact even without a table.
2. Forge assigns block-state ids by walking the block registry in id order (`GameData.BlockCallbacks.onBake`). With
   each mod block's state count from the table, every state id follows; vanilla blocks are checked against
   minecraft-data on the way (any disagreement: nothing is installed, the reason is logged).
3. The table `modpack/forgeaip-create.registry.json` (committed, one line per block) is written by
   `tools/registry-dump`, an 8 KB server-only Forge mod, started once by `scripts/world/registry-dump.sh` on a tmpfs
   copy of a snapshot next to the lock's server jars. Per block it has the registry id, state count and range,
   properties in wire order (checked against prismarine's decoding), collision boxes per state (deduplicated into
   `shapes`), hardness, tool tag and tier, its item; per mod item the stack size. It is never installed in the build world
   or a client. Current table: 1,646 blocks (643 Create), 55,524 states, 699 Create items, 491 shapes, 0 problems.
4. `attachForgeHandshake(bot, {registry})` in `src/transport/forge_bot.js`: `auto` (default everywhere) installs the
   table when the handshake shows content mods and does nothing on a vanilla Forge server; `vanilla` never touches the
   registry; `legacy` is the old heuristic (only the old actuator uses it). Environment: `BOT_REGISTRY`,
   `BOT_MOD_TABLE` (other table file). The bot logs one line: `mod registry: 643 blocks, 31389 states, 699 items`.
   A mod block missing from the table (lock changed, table not rebuilt) stops the block install (state ids after it would
   be guesses) and says to rerun `registry-dump.sh`; items are still installed.
5. The install copies the registry maps it changes first: prismarine-registry hands every bot in a process the same
   cached minecraft-data objects (found by the unit test: one install leaked into the next registry).

The server-list ping is no longer used to detect mods: Forge 1.20.1 puts the mod list into the compressed `d` field and
leaves `mods` empty, so the old check counted 0 content mods on the Create server (docs/LESSONS.md L7).

## Verification (2026-10-31)

- `tests/test_mod_registry_pure.js` (in `npm test`, now 11 files): wire decoding, exact state ids and property decoding
  through prismarine-block, shapes, harvest tools, items, the no-table and vanilla-mismatch refusals.
- Live probe on a copy of the Create world: dirt, planks, water, ladder unchanged; andesite casing, shaft, cogwheel,
  mechanical press, andesite alloy block named exactly; items dirt, wrench, andesite alloy, cogwheel exact; the bot
  stands on andesite casing at y = top (on ground) and on a horizontal shaft at y + 11/16 (the shaft's collision top).
- `intent-check` (real AgentManager, mock LLM) on a fresh copy of the Create world: 13/13.
- Real LLM: one call through the vault record `ollama/forgeaip` (`https://ollama.com/api/generate`, `gpt-oss:20b`)
  answered in 1.1 s; the running bot logged `[Vault] LLM credentials now from the vault`.

## Files

`modpack/forgeaip-create.lock.json`, `modpack/pack.py`, `modpack/install-client.ps1`,
`modpack/forgeaip-create.registry.json`, `tools/registry-dump/` (Java 17, ForgeGradle 6; build output ignored),
`scripts/world/registry-dump.sh`, service `registry-dump` (profile dump) in `docker/world-server/compose.yaml`,
`src/transport/mod_registry.js`, `tests/test_mod_registry_pure.js`.
