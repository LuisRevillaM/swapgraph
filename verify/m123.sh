#!/usr/bin/env bash
set -euo pipefail

M="M123"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (typescript matching module migration phase 2)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m123-typescript-matching-module-parity-phase2-scenario.mjs"
  echo "$ npm run verify:m122"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M123.md"
  "src-ts/matching/values.mts"
  "src-ts/matching/scoring.mts"
  "src-ts/matching/proposals.mts"
  "scripts/run-m123-typescript-matching-module-parity-phase2-scenario.mjs"
  "fixtures/release/m123_scenario.json"
  "fixtures/release/m123_expected.json"
  "milestones/M123.yaml"
  "verify/m123.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

OUT_DIR="$OUT_DIR" node scripts/run-m123-typescript-matching-module-parity-phase2-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m122 >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/typescript_matching_module_parity_phase2_output.json" "$LATEST_DIR/typescript_matching_module_parity_phase2_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
