#!/usr/bin/env bash
set -euo pipefail

M="M103"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (liquidity provider primitives and attribution contracts)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m103-liquidity-provider-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M103.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"
  "docs/spec/CONFORMANCE.md"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/events/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/liquidity_providers.register.request.json"
  "docs/spec/examples/api/liquidity_providers.register.response.json"
  "docs/spec/examples/api/liquidity_providers.get.response.json"
  "docs/spec/examples/api/liquidity_providers.list.response.json"
  "docs/spec/examples/api/liquidity_providers.persona.upsert.request.json"
  "docs/spec/examples/api/liquidity_providers.persona.upsert.response.json"

  "docs/spec/schemas/LiquidityProviderRef.schema.json"
  "docs/spec/schemas/BotPersonaRef.schema.json"
  "docs/spec/schemas/LiquidityPolicyRef.schema.json"
  "docs/spec/schemas/LiquidityProviderRegisterRequest.schema.json"
  "docs/spec/schemas/LiquidityProviderRegisterResponse.schema.json"
  "docs/spec/schemas/LiquidityProviderGetResponse.schema.json"
  "docs/spec/schemas/LiquidityProviderListResponse.schema.json"
  "docs/spec/schemas/LiquidityProviderPersonaUpsertRequest.schema.json"
  "docs/spec/schemas/LiquidityProviderPersonaUpsertResponse.schema.json"
  "docs/spec/schemas/LiquidityProviderRegisteredPayload.schema.json"
  "docs/spec/schemas/LiquidityProviderPersonaUpsertedPayload.schema.json"
  "docs/spec/schemas/SwapIntent.schema.json"
  "docs/spec/schemas/CycleProposal.schema.json"
  "docs/spec/schemas/SwapReceipt.schema.json"

  "src/service/liquidityProviderService.mjs"
  "src/server/runtimeApiServer.mjs"
  "src/store/jsonStateStore.mjs"
  "scripts/run-m103-liquidity-provider-scenario.mjs"
  "fixtures/release/m103_scenario.json"
  "fixtures/release/m103_expected.json"
  "milestones/M103.yaml"
  "verify/m103.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m103-liquidity-provider-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/liquidity_provider_output.json" "$LATEST_DIR/liquidity_provider_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
