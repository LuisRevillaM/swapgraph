#!/usr/bin/env bash
set -euo pipefail

M="M121"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (typescript shadow scaffold + parity dependencies)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m121-typescript-shadow-scenario.mjs"
  echo "$ npm run verify:m5"
  echo "$ npm run verify:m111"
  echo "$ npm run verify:m114"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M121.md"
  "src-ts/index.mts"
  "src-ts/matching/index.mts"
  "src-ts/service/marketplaceMatchingService.mts"
  "scripts/run-m121-typescript-shadow-scenario.mjs"
  "fixtures/release/m121_scenario.json"
  "fixtures/release/m121_expected.json"
  "milestones/M121.yaml"
  "verify/m121.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

OUT_DIR="$OUT_DIR" node scripts/run-m121-typescript-shadow-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m5 >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m111 >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m114 >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/typescript_shadow_output.json" "$LATEST_DIR/typescript_shadow_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
