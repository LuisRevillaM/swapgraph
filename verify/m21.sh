#!/usr/bin/env bash
set -euo pipefail

M="M21"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (settlement.start from store + partner proposal scoping)"
  echo "utc=$(date -u +%Y-%m-%dT%H%M%S)"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m21-settlement-start-from-store-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M21.md"
  "fixtures/settlement/m21_scenario.json"
  "fixtures/settlement/m21_expected.json"
  "fixtures/matching/m5_input.json"
  "fixtures/matching/m5_expected.json"
  "docs/spec/api/manifest.v1.json"
  "docs/spec/schemas/CycleProposal.schema.json"
  "docs/spec/schemas/CommitResponse.schema.json"
  "docs/spec/schemas/SettlementStatusGetResponse.schema.json"
  "docs/spec/schemas/ErrorResponse.schema.json"
  "scripts/run-m21-settlement-start-from-store-scenario.mjs"
  "src/service/settlementStartService.mjs"
  "src/service/cycleProposalsCommitService.mjs"
  "src/read/settlementReadService.mjs"
  "src/settlement/settlementService.mjs"
  "src/store/jsonStateStore.mjs"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

OUT_DIR="$OUT_DIR" node scripts/run-m21-settlement-start-from-store-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/settlement_start_output.json" "$LATEST_DIR/settlement_start_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
