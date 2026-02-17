#!/usr/bin/env bash
set -euo pipefail

M="M24"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (end-to-end store-backed pipeline smoke test)"
  echo "utc=$(date -u +%Y-%m-%dT%H%M%S)"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m24-e2e-pipeline-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M24.md"
  "fixtures/pipeline/m24_scenario.json"
  "fixtures/pipeline/m24_expected.json"
  "fixtures/delivery/m6_expected.json"
  "fixtures/matching/m5_input.json"
  "docs/spec/api/manifest.v1.json"
  "docs/spec/events/manifest.v1.json"
  "scripts/run-m24-e2e-pipeline-scenario.mjs"
  "src/delivery/proposalIngestService.mjs"
  "src/read/cycleProposalsReadService.mjs"
  "src/service/cycleProposalsCommitService.mjs"
  "src/service/settlementStartService.mjs"
  "src/service/settlementActionsService.mjs"
  "src/read/settlementReadService.mjs"
  "src/store/jsonStateStore.mjs"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

OUT_DIR="$OUT_DIR" node scripts/run-m24-e2e-pipeline-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/pipeline_output.json" "$LATEST_DIR/pipeline_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
