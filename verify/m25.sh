#!/usr/bin/env bash
set -euo pipefail

M="M25"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (settlement write endpoint contracts)"
  echo "utc=$(date -u +%Y-%m-%dT%H%M%S)"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m25-settlement-write-contract-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M25.md"
  "docs/spec/API.md"
  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"

  "docs/spec/schemas/SettlementStartRequest.schema.json"
  "docs/spec/schemas/SettlementStartResponse.schema.json"
  "docs/spec/schemas/SettlementDepositConfirmedRequest.schema.json"
  "docs/spec/schemas/SettlementDepositConfirmedResponse.schema.json"
  "docs/spec/schemas/SettlementBeginExecutionRequest.schema.json"
  "docs/spec/schemas/SettlementBeginExecutionResponse.schema.json"
  "docs/spec/schemas/SettlementCompleteRequest.schema.json"
  "docs/spec/schemas/SettlementCompleteResponse.schema.json"
  "docs/spec/schemas/SettlementExpireDepositWindowRequest.schema.json"
  "docs/spec/schemas/SettlementExpireDepositWindowResponse.schema.json"

  "docs/spec/examples/api/settlement.start.request.json"
  "docs/spec/examples/api/settlement.start.response.json"
  "docs/spec/examples/api/settlement.deposit_confirmed.request.json"
  "docs/spec/examples/api/settlement.deposit_confirmed.response.json"
  "docs/spec/examples/api/settlement.begin_execution.request.json"
  "docs/spec/examples/api/settlement.begin_execution.response.json"
  "docs/spec/examples/api/settlement.complete.request.json"
  "docs/spec/examples/api/settlement.complete.response.json"
  "docs/spec/examples/api/settlement.expire_deposit_window.request.json"
  "docs/spec/examples/api/settlement.expire_deposit_window.response.json"

  "scripts/validate-api-contract.mjs"
  "scripts/run-m25-settlement-write-contract-scenario.mjs"

  "fixtures/settlement/m25_scenario.json"
  "fixtures/settlement/m25_expected.json"

  "src/service/settlementWriteApiService.mjs"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"

OUT_DIR="$OUT_DIR" node scripts/run-m25-settlement-write-contract-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/settlement_write_output.json" "$LATEST_DIR/settlement_write_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
