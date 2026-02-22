#!/usr/bin/env bash
set -euo pipefail

M="M98"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (api + event surface completion contracts)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ node scripts/validate-events.mjs > $OUT_DIR/events_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m98-api-event-surface-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M98.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"
  "docs/spec/CONFORMANCE.md"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/events/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/platform_connections.upsert.request.json"
  "docs/spec/examples/api/platform_connections.upsert.response.json"
  "docs/spec/examples/api/platform_connections.list.response.json"
  "docs/spec/examples/api/inventory.snapshots.record.request.json"
  "docs/spec/examples/api/inventory.snapshots.record.response.json"
  "docs/spec/examples/api/inventory.assets.list.response.json"
  "docs/spec/examples/api/disputes.create.request.json"
  "docs/spec/examples/api/disputes.create.response.json"
  "docs/spec/examples/api/disputes.get.response.json"

  "docs/spec/schemas/PlatformConnection.schema.json"
  "docs/spec/schemas/PlatformConnectionListResponse.schema.json"
  "docs/spec/schemas/PlatformConnectionUpsertRequest.schema.json"
  "docs/spec/schemas/PlatformConnectionUpsertResponse.schema.json"
  "docs/spec/schemas/InventorySnapshotRecordRequest.schema.json"
  "docs/spec/schemas/InventorySnapshotRecordResponse.schema.json"
  "docs/spec/schemas/InventoryAssetListResponse.schema.json"
  "docs/spec/schemas/DisputeCreateRequest.schema.json"
  "docs/spec/schemas/DisputeCreateResponse.schema.json"
  "docs/spec/schemas/DisputeGetResponse.schema.json"
  "docs/spec/schemas/ProposalCancelledPayload.schema.json"
  "docs/spec/schemas/CycleFailedPayload.schema.json"
  "docs/spec/schemas/UserReliabilityChangedPayload.schema.json"

  "src/service/platformInventoryDisputeFacadeService.mjs"
  "src/store/jsonStateStore.mjs"
  "scripts/run-m98-api-event-surface-scenario.mjs"
  "fixtures/release/m98_scenario.json"
  "fixtures/release/m98_expected.json"
  "milestones/M98.yaml"
  "verify/m98.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"
node scripts/validate-events.mjs > "$OUT_DIR/events_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m98-api-event-surface-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/events_validation.json" "$LATEST_DIR/events_validation.json"
cp "$OUT_DIR/api_event_surface_output.json" "$LATEST_DIR/api_event_surface_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
