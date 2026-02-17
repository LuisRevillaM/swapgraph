#!/usr/bin/env bash
set -euo pipefail

M="M27"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (correlation_id in ErrorResponse)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ OUT_DIR=$OUT_DIR/m4 node scripts/run-m4-intent-scenario.mjs"
  echo "$ OUT_DIR=$OUT_DIR/m7 node scripts/run-m7-commit-scenario.mjs"
  echo "$ OUT_DIR=$OUT_DIR/m13 node scripts/run-m13-settlement-read-api-scenario.mjs"
  echo "$ OUT_DIR=$OUT_DIR/m18 node scripts/run-m18-cycle-proposals-read-scenario.mjs"
  echo "$ OUT_DIR=$OUT_DIR/m20 node scripts/run-m20-commit-from-store-scenario.mjs"
  echo "$ OUT_DIR=$OUT_DIR/m25 node scripts/run-m25-settlement-write-contract-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M27.md"

  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/schemas/ErrorResponse.schema.json"
  "docs/spec/examples/api/error.example.json"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"

  "scripts/validate-api-contract.mjs"

  "scripts/run-m4-intent-scenario.mjs"
  "scripts/run-m7-commit-scenario.mjs"
  "scripts/run-m13-settlement-read-api-scenario.mjs"
  "scripts/run-m18-cycle-proposals-read-scenario.mjs"
  "scripts/run-m20-commit-from-store-scenario.mjs"
  "scripts/run-m25-settlement-write-contract-scenario.mjs"

  "fixtures/scenarios/m4_intents_scenario.json"
  "fixtures/scenarios/m4_expected_results.json"

  "fixtures/commit/m7_scenario.json"
  "fixtures/commit/m7_expected.json"

  "fixtures/settlement/m13_scenario.json"
  "fixtures/settlement/m13_expected.json"

  "fixtures/proposals/m18_scenario.json"
  "fixtures/proposals/m18_expected.json"

  "fixtures/commit/m20_scenario.json"
  "fixtures/commit/m20_expected.json"

  "fixtures/settlement/m25_scenario.json"
  "fixtures/settlement/m25_expected.json"

  "src/service/swapIntentsService.mjs"
  "src/read/cycleProposalsReadService.mjs"
  "src/commit/commitService.mjs"
  "src/service/cycleProposalsCommitService.mjs"
  "src/read/settlementReadService.mjs"
  "src/service/settlementWriteApiService.mjs"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"

mkdir -p "$OUT_DIR/m4" "$OUT_DIR/m7" "$OUT_DIR/m13" "$OUT_DIR/m18" "$OUT_DIR/m20" "$OUT_DIR/m25"

OUT_DIR="$OUT_DIR/m4" node scripts/run-m4-intent-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1
OUT_DIR="$OUT_DIR/m7" node scripts/run-m7-commit-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1
OUT_DIR="$OUT_DIR/m13" node scripts/run-m13-settlement-read-api-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1
OUT_DIR="$OUT_DIR/m18" node scripts/run-m18-cycle-proposals-read-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1
OUT_DIR="$OUT_DIR/m20" node scripts/run-m20-commit-from-store-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1
OUT_DIR="$OUT_DIR/m25" node scripts/run-m25-settlement-write-contract-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cat > "$OUT_DIR/assertions.json" <<'JSON'
{
  "milestone": "M27",
  "status": "pass"
}
JSON

# ---- copy stable artifacts to latest ----
mkdir -p "$LATEST_DIR/m4" "$LATEST_DIR/m7" "$LATEST_DIR/m13" "$LATEST_DIR/m18" "$LATEST_DIR/m20" "$LATEST_DIR/m25"

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

cp "$OUT_DIR/m13/settlement_read_output.json" "$LATEST_DIR/m13/settlement_read_output.json"
cp "$OUT_DIR/m13/assertions.json" "$LATEST_DIR/m13/assertions.json"

cp "$OUT_DIR/m18/proposals_read_output.json" "$LATEST_DIR/m18/proposals_read_output.json"
cp "$OUT_DIR/m18/assertions.json" "$LATEST_DIR/m18/assertions.json"

cp "$OUT_DIR/m20/commit_output.json" "$LATEST_DIR/m20/commit_output.json"
cp "$OUT_DIR/m20/events_outbox.ndjson" "$LATEST_DIR/m20/events_outbox.ndjson"
cp "$OUT_DIR/m20/events_validation.json" "$LATEST_DIR/m20/events_validation.json"
cp "$OUT_DIR/m20/assertions.json" "$LATEST_DIR/m20/assertions.json"

cp "$OUT_DIR/m25/settlement_write_output.json" "$LATEST_DIR/m25/settlement_write_output.json"
cp "$OUT_DIR/m25/assertions.json" "$LATEST_DIR/m25/assertions.json"

echo "verify ${M} pass"
