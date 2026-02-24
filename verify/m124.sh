#!/usr/bin/env bash
set -euo pipefail

M="M124"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (typescript matching module migration phase 3)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m124-typescript-matching-module-parity-phase3-scenario.mjs"
  echo "$ npm run verify:m123"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M124.md"
  "src-ts/matching/cycles.mts"
  "src-ts/matching/graph.mts"
  "src-ts/matching/engine.mts"
  "scripts/run-m124-typescript-matching-module-parity-phase3-scenario.mjs"
  "fixtures/release/m124_scenario.json"
  "fixtures/release/m124_expected.json"
  "milestones/M124.yaml"
  "verify/m124.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

OUT_DIR="$OUT_DIR" node scripts/run-m124-typescript-matching-module-parity-phase3-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m123 >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/typescript_matching_module_parity_phase3_output.json" "$LATEST_DIR/typescript_matching_module_parity_phase3_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
