#!/usr/bin/env bash
set -euo pipefail

M="M26"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (correlation_id in remaining response contracts)"
  echo "utc=$(date -u +%Y-%m-%dT%H%M%S)"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ OUT_DIR=$OUT_DIR/m4 node scripts/run-m4-intent-scenario.mjs"
  echo "$ OUT_DIR=$OUT_DIR/m7 node scripts/run-m7-commit-scenario.mjs"
  echo "$ OUT_DIR=$OUT_DIR/m18 node scripts/run-m18-cycle-proposals-read-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M26.md"
  "docs/spec/API.md"
  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"

  "docs/spec/schemas/SwapIntentUpsertResponse.schema.json"
  "docs/spec/schemas/SwapIntentCancelResponse.schema.json"
  "docs/spec/schemas/SwapIntentGetResponse.schema.json"
  "docs/spec/schemas/SwapIntentListResponse.schema.json"
  "docs/spec/schemas/CycleProposalListResponse.schema.json"
  "docs/spec/schemas/CycleProposalGetResponse.schema.json"
  "docs/spec/schemas/CommitResponse.schema.json"
  "docs/spec/schemas/CommitGetResponse.schema.json"

  "docs/spec/examples/api/swap_intents.create.response.json"
  "docs/spec/examples/api/swap_intents.cancel.response.json"
  "docs/spec/examples/api/cycle_proposals.list.response.json"
  "docs/spec/examples/api/cycle_proposals.accept.response.json"
  "docs/spec/examples/api/cycle_proposals.decline.response.json"
  "docs/spec/examples/api/commits.get.response.json"

  "scripts/validate-api-contract.mjs"
  "scripts/run-m4-intent-scenario.mjs"
  "scripts/run-m7-commit-scenario.mjs"
  "scripts/run-m18-cycle-proposals-read-scenario.mjs"

  "fixtures/scenarios/m4_intents_scenario.json"
  "fixtures/scenarios/m4_expected_results.json"
  "fixtures/commit/m7_scenario.json"
  "fixtures/commit/m7_expected.json"
  "fixtures/proposals/m18_scenario.json"
  "fixtures/proposals/m18_expected.json"

  "src/service/swapIntentsService.mjs"
  "src/read/cycleProposalsReadService.mjs"
  "src/commit/commitService.mjs"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
  done

node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"

mkdir -p "$OUT_DIR/m4" "$OUT_DIR/m7" "$OUT_DIR/m18"

OUT_DIR="$OUT_DIR/m4" node scripts/run-m4-intent-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1
OUT_DIR="$OUT_DIR/m7" node scripts/run-m7-commit-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1
OUT_DIR="$OUT_DIR/m18" node scripts/run-m18-cycle-proposals-read-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cat > "$OUT_DIR/assertions.json" <<'JSON'
{
  "milestone": "M26",
  "status": "pass"
}
JSON

# ---- copy to latest ----
mkdir -p "$LATEST_DIR/m4" "$LATEST_DIR/m7" "$LATEST_DIR/m18"

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

cp "$OUT_DIR/m4/intent_ingestion_results.json" "$LATEST_DIR/m4/intent_ingestion_results.json"
cp "$OUT_DIR/m4/intents_store_snapshot.json" "$LATEST_DIR/m4/intents_store_snapshot.json"
cp "$OUT_DIR/m4/assertions.json" "$LATEST_DIR/m4/assertions.json"

cp "$OUT_DIR/m7/commit_output.json" "$LATEST_DIR/m7/commit_output.json"
cp "$OUT_DIR/m7/events_outbox.ndjson" "$LATEST_DIR/m7/events_outbox.ndjson"
cp "$OUT_DIR/m7/events_validation.json" "$LATEST_DIR/m7/events_validation.json"
cp "$OUT_DIR/m7/assertions.json" "$LATEST_DIR/m7/assertions.json"

cp "$OUT_DIR/m18/proposals_read_output.json" "$LATEST_DIR/m18/proposals_read_output.json"
cp "$OUT_DIR/m18/assertions.json" "$LATEST_DIR/m18/assertions.json"

echo "verify ${M} pass"
