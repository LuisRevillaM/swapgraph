#!/usr/bin/env bash
set -euo pipefail

M="M105"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (liquidity inventory contracts)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m105-liquidity-inventory-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M105.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"
  "docs/spec/CONFORMANCE.md"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/events/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/liquidity_inventory.snapshot.record.request.json"
  "docs/spec/examples/api/liquidity_inventory.snapshot.record.response.json"
  "docs/spec/examples/api/liquidity_inventory.assets.list.response.json"
  "docs/spec/examples/api/liquidity_inventory.availability.get.response.json"
  "docs/spec/examples/api/liquidity_inventory.reserve.batch.request.json"
  "docs/spec/examples/api/liquidity_inventory.reserve.batch.response.json"
  "docs/spec/examples/api/liquidity_inventory.release.batch.request.json"
  "docs/spec/examples/api/liquidity_inventory.release.batch.response.json"
  "docs/spec/examples/api/liquidity_inventory.reconciliation.export.response.json"

  "docs/spec/schemas/LiquidityInventoryAssetView.schema.json"
  "docs/spec/schemas/LiquidityInventoryAvailabilityAsset.schema.json"
  "docs/spec/schemas/LiquidityInventoryReservationView.schema.json"
  "docs/spec/schemas/LiquidityInventoryReservationOutcome.schema.json"
  "docs/spec/schemas/LiquidityInventoryReleaseOutcome.schema.json"
  "docs/spec/schemas/LiquidityInventoryReconciliationEntry.schema.json"
  "docs/spec/schemas/LiquidityInventorySnapshotRecordRequest.schema.json"
  "docs/spec/schemas/LiquidityInventorySnapshotRecordResponse.schema.json"
  "docs/spec/schemas/LiquidityInventoryAssetListResponse.schema.json"
  "docs/spec/schemas/LiquidityInventoryAvailabilityGetResponse.schema.json"
  "docs/spec/schemas/LiquidityInventoryReservationBatchRequest.schema.json"
  "docs/spec/schemas/LiquidityInventoryReservationBatchResponse.schema.json"
  "docs/spec/schemas/LiquidityInventoryReleaseBatchRequest.schema.json"
  "docs/spec/schemas/LiquidityInventoryReleaseBatchResponse.schema.json"
  "docs/spec/schemas/LiquidityInventoryReconciliationExportResponse.schema.json"

  "src/service/liquidityInventoryService.mjs"
  "src/server/runtimeApiServer.mjs"
  "src/store/jsonStateStore.mjs"
  "scripts/run-m105-liquidity-inventory-scenario.mjs"
  "fixtures/release/m105_scenario.json"
  "fixtures/release/m105_expected.json"
  "milestones/M105.yaml"
  "verify/m105.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m105-liquidity-inventory-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/liquidity_inventory_output.json" "$LATEST_DIR/liquidity_inventory_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
