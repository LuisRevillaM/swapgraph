#!/usr/bin/env bash
set -euo pipefail

M="M122"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (typescript matching module migration phase 1)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m122-typescript-matching-module-parity-scenario.mjs"
  echo "$ npm run verify:m5"
  echo "$ npm run verify:m111"
  echo "$ npm run verify:m114"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M122.md"
  "src-ts/matching/assetKeys.mts"
  "src-ts/matching/wantSpec.mts"
  "scripts/run-m122-typescript-matching-module-parity-scenario.mjs"
  "fixtures/release/m122_scenario.json"
  "fixtures/release/m122_expected.json"
  "milestones/M122.yaml"
  "verify/m122.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

OUT_DIR="$OUT_DIR" node scripts/run-m122-typescript-matching-module-parity-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m5 >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m111 >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m114 >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/typescript_matching_module_parity_output.json" "$LATEST_DIR/typescript_matching_module_parity_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
