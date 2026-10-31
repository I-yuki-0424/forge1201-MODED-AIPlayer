#!/usr/bin/env bash
# Start the LLM-driven bot in the build world (needs the build world; LLM credentials from the vault record ollama/forgeaip).
source "$(dirname "$0")/lib.sh"
running "$WORLD" || "$(dirname "$0")/up.sh"
compose --profile bot up -d llm-bot
# The world defaults to creative (for building); the bot's commands follow survival rules (dig times, drops).
names=$(grep -E '^LLM_BOT_NAMES=' "$COMPOSE_DIR/.env" 2>/dev/null | cut -d= -f2 || true); names=${names:-AI_Bot_01}
for _ in $(seq 1 30); do rcon list | grep -q "${names%%,*}" && break; sleep 2; done
for n in ${names//,/ }; do rcon "gamemode survival $n" >/dev/null; done
docker logs --tail 15 forgeaip-llm-bot 2>&1 | grep -E 'Vault|SkillsBot|Endpoint|Error' || true
