#!/usr/bin/env bash
set -euo pipefail

M="M137"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (typescript service execution helper extraction parity gate)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m137-typescript-service-execution-helper-parity-scenario.mjs"
  echo "$ npm run verify:m136"
  echo "$ npm run verify:m119"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M137.md"
  "src/service/marketplaceMatchingExecutionHelpers.mjs"
  "src-ts/service/marketplaceMatchingExecutionHelpers.mts"
  "src/service/marketplaceMatchingService.mjs"
  "scripts/run-m137-typescript-service-execution-helper-parity-scenario.mjs"
  "fixtures/release/m137_scenario.json"
  "fixtures/release/m137_expected.json"
  "verify/m137.sh"
  "milestones/M137.yaml"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

OUT_DIR="$OUT_DIR" node scripts/run-m137-typescript-service-execution-helper-parity-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m136 >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m119 >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/typescript_service_execution_helper_parity_output.json" "$LATEST_DIR/typescript_service_execution_helper_parity_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
