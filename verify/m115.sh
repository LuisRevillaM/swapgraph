#!/usr/bin/env bash
set -euo pipefail

M="M115"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (bounded exhaustive cycle enumeration contracts)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m115-bounded-cycle-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M115.md"
  "src/matching/cycles.mjs"
  "src/matching/engine.mjs"
  "scripts/run-m115-bounded-cycle-scenario.mjs"
  "fixtures/release/m115_scenario.json"
  "fixtures/release/m115_expected.json"
  "milestones/M115.yaml"
  "verify/m115.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

OUT_DIR="$OUT_DIR" node scripts/run-m115-bounded-cycle-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/bounded_cycle_matching_output.json" "$LATEST_DIR/bounded_cycle_matching_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
