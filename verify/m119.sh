#!/usr/bin/env bash
set -euo pipefail

M="M119"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (matching v2 canary cutover + rollback gate)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m119-matching-v2-canary-scenario.mjs"
  echo "$ npm run verify:m118"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M119.md"
  "src/service/marketplaceMatchingService.mjs"
  "scripts/run-m119-matching-v2-canary-scenario.mjs"
  "fixtures/release/m119_scenario.json"
  "fixtures/release/m119_expected.json"
  "milestones/M119.yaml"
  "verify/m119.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

OUT_DIR="$OUT_DIR" node scripts/run-m119-matching-v2-canary-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m118 >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/matching_v2_canary_output.json" "$LATEST_DIR/matching_v2_canary_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
