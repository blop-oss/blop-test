#!/usr/bin/env bash
# Optional live benchmark. Requires reviewed targets and explicit model credentials.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LABEL="${1:-run}"
SPEC="${2:-bench/single.blop.ts}"
CLI="${BLOP_CLI_BIN:-blop}"

if [[ ! "$LABEL" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Label must contain only letters, digits, underscores, and hyphens." >&2
  exit 1
fi
: "${BLOP_AGENT_PROVIDER:?Set an explicit provider}"
: "${BLOP_AGENT_MODEL:?Set an explicit model}"
: "${BLOP_AGENT_API_KEY:?Inject a provider key securely}"
if ! command -v "$CLI" >/dev/null; then
  echo "Install a compatible blop CLI or set BLOP_CLI_BIN to its executable." >&2
  exit 1
fi
if [[ ! -f "$SPEC" ]]; then
  echo "Reviewed spec does not exist: $SPEC" >&2
  exit 1
fi

PROGRESS="bench/progress-$LABEL.ndjson"
REPORT="bench/report-$LABEL"
LOG="bench/stdout-$LABEL.log"
for output in "$PROGRESS" "$REPORT" "$LOG"; do
  if [[ -e "$output" ]]; then
    echo "Refusing to overwrite evidence: $output. Choose a new label." >&2
    exit 1
  fi
done

START=$SECONDS
if "$CLI" flow test "$SPEC" \
  --capture-screenshots \
  --progress-file "$PROGRESS" \
  --report-dir "$REPORT" \
  --max-steps 40 \
  >"$LOG" 2>&1; then
  CODE=0
else
  CODE=$?
fi
printf 'label=%s\nexit_code=%s\nwall_seconds=%s\n' "$LABEL" "$CODE" "$((SECONDS - START))"
node --input-type=module - "$PROGRESS" <<'NODE'
import { existsSync, readFileSync } from "node:fs";
const path = process.argv[2];
if (!existsSync(path)) {
  console.log("actions=unavailable (no progress evidence produced)");
} else {
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
  const events = lines.map((line) => JSON.parse(line));
  console.log(`actions=${events.filter((event) => event.type === "action").length}`);
}
NODE
printf 'progress=%s\nreport=%s\nstdout=%s\n' "$PROGRESS" "$REPORT" "$LOG"
exit "$CODE"
