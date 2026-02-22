#!/usr/bin/env bash
set -euo pipefail

M="M104"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (swarm simulation contracts)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m104-liquidity-simulation-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M104.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"
  "docs/spec/CONFORMANCE.md"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/events/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/liquidity_simulation.session.start.request.json"
  "docs/spec/examples/api/liquidity_simulation.session.start.response.json"
  "docs/spec/examples/api/liquidity_simulation.session.get.response.json"
  "docs/spec/examples/api/liquidity_simulation.session.stop.request.json"
  "docs/spec/examples/api/liquidity_simulation.session.stop.response.json"
  "docs/spec/examples/api/liquidity_simulation.intent.sync.request.json"
  "docs/spec/examples/api/liquidity_simulation.intent.sync.response.json"
  "docs/spec/examples/api/liquidity_simulation.cycle.export.response.json"
  "docs/spec/examples/api/liquidity_simulation.receipt.export.response.json"

  "docs/spec/schemas/LiquiditySimulationSessionView.schema.json"
  "docs/spec/schemas/LiquiditySimulationSessionStartRequest.schema.json"
  "docs/spec/schemas/LiquiditySimulationSessionStartResponse.schema.json"
  "docs/spec/schemas/LiquiditySimulationSessionGetResponse.schema.json"
  "docs/spec/schemas/LiquiditySimulationSessionStopRequest.schema.json"
  "docs/spec/schemas/LiquiditySimulationIntentSyncRequest.schema.json"
  "docs/spec/schemas/LiquiditySimulationIntentSyncResponse.schema.json"
  "docs/spec/schemas/LiquiditySimulationCycleEntry.schema.json"
  "docs/spec/schemas/LiquiditySimulationReceiptEntry.schema.json"
  "docs/spec/schemas/LiquiditySimulationCycleExportResponse.schema.json"
  "docs/spec/schemas/LiquiditySimulationReceiptExportResponse.schema.json"
  "docs/spec/schemas/LiquiditySimulationSessionStartedPayload.schema.json"
  "docs/spec/schemas/LiquiditySimulationCycleCompletedPayload.schema.json"
  "docs/spec/schemas/LiquiditySimulationSessionStoppedPayload.schema.json"

  "src/service/liquiditySimulationService.mjs"
  "src/server/runtimeApiServer.mjs"
  "src/store/jsonStateStore.mjs"
  "scripts/run-m104-liquidity-simulation-scenario.mjs"
  "fixtures/release/m104_scenario.json"
  "fixtures/release/m104_expected.json"
  "milestones/M104.yaml"
  "verify/m104.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m104-liquidity-simulation-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/liquidity_simulation_output.json" "$LATEST_DIR/liquidity_simulation_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
