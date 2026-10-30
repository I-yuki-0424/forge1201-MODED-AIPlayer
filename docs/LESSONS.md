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
