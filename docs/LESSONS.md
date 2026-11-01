# Lessons

Incidents in this repository and the rule each produced. Newest last. Full write-ups of costly ones are in
the knowledge-DB (tag `forge1201-moded-aiplayer`).

## L1 — Git LFS on `*.json` / `*.txt` / `*.log` destroyed the checkout (2026-08-18, found 2026-10-30)

- **What happened:** commit `edd510e1` ("track large files in LFS") added `filter=lfs` for `*.json`, `*.txt`,
  `*.log`, `*.jsonl`, `node_modules/**`, `jdk-*/**`, `build/**`. Every matching file, including
  `package.json`, `tests/test_manifest.json`, the 286 KB mod dictionary and ~14,000 `aux_mod/build` files,
  became a 130-byte pointer. The objects were never available (no Hugging Face credential on the VPS,
  `.lfsconfig` points there), so `npm install`/`npm test` could not run and `node_modules` held broken
  `package.json` files (`ERR_INVALID_PACKAGE_CONFIG`).
- **Fix (2026-10-30):** restored the real files from `9d3cf2c1` (sha256 matched against each pointer's oid),
  deleted unrecoverable runtime artifacts, regenerated `package-lock.json` (it had only ever existed as a
  pointer), untracked everything generated (28.5k files), rebuilt `node_modules` with `npm ci`.
- **Rules:** LFS only for archives (`*.tar.gz`, `*.whl`). Never LFS-track text that tooling must read.
  Never commit dependencies, toolchains or build output. After any `.gitattributes` change run
  `git ls-files -z | xargs -0 grep -l '^version https://git-lfs'` and expect nothing outside archives.
- **History is unchanged:** the pointer commits remain in history on purpose (no force-push). Restore old
  content with `git show 9d3cf2c1:<path>`.

## L2 — Node 22.23.4 rejects the `\0FML3\0` host marker (found 2026-10-30)

- `options.host` containing NUL bytes throws `ERR_INVALID_ARG_VALUE` in `net`; the bot's FML3 trigger
  (`host + '\0FML3\0'`) therefore fails in `test_e2e_integration`. Node 20.20.2 and 22.11.0 pass.
  Tracked as `BUGFIX-20261030-002` in `core/STATE.yaml`. Until fixed use `.nvmrc` (Node 20).

## L3 — Unauthenticated control surface (found 2026-10-30)

- The WebUI (`:3000`) can send chat and actions to bots and change LLM endpoint/key in-process; the debug
  WebSocket (`:3001`) streams positions. Neither authenticates and both listen on `0.0.0.0`. Docker
  publishes ports via its own iptables chains, which bypass `ufw` on a server.
- **Rule:** published ports in `docker/forge-server/compose.yaml` are bound to `127.0.0.1`. To play from
  another machine on the LAN, change that deliberately; do not expose these ports to the internet.
  Fix in code: `TASK-20261030-003-webui-auth-and-bind`.

## L4 — Registry injection corrupts items on a server without content mods (found 2026-10-30)

- On a Forge 1.20.1 server with an empty mod list, `DynamicRegistryInjector` still logged "Mapped 0 vanilla blocks.
  Injected 28 MOD blocks" and the client named the dirt item `forge:modid4`: a `give` of 3 dirt was invisible to
  anything reading item names. Block categories looked right, so it only showed up in the inventory.
- **Rule:** inject only for a modded server (`attachForgeHandshake(bot, { inject: true })`, RL profile
  `RL_PROFILE=modded`). The vanilla-plus-Forge profile uses Prismarine's own registry. The injector itself is
  unchanged; making it a no-op on an empty mod list is a separate fix (`BUGFIX-20261030-015`).
- Related: `rcon-cli` appends an ANSI reset (`ESC[0m`) to every reply; strip it before parsing numbers.

## L5 — Key fragments in logs (found 2026-10-31)

- `src/llm_client.js` logged `apiKey.substring(0, 8)` on every request and put the same prefix into the 401 error text,
  which reaches the console, the WebUI chat log and Sentry. Fixed: only the key length is shown.
- **Rule:** never log any part of a secret (prefix, suffix, hash prefix): a fragment narrows a brute force and identifies
  the key. Log "set / not set" and the length at most.

## L6 — Rootless Docker owns files as container root (found 2026-10-31)

- In coder's rootless Docker, container root is host `coder`, but container uid 1000 (the itzg and node images' user)
  is a subordinate uid: it cannot read coder's mode-600 files and its files are not coder's.
- **Rule:** to read a coder-owned secret or write into a coder-owned bind mount, run that step as container root
  (`docker exec -u 0`, no `--user`); keep server data in named volumes and reach it through containers.

## L7 — Forge 1.20.1 hides the mod list in the server-list ping (found 2026-10-31)

- The ping's `forgeData.mods` is empty on Forge 1.20.1; the list is packed into the compressed `forgeData.d` string. The
  bot's "content mods" check read `mods` and reported 0 on the Create server, so it never set up mod blocks.
- **Rule:** take mods and registries from the FML3 handshake (exact, decoded field by field in
  `src/transport/mod_registry.js`), not from the ping.

## L8 — prismarine-registry shares minecraft-data between bots (found 2026-10-31)

