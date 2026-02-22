#!/usr/bin/env bash
set -euo pipefail

M="M101"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (product-surface readiness contracts)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m101-product-surface-readiness-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M101.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"
  "docs/spec/CONFORMANCE.md"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/notifications.preferences.get.response.json"
  "docs/spec/examples/api/notifications.preferences.upsert.request.json"
  "docs/spec/examples/api/notifications.preferences.upsert.response.json"
  "docs/spec/examples/api/notifications.inbox.list.response.json"
  "docs/spec/examples/api/product_projection.inventory_awakening.get.response.json"
  "docs/spec/examples/api/product_projection.cycle_inbox.list.response.json"
  "docs/spec/examples/api/product_projection.settlement_timeline.get.response.json"
  "docs/spec/examples/api/product_projection.receipt_share.get.response.json"
  "docs/spec/examples/api/partner_ui.capabilities.get.response.json"
  "docs/spec/examples/api/partner_ui.bundle.get.response.json"

  "docs/spec/schemas/NotificationPreferencesGetResponse.schema.json"
  "docs/spec/schemas/NotificationPreferencesUpsertRequest.schema.json"
  "docs/spec/schemas/NotificationPreferencesUpsertResponse.schema.json"
  "docs/spec/schemas/NotificationInboxListResponse.schema.json"
  "docs/spec/schemas/InventoryAwakeningProjectionResponse.schema.json"
  "docs/spec/schemas/CycleInboxProjectionListResponse.schema.json"
  "docs/spec/schemas/SettlementTimelineDigestResponse.schema.json"
  "docs/spec/schemas/ReceiptShareProjectionResponse.schema.json"
  "docs/spec/schemas/PartnerUiCapabilitiesGetResponse.schema.json"
  "docs/spec/schemas/PartnerUiBundleGetResponse.schema.json"

  "src/service/productSurfaceReadinessService.mjs"
  "src/server/runtimeApiServer.mjs"
  "src/store/jsonStateStore.mjs"
  "scripts/run-m101-product-surface-readiness-scenario.mjs"
  "fixtures/release/m101_scenario.json"
  "fixtures/release/m101_expected.json"
  "milestones/M101.yaml"
  "verify/m101.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m101-product-surface-readiness-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/product_surface_readiness_output.json" "$LATEST_DIR/product_surface_readiness_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
