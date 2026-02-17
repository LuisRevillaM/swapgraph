#!/usr/bin/env bash
set -euo pipefail

M="M19"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (proposal delivery persistence + partner scoping)"
  echo "utc=$(date -u +%Y-%m-%dT%H%M%S)"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m19-delivery-persistence-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M19.md"
  "fixtures/delivery/m6_expected.json"
  "fixtures/delivery/m19_scenario.json"
  "fixtures/delivery/m19_expected.json"
  "docs/spec/api/manifest.v1.json"
  "docs/spec/events/manifest.v1.json"
  "docs/spec/schemas/CycleProposal.schema.json"
  "docs/spec/schemas/CycleProposalListResponse.schema.json"
  "docs/spec/schemas/CycleProposalGetResponse.schema.json"
  "docs/spec/schemas/EventEnvelope.schema.json"
  "docs/spec/schemas/ProposalCreatedPayload.schema.json"
  "docs/spec/schemas/ErrorResponse.schema.json"
  "scripts/run-m19-delivery-persistence-scenario.mjs"
  "src/delivery/proposalIngestService.mjs"
  "src/read/cycleProposalsReadService.mjs"
  "src/store/jsonStateStore.mjs"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

OUT_DIR="$OUT_DIR" node scripts/run-m19-delivery-persistence-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/delivery_persistence_output.json" "$LATEST_DIR/delivery_persistence_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
