#!/usr/bin/env bash
set -euo pipefail

M="M126"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (typescript service helper extraction parity gate)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m126-typescript-service-helper-parity-scenario.mjs"
  echo "$ npm run verify:m125"
  echo "$ npm run verify:m121"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M126.md"
  "src/service/marketplaceMatchingHelpers.mjs"
  "src-ts/service/marketplaceMatchingHelpers.mts"
  "src/service/marketplaceMatchingService.mjs"
  "scripts/run-m126-typescript-service-helper-parity-scenario.mjs"
  "fixtures/release/m126_scenario.json"
  "fixtures/release/m126_expected.json"
  "verify/m126.sh"
  "milestones/M126.yaml"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

OUT_DIR="$OUT_DIR" node scripts/run-m126-typescript-service-helper-parity-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m125 >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m121 >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/typescript_service_helper_parity_output.json" "$LATEST_DIR/typescript_service_helper_parity_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
