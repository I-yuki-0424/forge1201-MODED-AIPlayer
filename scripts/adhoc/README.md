# scripts/adhoc

One-off probes written while reverse-engineering the FML3 handshake and Mineflayer behaviour. They used to
sit in the repo root. **None is part of `npm test`** (the maintained tests are in `../../tests/`), none is
maintained, and most need a live Forge server (`MC_HOST`, `MC_PORT`) or are superseded by a test there. Run
them from the repository root (`node scripts/adhoc/<file>`). Delete one when its idea is covered by a real test.

| Group | Files | Question it answered |
| :-- | :-- | :-- |
| FML3 handshake | `test_fml*.js`, `test_spoof*.js`, `test_false.js`, `test_echo_packets.js`, `test_packets.js` | Which login-plugin replies make a Forge server accept the bot (covered now by `tests/test_fml3_handshake_logic*.js`) |
| Payload decoding | `parse_payload.js`, `parse_payload2.js`, `inspect_protocol.js` | Byte layout of the `fml:handshake` payload, protocol schema of 1.20.1 |
| Mineflayer API probes | `check_item.js`, `test_bot_container.js`, `test_bot_withdraw.js`, `test_find_chests.js`, `test_inventory.js`, `test_items_method.js`, `test_mineflayer_api.js`, `test_pathfinder.js`, `test_registry_mutation.js`, `test_serializer.js`, `test_timing.js` | Does a method/field exist, what does it return |
| Algorithm sketches | `test_vein.js`, `resolver_test.js` | Vein-mining BFS before it went into the actuator; material resolver output |
| Live integration | `test_live.js` | Drives a running bot via IPC and measures movement (writes `test_live_results.json` and reads `ai_debug_<bot>.json` in the cwd; both are git-ignored) |
| Placeholder | `test_simulation_bot.js` | Only prints "passed" five times; tests nothing. Candidate for deletion |
