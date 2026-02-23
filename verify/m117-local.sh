#!/usr/bin/env bash
set -euo pipefail

M="M117"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} local (matching v2 shadow metrics and determinism)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m117-matching-v2-shadow-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M117.md"
  "src/service/marketplaceMatchingService.mjs"
  "src/matching/engine.mjs"
  "src/matching/cycles.mjs"
  "scripts/run-m117-matching-v2-shadow-scenario.mjs"
  "fixtures/release/m117_scenario.json"
  "fixtures/release/m117_expected.json"
  "milestones/M117.yaml"
  "verify/m117-local.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

OUT_DIR="$OUT_DIR" node scripts/run-m117-matching-v2-shadow-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/matching_v2_shadow_output.json" "$LATEST_DIR/matching_v2_shadow_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} local pass"
