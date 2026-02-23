#!/usr/bin/env bash
set -euo pipefail

M="M116"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (disjoint cycle optimizer contracts)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m116-disjoint-optimizer-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M116.md"
  "src/matching/proposals.mjs"
  "scripts/run-m116-disjoint-optimizer-scenario.mjs"
  "fixtures/release/m116_scenario.json"
  "fixtures/release/m116_expected.json"
  "milestones/M116.yaml"
  "verify/m116.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

OUT_DIR="$OUT_DIR" node scripts/run-m116-disjoint-optimizer-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/disjoint_optimizer_output.json" "$LATEST_DIR/disjoint_optimizer_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
