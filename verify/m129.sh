#!/usr/bin/env bash
set -euo pipefail

M="M129"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (typescript service matcher-runner seam parity gate)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m129-typescript-service-runner-parity-scenario.mjs"
  echo "$ npm run verify:m128"
  echo "$ npm run verify:m125"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M129.md"
  "src/service/marketplaceMatcherRunners.mjs"
  "src-ts/service/marketplaceMatcherRunners.mts"
  "src/service/marketplaceMatchingService.mjs"
  "scripts/run-m129-typescript-service-runner-parity-scenario.mjs"
  "fixtures/release/m129_scenario.json"
  "fixtures/release/m129_expected.json"
  "verify/m129.sh"
  "milestones/M129.yaml"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

OUT_DIR="$OUT_DIR" node scripts/run-m129-typescript-service-runner-parity-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m128 >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m125 >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/typescript_service_runner_parity_output.json" "$LATEST_DIR/typescript_service_runner_parity_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
