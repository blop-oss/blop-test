#!/usr/bin/env bash
# Latency measuring stick for the khadim browser agent.
# Usage: bench/run.sh <label> [spec]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LABEL="${1:-run}"
SPEC="${2:-bench/single.blop.ts}"

# Load agent creds from the repo .env (openrouter + configured chat model).
set -a
# shellcheck disable=SC1090
source <(grep -E '^(OPENROUTER_API_KEY|CHAT_AGENT_PROVIDER|CHAT_AGENT_MODEL)=' "$ROOT/.env")
set +a

export BLOP_AGENT_PROVIDER="${CHAT_AGENT_PROVIDER:-openrouter}"
export BLOP_AGENT_MODEL="${CHAT_AGENT_MODEL:-nvidia/nemotron-nano-9b-v2:free}"
export BLOP_AGENT_API_KEY="${OPENROUTER_API_KEY}"

PROG="bench/progress-$LABEL.ndjson"
REPORT="bench/report-$LABEL"
rm -f "$PROG"

START=$(date +%s.%N)
bun run blop test "$SPEC" \
  --capture-screenshots \
  --progress-file "$PROG" \
  --report-dir "$REPORT" \
  --max-steps 40 \
  >"bench/stdout-$LABEL.log" 2>&1
CODE=$?
END=$(date +%s.%N)

WALL=$(echo "$END - $START" | bc)
ACTIONS=$(grep -c '"type":"action"' "$PROG" 2>/dev/null || echo 0)
echo "----- $LABEL -----"
echo "exit_code=$CODE"
printf "wall_seconds=%.2f\n" "$WALL"
echo "actions=$ACTIONS"
tail -3 "bench/stdout-$LABEL.log"
