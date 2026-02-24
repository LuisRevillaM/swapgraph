#!/usr/bin/env bash
set -euo pipefail

M="M125"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (runtime typescript matcher shadow telemetry)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/sync-matching-ts-shadow-runtime.mjs --check"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m125-typescript-runtime-shadow-scenario.mjs"
  echo "$ npm run verify:m124"
  echo "$ npm run verify:m120"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M125.md"
  "scripts/sync-matching-ts-shadow-runtime.mjs"
  "src/matching-ts-shadow/assetKeys.mjs"
  "src/matching-ts-shadow/cycles.mjs"
  "src/matching-ts-shadow/engine.mjs"
  "src/matching-ts-shadow/graph.mjs"
  "src/matching-ts-shadow/index.mjs"
  "src/matching-ts-shadow/proposals.mjs"
  "src/matching-ts-shadow/scoring.mjs"
  "src/matching-ts-shadow/values.mjs"
  "src/matching-ts-shadow/wantSpec.mjs"
  "src/service/marketplaceMatchingService.mjs"
  "scripts/run-m125-typescript-runtime-shadow-scenario.mjs"
  "fixtures/release/m125_scenario.json"
  "fixtures/release/m125_expected.json"
  "milestones/M125.yaml"
  "verify/m125.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/sync-matching-ts-shadow-runtime.mjs --check >> "$OUT_DIR/commands.log" 2>&1
OUT_DIR="$OUT_DIR" node scripts/run-m125-typescript-runtime-shadow-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m124 >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m120 >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/typescript_runtime_shadow_output.json" "$LATEST_DIR/typescript_runtime_shadow_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
