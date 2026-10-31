#!/usr/bin/env bash
# Stop the LLM-driven bot (the build world keeps running).
source "$(dirname "$0")/lib.sh"
compose --profile bot stop llm-bot
