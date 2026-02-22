#!/usr/bin/env bash
set -euo pipefail

M="M102"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (commercial packaging and policy contracts)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m102-commercial-policy-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M102.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"
  "docs/spec/CONFORMANCE.md"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/commercial_policy.transaction_fee.get.response.json"
  "docs/spec/examples/api/commercial_policy.transaction_fee.upsert.request.json"
  "docs/spec/examples/api/commercial_policy.transaction_fee.upsert.response.json"
  "docs/spec/examples/api/commercial_policy.subscription_tier.get.response.json"
  "docs/spec/examples/api/commercial_policy.subscription_tier.upsert.request.json"
  "docs/spec/examples/api/commercial_policy.subscription_tier.upsert.response.json"
  "docs/spec/examples/api/commercial_policy.boost_policy.get.response.json"
  "docs/spec/examples/api/commercial_policy.boost_policy.upsert.request.json"
  "docs/spec/examples/api/commercial_policy.boost_policy.upsert.response.json"
  "docs/spec/examples/api/commercial_policy.quota_policy.get.response.json"
  "docs/spec/examples/api/commercial_policy.quota_policy.upsert.request.json"
  "docs/spec/examples/api/commercial_policy.quota_policy.upsert.response.json"
  "docs/spec/examples/api/commercial_policy.evaluate.request.json"
  "docs/spec/examples/api/commercial_policy.evaluate.response.json"
  "docs/spec/examples/api/commercial_policy.export.response.json"

  "docs/spec/schemas/CommercialTransactionFeePolicyGetResponse.schema.json"
  "docs/spec/schemas/CommercialTransactionFeePolicyUpsertRequest.schema.json"
  "docs/spec/schemas/CommercialTransactionFeePolicyUpsertResponse.schema.json"
  "docs/spec/schemas/CommercialSubscriptionTierPolicyGetResponse.schema.json"
  "docs/spec/schemas/CommercialSubscriptionTierPolicyUpsertRequest.schema.json"
  "docs/spec/schemas/CommercialSubscriptionTierPolicyUpsertResponse.schema.json"
  "docs/spec/schemas/CommercialBoostPolicyGetResponse.schema.json"
  "docs/spec/schemas/CommercialBoostPolicyUpsertRequest.schema.json"
  "docs/spec/schemas/CommercialBoostPolicyUpsertResponse.schema.json"
  "docs/spec/schemas/CommercialQuotaPolicyGetResponse.schema.json"
  "docs/spec/schemas/CommercialQuotaPolicyUpsertRequest.schema.json"
  "docs/spec/schemas/CommercialQuotaPolicyUpsertResponse.schema.json"
  "docs/spec/schemas/CommercialPolicyEvaluateRequest.schema.json"
  "docs/spec/schemas/CommercialPolicyEvaluateResponse.schema.json"
  "docs/spec/schemas/CommercialPolicyExportResponse.schema.json"

  "src/service/commercialPolicyService.mjs"
  "src/server/runtimeApiServer.mjs"
  "src/store/jsonStateStore.mjs"
  "scripts/run-m102-commercial-policy-scenario.mjs"
  "fixtures/release/m102_scenario.json"
  "fixtures/release/m102_expected.json"
  "milestones/M102.yaml"
  "verify/m102.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m102-commercial-policy-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/commercial_policy_output.json" "$LATEST_DIR/commercial_policy_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
