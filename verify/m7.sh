#!/usr/bin/env bash
set -euo pipefail

M="M7"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (commit handshake + reservations)"
  echo "utc=$(date -u +%Y-%m-%dT%H%M%S)"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m7-commit-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M7.md"
  "docs/spec/COMMIT.md"
  "fixtures/commit/m7_scenario.json"
  "fixtures/commit/m7_expected.json"
  "scripts/run-m7-commit-scenario.mjs"
)
for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

OUT_DIR="$OUT_DIR" node scripts/run-m7-commit-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/commit_output.json" "$LATEST_DIR/commit_output.json"
cp "$OUT_DIR/events_outbox.ndjson" "$LATEST_DIR/events_outbox.ndjson"
cp "$OUT_DIR/events_validation.json" "$LATEST_DIR/events_validation.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