- `require('prismarine-registry')('1.20.1')` returns the same cached `blocks`, `blocksByStateId`, `items` ... objects
  every time. Writing mod entries into them changes every other bot (and every later registry) in the process.
- **Rule:** copy a map before changing it (`own()` in `src/transport/mod_registry.js`).

## L9 — Parallel RCON connections get each other's replies (found 2026-11-01)

- The vanilla server answers every RCON command from one shared output buffer, so commands sent on parallel connections can
  receive another connection's output. In the first 10-bot LV2 run, one bot's failed `spreadplayers` text came back as the
  reply to other bots' `setblock`, `effect` and `execute if` commands: 70 of 140 trials became harness errors.
- **Rule:** one RCON connection per server, one command at a time (the `sharedRcon()` queue in `scripts/skills/bench_lv2.js`).

## L10 — Many bots on new terrain stall the server (found 2026-11-01)

- Ten bots entering ten never-generated sites made the 3-CPU Forge server generate about 2,900 chunks at once: it fell
  224 ticks (11 s) behind and dropped every bot.
- **Rule:** generate the test region first, with one scout and one view at a time, waiting for the tick time to recover
  (`bench_lv2.js --pregen 1`, 36 views in 4-6 min). Bots then only load stored chunks. Do not park bots in spectator mode
  while they wait: players in the world see them hanging there.


## L11 — The advancements packet never reaches the bot parsed (found 2026-11-01)

- `src/transport/forge_bot.js` turns `advancements` (with `declare_recipes`, `tags`, ...) into a raw `restBuffer` since
  2026-03 (it desynced on a modded server then). Anything listening for advancements gets a Buffer, not fields; RL v2's
  first smoke run graded no advancement at all while RCON confirmed the grant.
- **Rule:** read such packets from the raw bytes with the unmodified schema, guarded, where they are needed
  (`parseAdvancements` in `src/rl/progress.js`, fixtures in `tests/fixtures/`), instead of removing the bypass for every bot.

## L12 — spreadplayers "succeeds" into shallow water (found 2026-11-01)

- On natural terrain `spreadplayers` refuses ocean sites ("Could not spread ...") but can still place a player in 1-deep
  water. The action layer cannot swim, so every command from there ends `unreachable`. With RCON feedback off, the refusal
  was also silently ignored and the bot stayed where it was.
- **Rule:** check the reply (`^Spread`) and that the bot stands dry and `standable` after the teleport; draw another site
  otherwise (`reset` in `src/rl/run_skill_env.js`).

## L13 — The walker never counted progress (found 2026-11-01)

- `motion.walk` started every plan with `best = Infinity` and recorded progress only when `progress > best + 0.02`, which never
  held: every walk replanned every 30 ticks ("no progress") and ended `stuck` after the 6th replan, i.e. any walk longer than
  about 9 s failed whatever the terrain. The benchmarks never walked that long (targets within 12 blocks); the RL chases did.
- **Rule:** a "best so far" that must be beaten starts at `-Infinity`. Reproducer: the 60-block walk in
  `tests/test_skills_motion_sim.js` (fails on the old code with 5 replans).

## L14 — mineflayer's findBlock reads every cell of a 1.18+ world (found 2026-11-01)

- `bot.findBlocks` skips a chunk section when `section.palette` has no match, but prismarine-chunk's 1.18 sections keep the
  palette in `section.data` (`.value` for single-value sections, `.palette` for indirect ones), so no section is skipped and
  every cell becomes a full `Block` (biome, block entity). Three such searches per RL step were 30 % of the environment's
  CPU; `bot.blockAt` per cell another 30 % (CPU profile through the inspector, 20 s, run 2).
- **Rule:** search with `findStates` (`src/skills/world.js`: palette-aware, state ids only) and read cells through
  `fromBot(bot).kindAt/shapesAt/nameAt` (one `Block` per distinct state, cached). Never `findBlock` with a function matcher
  in a per-step path.

## L15 — spreadplayers lands on tree tops (found 2026-11-01)

- Leaves count as safe ground for `spreadplayers`. A bot reset onto a tree cleared the leaves and logs around itself and
  ended on a one-block trunk 6+ blocks up: no move, every `mine` of a leaf or log `not_confirmed` (the drop is random or falls
  out of reach), and `wait` always succeeding kept the stuck cut from firing (run train3, Train6).
- **Rule:** after a reset the block under the feet must not be leaves, a log or wood; `mine` succeeds on the confirmed break
  (drop pickup is best effort); the stuck cut counts only successful commands other than `wait`.

## L16 — A faster clock shortens every reply wait counted in ticks (found 2026-11-01)

- With the server and the bots at 2x (tools/tickrate + GAME_SPEED), waits for the server's reply that were budgeted in
  ticks halved in wall time while the round trip did not: `craft`'s 20-tick confirmation missed (bench full-x2 #75), and
  mineflayer's multi-batch craft lost a batch now and then.
- **Rule:** `ctx.until`/`during` budgets scale with the clock (`time_scale.scale`), the dig-confirm window too; craft one batch
  per call. The server must keep up with the factor it is given: bots x speed share its one tick thread (training world,
  8 bots: 29-33 ms per tick at 1x).
