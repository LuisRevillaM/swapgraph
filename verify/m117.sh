#!/usr/bin/env bash
set -euo pipefail

M="M117"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (composed gate: local shadow + dependencies)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ npm run verify:m117:local"
  echo "$ npm run verify:m111"
  echo "$ npm run verify:m114"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M117.md"
  "verify/m117-local.sh"
  "milestones/M117.yaml"
  "verify/m117.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

npm run verify:m117:local >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m111 >> "$OUT_DIR/commands.log" 2>&1
npm run verify:m114 >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
test -f "$LATEST_DIR/matching_v2_shadow_output.json" || { echo "missing_latest_artifact=matching_v2_shadow_output.json" >> "$OUT_DIR/commands.log"; exit 2; }
test -f "$LATEST_DIR/assertions.json" || { echo "missing_latest_artifact=assertions.json" >> "$OUT_DIR/commands.log"; exit 2; }

echo "verify ${M} pass"
