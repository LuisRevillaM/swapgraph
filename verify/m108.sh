#!/usr/bin/env bash
set -euo pipefail

M="M108"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (liquidity autonomy policy + decision audit contracts)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m108-liquidity-policy-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M108.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"
  "docs/spec/CONFORMANCE.md"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/events/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/liquidity_policy.upsert.request.json"
  "docs/spec/examples/api/liquidity_policy.upsert.response.json"
  "docs/spec/examples/api/liquidity_policy.get.response.json"
  "docs/spec/examples/api/liquidity_policy.evaluate.request.json"
  "docs/spec/examples/api/liquidity_policy.evaluate.response.json"
  "docs/spec/examples/api/liquidity_decision_audit.list.response.json"
  "docs/spec/examples/api/liquidity_decision_audit.export.response.json"

  "docs/spec/schemas/LiquidityAutonomyPolicyView.schema.json"
  "docs/spec/schemas/LiquidityPolicyUpsertRequest.schema.json"
  "docs/spec/schemas/LiquidityPolicyUpsertResponse.schema.json"
  "docs/spec/schemas/LiquidityPolicyGetResponse.schema.json"
  "docs/spec/schemas/LiquidityPolicyEvaluateRequest.schema.json"
  "docs/spec/schemas/LiquidityPolicyEvaluateResponse.schema.json"
  "docs/spec/schemas/LiquidityDecisionAuditEntry.schema.json"
  "docs/spec/schemas/LiquidityDecisionAuditListResponse.schema.json"
  "docs/spec/schemas/LiquidityDecisionAuditExportResponse.schema.json"

  "src/service/liquidityAutonomyPolicyService.mjs"
  "src/server/runtimeApiServer.mjs"
  "src/store/jsonStateStore.mjs"
  "scripts/run-m108-liquidity-policy-scenario.mjs"
  "fixtures/release/m108_scenario.json"
  "fixtures/release/m108_expected.json"
  "milestones/M108.yaml"
  "verify/m108.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m108-liquidity-policy-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/liquidity_policy_output.json" "$LATEST_DIR/liquidity_policy_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
