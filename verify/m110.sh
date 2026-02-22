#!/usr/bin/env bash
set -euo pipefail

M="M110"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (swarm transparency and user-control contracts)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m110-transparency-user-control-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M110.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"
  "docs/spec/CONFORMANCE.md"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/events/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/liquidity_directory.list.response.json"
  "docs/spec/examples/api/liquidity_directory.get.response.json"
  "docs/spec/examples/api/liquidity_directory.persona.list.response.json"
  "docs/spec/examples/api/counterparty_preferences.get.response.json"
  "docs/spec/examples/api/counterparty_preferences.upsert.request.json"
  "docs/spec/examples/api/counterparty_preferences.upsert.response.json"
  "docs/spec/examples/api/proposal_counterparty_disclosure.get.response.json"
  "docs/spec/examples/api/receipt_counterparty_disclosure.get.response.json"

  "docs/spec/schemas/LiquidityDirectoryProviderView.schema.json"
  "docs/spec/schemas/LiquidityDirectoryListResponse.schema.json"
  "docs/spec/schemas/LiquidityDirectoryGetResponse.schema.json"
  "docs/spec/schemas/LiquidityDirectoryPersonaListResponse.schema.json"
  "docs/spec/schemas/CounterpartyPreferenceCategoryRule.schema.json"
  "docs/spec/schemas/CounterpartyPreferencesView.schema.json"
  "docs/spec/schemas/CounterpartyPreferencesGetResponse.schema.json"
  "docs/spec/schemas/CounterpartyPreferencesUpsertRequest.schema.json"
  "docs/spec/schemas/CounterpartyPreferencesUpsertResponse.schema.json"
  "docs/spec/schemas/CounterpartyDisclosureEntry.schema.json"
  "docs/spec/schemas/ProposalCounterpartyDisclosureGetResponse.schema.json"
  "docs/spec/schemas/ReceiptCounterpartyDisclosureGetResponse.schema.json"

  "src/service/liquidityTransparencyService.mjs"
  "src/server/runtimeApiServer.mjs"
  "src/store/jsonStateStore.mjs"
  "scripts/run-m110-transparency-user-control-scenario.mjs"
  "fixtures/release/m110_scenario.json"
  "fixtures/release/m110_expected.json"
  "milestones/M110.yaml"
  "verify/m110.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m110-transparency-user-control-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/liquidity_transparency_output.json" "$LATEST_DIR/liquidity_transparency_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
