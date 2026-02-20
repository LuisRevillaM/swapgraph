#!/usr/bin/env bash
set -euo pipefail

M="M90"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (cross-adapter cycle semantics + signed receipts)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m90-cross-adapter-cycle-semantics-receipts-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M90.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"

  "src/store/jsonStateStore.mjs"
  "src/service/tier2AdapterCapabilityService.mjs"
  "src/service/crossAdapterCycleService.mjs"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/adapter.cross_cycle.semantics.record.request.json"
  "docs/spec/examples/api/adapter.cross_cycle.semantics.record.response.json"
  "docs/spec/examples/api/adapter.cross_cycle.receipt.record.request.json"
  "docs/spec/examples/api/adapter.cross_cycle.receipt.record.response.json"
  "docs/spec/examples/api/adapter.cross_cycle.receipt.get.response.json"

  "docs/spec/schemas/CrossAdapterCycleSemanticsRecordRequest.schema.json"
  "docs/spec/schemas/CrossAdapterCycleSemanticsRecordResponse.schema.json"
  "docs/spec/schemas/CrossAdapterCycleReceiptRecordRequest.schema.json"
  "docs/spec/schemas/CrossAdapterCycleReceiptRecordResponse.schema.json"
  "docs/spec/schemas/CrossAdapterCycleReceiptGetResponse.schema.json"

  "scripts/run-m90-cross-adapter-cycle-semantics-receipts-scenario.mjs"
  "fixtures/adapters/m90_scenario.json"
  "fixtures/adapters/m90_expected.json"

  "milestones/M90.yaml"
  "verify/m90.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m90-cross-adapter-cycle-semantics-receipts-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/cross_adapter_cycle_semantics_receipts_output.json" "$LATEST_DIR/cross_adapter_cycle_semantics_receipts_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
