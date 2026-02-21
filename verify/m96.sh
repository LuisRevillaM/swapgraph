#!/usr/bin/env bash
set -euo pipefail

M="M96"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (reliability auto-remediation planning contract)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m96-reliability-remediation-planning-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M96.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"

  "src/store/jsonStateStore.mjs"
  "src/crypto/policyIntegritySigning.mjs"
  "src/service/reliabilityConformanceService.mjs"
  "src/service/reliabilityRemediationPlanningService.mjs"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/reliability.remediation_plan.suggest.request.json"
  "docs/spec/examples/api/reliability.remediation_plan.suggest.response.json"
  "docs/spec/examples/api/reliability.remediation_plan.export.response.json"

  "docs/spec/schemas/ReliabilityRemediationPlanSuggestRequest.schema.json"
  "docs/spec/schemas/ReliabilityRemediationPlanSuggestResponse.schema.json"
  "docs/spec/schemas/ReliabilityRemediationPlanExportResponse.schema.json"

  "fixtures/reliability/m96_scenario.json"
  "fixtures/reliability/m96_expected.json"

  "scripts/run-m96-reliability-remediation-planning-scenario.mjs"
  "milestones/M96.yaml"
  "verify/m96.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m96-reliability-remediation-planning-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/reliability_remediation_planning_output.json" "$LATEST_DIR/reliability_remediation_planning_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
