#!/usr/bin/env bash
set -euo pipefail

M="M23"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (deposit-timeout unwind via scoped API service)"
  echo "utc=$(date -u +%Y-%m-%dT%H%M%S)"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m23-settlement-failure-from-store-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M23.md"
  "fixtures/settlement/m23_scenario.json"
  "fixtures/settlement/m23_expected.json"
  "fixtures/matching/m5_input.json"
  "fixtures/matching/m5_expected.json"
  "scripts/run-m23-settlement-failure-from-store-scenario.mjs"
  "src/service/settlementActionsService.mjs"
  "src/service/settlementStartService.mjs"
  "src/service/cycleProposalsCommitService.mjs"
  "src/settlement/settlementService.mjs"
  "src/commit/commitService.mjs"
  "src/store/jsonStateStore.mjs"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

OUT_DIR="$OUT_DIR" node scripts/run-m23-settlement-failure-from-store-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/settlement_failure_output.json" "$LATEST_DIR/settlement_failure_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
