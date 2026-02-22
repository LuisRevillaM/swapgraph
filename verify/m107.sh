#!/usr/bin/env bash
set -euo pipefail

M="M107"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (liquidity execution governance contracts)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 INTEGRATION_ENABLED=1 OUT_DIR=$OUT_DIR node scripts/run-m107-liquidity-execution-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M107.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"
  "docs/spec/CONFORMANCE.md"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/events/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/liquidity_execution.mode.upsert.request.json"
  "docs/spec/examples/api/liquidity_execution.mode.upsert.response.json"
  "docs/spec/examples/api/liquidity_execution.mode.get.response.json"
  "docs/spec/examples/api/liquidity_execution.request.record.request.json"
  "docs/spec/examples/api/liquidity_execution.request.record.response.json"
  "docs/spec/examples/api/liquidity_execution.request.approve.request.json"
  "docs/spec/examples/api/liquidity_execution.request.approve.response.json"
  "docs/spec/examples/api/liquidity_execution.request.reject.request.json"
  "docs/spec/examples/api/liquidity_execution.request.reject.response.json"
  "docs/spec/examples/api/liquidity_execution.export.response.json"

  "docs/spec/schemas/LiquidityExecutionOverridePolicy.schema.json"
  "docs/spec/schemas/LiquidityExecutionModeView.schema.json"
  "docs/spec/schemas/LiquidityExecutionRequestView.schema.json"
  "docs/spec/schemas/LiquidityExecutionModeUpsertRequest.schema.json"
  "docs/spec/schemas/LiquidityExecutionModeUpsertResponse.schema.json"
  "docs/spec/schemas/LiquidityExecutionModeGetResponse.schema.json"
  "docs/spec/schemas/LiquidityExecutionRequestRecordRequest.schema.json"
  "docs/spec/schemas/LiquidityExecutionRequestRecordResponse.schema.json"
  "docs/spec/schemas/LiquidityExecutionRequestApproveRequest.schema.json"
  "docs/spec/schemas/LiquidityExecutionRequestApproveResponse.schema.json"
  "docs/spec/schemas/LiquidityExecutionRequestRejectRequest.schema.json"
  "docs/spec/schemas/LiquidityExecutionRequestRejectResponse.schema.json"
  "docs/spec/schemas/LiquidityExecutionRequestExportResponse.schema.json"
  "docs/spec/schemas/LiquidityExecutionModeUpdatedPayload.schema.json"
  "docs/spec/schemas/LiquidityExecutionRequestRecordedPayload.schema.json"
  "docs/spec/schemas/LiquidityExecutionRequestDecidedPayload.schema.json"

  "src/service/liquidityExecutionService.mjs"
  "src/server/runtimeApiServer.mjs"
  "src/store/jsonStateStore.mjs"
  "scripts/run-m107-liquidity-execution-scenario.mjs"
  "fixtures/release/m107_scenario.json"
  "fixtures/release/m107_expected.json"
  "milestones/M107.yaml"
  "verify/m107.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 INTEGRATION_ENABLED=1 OUT_DIR="$OUT_DIR" node scripts/run-m107-liquidity-execution-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/liquidity_execution_output.json" "$LATEST_DIR/liquidity_execution_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
