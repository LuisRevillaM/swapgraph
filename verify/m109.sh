#!/usr/bin/env bash
set -euo pipefail

M="M109"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (partner liquidity-provider onboarding and governance contracts)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m109-partner-liquidity-governance-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M109.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"
  "docs/spec/CONFORMANCE.md"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/events/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/partner_liquidity_provider.onboard.request.json"
  "docs/spec/examples/api/partner_liquidity_provider.onboard.response.json"
  "docs/spec/examples/api/partner_liquidity_provider.get.response.json"
  "docs/spec/examples/api/partner_liquidity_provider.status.upsert.request.json"
  "docs/spec/examples/api/partner_liquidity_provider.status.upsert.response.json"
  "docs/spec/examples/api/partner_liquidity_provider.eligibility.evaluate.request.json"
  "docs/spec/examples/api/partner_liquidity_provider.eligibility.evaluate.response.json"
  "docs/spec/examples/api/partner_liquidity_provider.rollout.upsert.request.json"
  "docs/spec/examples/api/partner_liquidity_provider.rollout.upsert.response.json"
  "docs/spec/examples/api/partner_liquidity_provider.rollout.export.response.json"

  "docs/spec/schemas/PartnerLiquidityProviderView.schema.json"
  "docs/spec/schemas/PartnerLiquidityProviderOnboardRequest.schema.json"
  "docs/spec/schemas/PartnerLiquidityProviderOnboardResponse.schema.json"
  "docs/spec/schemas/PartnerLiquidityProviderGetResponse.schema.json"
  "docs/spec/schemas/PartnerLiquidityProviderStatusUpsertRequest.schema.json"
  "docs/spec/schemas/PartnerLiquidityProviderStatusUpsertResponse.schema.json"
  "docs/spec/schemas/PartnerLiquidityProviderEligibilityEvaluateRequest.schema.json"
  "docs/spec/schemas/PartnerLiquidityProviderEligibilityEvaluateResponse.schema.json"
  "docs/spec/schemas/PartnerLiquidityProviderRolloutPolicyView.schema.json"
  "docs/spec/schemas/PartnerLiquidityProviderRolloutUpsertRequest.schema.json"
  "docs/spec/schemas/PartnerLiquidityProviderRolloutUpsertResponse.schema.json"
  "docs/spec/schemas/PartnerLiquidityProviderGovernanceAuditEntry.schema.json"
  "docs/spec/schemas/PartnerLiquidityProviderRolloutExportResponse.schema.json"

  "src/service/partnerLiquidityProviderGovernanceService.mjs"
  "src/server/runtimeApiServer.mjs"
  "src/store/jsonStateStore.mjs"
  "scripts/run-m109-partner-liquidity-governance-scenario.mjs"
  "fixtures/release/m109_scenario.json"
  "fixtures/release/m109_expected.json"
  "milestones/M109.yaml"
  "verify/m109.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m109-partner-liquidity-governance-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/partner_liquidity_provider_output.json" "$LATEST_DIR/partner_liquidity_provider_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
