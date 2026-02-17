#!/usr/bin/env bash
set -euo pipefail

M="M15"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (read-side redaction + filtering)"
  echo "utc=$(date -u +%Y-%m-%dT%H%M%S)"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m15-redaction-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M15.md"
  "fixtures/settlement/m15_scenario.json"
  "fixtures/settlement/m15_expected.json"
  "scripts/run-m15-redaction-scenario.mjs"
  "src/read/settlementReadService.mjs"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

OUT_DIR="$OUT_DIR" node scripts/run-m15-redaction-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/redaction_output.json" "$LATEST_DIR/redaction_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
