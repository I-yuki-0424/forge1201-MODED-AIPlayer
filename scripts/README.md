# scripts

| Script | Purpose |
| :-- | :-- |
| `beta_debugger.js` | Simulated "TestMaster" scenario suite (see [../docs/guides/AI_DEBUGGING.md](../docs/guides/AI_DEBUGGING.md)) |
| `run_experimental_instruction_suite.js`, `experimental_shards.example.json` | Direct-action E2E suite for the generated experimental world (`npm run test:experimental`) |
| `build_mod_knowledge_index.js`, `run_crawl_wikis.js`, `crawl_wiki_sources.py` | Build the mod knowledge index / crawl wiki sources into `data/wiki/` |
| `extract_debug_logs.js` | Scan `bot_system.log` for error keywords (failure, timeout, crash, ...) |
| `BlockDumper.java` | Forge-side snippet that dumps `BuiltInRegistries` block states to JSON (source of the registry data; the maintained exporter is `aux_mod/.../BlockRegistryExporter.java`) |
| `endgatewayportallocation.py` | End gateway position calculator (standalone) |
| `smoke_run_60s.sh` | Start the bot for 60 s and kill it (writes `bot_run.log`, `bot.pid`, both ignored) |
| `set-remotes.ps1` | Windows-only manual utility for git/LFS remotes |
| `tk_*.sh`, `print_banner.sh` | Terminal Keeper startup wrappers used by `.vscode/sessions.json` (WSL on the owner's PC) |
| [`adhoc/`](adhoc/README.md) | Old one-off probes, not tests |
