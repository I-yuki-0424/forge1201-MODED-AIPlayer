# Beta AI Debugging Guide

This repository contains robust tools specifically designed for AI agents to easily debug, test, and release the Minecraft bot systems in beta. Follow these instructions when you encounter bugs, failures, or when asked to verify the robust functionality of the bot.

## 1. Running the Beta Debugging Test System

The test system sets up a simulated "TestMaster" player to test AI bots across a variety of scenarios including movement, combat, evasion, utility, gathering, PvP, and death recovery.

To run the integration suite:
```bash
node scripts/beta_debugger.js
```

### What this does:
1. Spawns `TestMaster` to flatten the terrain, build mountains, rivers, caves, place modded blocks/chests, and spawn mobs.
2. Starts `DebugBot_1` via `AgentManager` in normal mode.
3. Tests navigation and MLG water buckets (drops the bot off a mountain).
4. Tests 1000-block Elytra flight.
5. Tests crafting (vanilla & mod) and vein miner gathering.
6. Tests storage (shulker boxes, furnaces, chests).
7. Tests endurance, evasion against Skeletons and Blazes.
8. Tests PvP by spawning a second AI bot (`DebugBot_2`).
9. Kills the bot in the Nether to test cross-dimensional Gravestone recovery.

## 2. Using the Log Extraction Tool

To quickly find the root cause of crashes or failures without reading thousands of lines in `bot_system.log`, run the log extraction tool:

```bash
node scripts/extract_debug_logs.js
```

### What this does:
- Parses `bot_system.log` and searches for keywords (`error`, `exception`, `timeout`, `crash`, etc.).
- Prints out the exact context lines (3 lines before, the error, and 3 lines after).
- Parses `ai_debug_*.json` files to check current health, food, action queues, and alerts if the bot is dead, starving, or in recovery loops.

## 3. Best Practices for Debugging

1. **Reproduce First:** Always run `node scripts/beta_debugger.js` to see if you can reliably reproduce the error reported.
2. **Extract Logs:** Immediately run `node scripts/extract_debug_logs.js` to get the error stack trace.
3. **Trace the Action:** Identify which `actionQueue` step was running when the error occurred. Check the code logic for that action in `src/bot_actuator.js`.
4. **Fix Root Causes:** Do not use uniform simplifications to bypass problems (e.g., hardcoded teleports). Identify the root logic failure and fix it.
