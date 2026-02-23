#!/usr/bin/env bash
set -euo pipefail

M="M118"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (matching v2 shadow burn-in gate)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m118-shadow-burnin-gate-scenario.mjs"
  echo "$ npm run verify:m117:local"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M118.md"
  "src/service/marketplaceMatchingService.mjs"
  "scripts/run-m118-shadow-burnin-gate-scenario.mjs"
  "fixtures/release/m118_scenario.json"
  "fixtures/release/m118_expected.json"
  "milestones/M118.yaml"
  "verify/m118.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

OUT_DIR="$OUT_DIR" node scripts/run-m118-shadow-burnin-gate-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m117:local >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/matching_v2_shadow_burnin_output.json" "$LATEST_DIR/matching_v2_shadow_burnin_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
