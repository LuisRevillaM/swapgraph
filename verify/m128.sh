#!/usr/bin/env bash
set -euo pipefail

M="M128"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (typescript service wrapper-removal compatibility gate)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m128-typescript-service-wrapper-removal-scenario.mjs"
  echo "$ npm run verify:m127"
  echo "$ npm run verify:m121"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M128.md"
  "src-ts/service/marketplaceMatchingService.mts"
  "scripts/run-m121-typescript-shadow-scenario.mjs"
  "fixtures/release/m121_scenario.json"
  "fixtures/release/m121_expected.json"
  "scripts/run-m128-typescript-service-wrapper-removal-scenario.mjs"
  "fixtures/release/m128_scenario.json"
  "fixtures/release/m128_expected.json"
  "verify/m128.sh"
  "milestones/M128.yaml"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

OUT_DIR="$OUT_DIR" node scripts/run-m128-typescript-service-wrapper-removal-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m127 >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m121 >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/typescript_service_wrapper_removal_output.json" "$LATEST_DIR/typescript_service_wrapper_removal_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
