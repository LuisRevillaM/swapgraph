#!/usr/bin/env bash
set -euo pipefail

M="M6"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (proposal delivery fixtures)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m6-delivery-fixture.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M6.md"
  "fixtures/delivery/m6_input.json"
  "fixtures/delivery/m6_expected.json"
  "scripts/run-m6-delivery-fixture.mjs"
)
for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

OUT_DIR="$OUT_DIR" node scripts/run-m6-delivery-fixture.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/polling_response.json" "$LATEST_DIR/polling_response.json"
cp "$OUT_DIR/webhook_events.ndjson" "$LATEST_DIR/webhook_events.ndjson"
cp "$OUT_DIR/delivery_output.json" "$LATEST_DIR/delivery_output.json"
cp "$OUT_DIR/delivery_validation.json" "$LATEST_DIR/delivery_validation.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
