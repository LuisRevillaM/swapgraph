#!/usr/bin/env bash
set -euo pipefail

M="M4"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (SwapIntent ingestion + persistence)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m4-intent-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M4.md"
  "fixtures/scenarios/m4_intents_scenario.json"
  "fixtures/scenarios/m4_expected_results.json"
  "scripts/run-m4-intent-scenario.mjs"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

OUT_DIR="$OUT_DIR" node scripts/run-m4-intent-scenario.mjs > "$OUT_DIR/scenario_run.json"

# copy stable artifacts
cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/intent_ingestion_results.json" "$LATEST_DIR/intent_ingestion_results.json"
cp "$OUT_DIR/intents_store_snapshot.json" "$LATEST_DIR/intents_store_snapshot.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
