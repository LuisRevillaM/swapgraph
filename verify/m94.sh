#!/usr/bin/env bash
set -euo pipefail

M="M94"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (cross-adapter compensation ledger + signed export)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m94-cross-adapter-compensation-ledger-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M94.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"

  "src/store/jsonStateStore.mjs"
  "src/service/crossAdapterCompensationLedgerService.mjs"
  "src/crypto/policyIntegritySigning.mjs"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/compensation.cross_adapter.ledger.record.request.json"
  "docs/spec/examples/api/compensation.cross_adapter.ledger.record.response.json"
  "docs/spec/examples/api/compensation.cross_adapter.ledger.export.response.json"

  "docs/spec/schemas/CrossAdapterCompensationLedgerRecordRequest.schema.json"
  "docs/spec/schemas/CrossAdapterCompensationLedgerRecordResponse.schema.json"
  "docs/spec/schemas/CrossAdapterCompensationLedgerExportResponse.schema.json"

  "scripts/run-m94-cross-adapter-compensation-ledger-scenario.mjs"
  "fixtures/compensation/m94_scenario.json"
  "fixtures/compensation/m94_expected.json"

  "milestones/M94.yaml"
  "verify/m94.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m94-cross-adapter-compensation-ledger-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/cross_adapter_compensation_ledger_output.json" "$LATEST_DIR/cross_adapter_compensation_ledger_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
