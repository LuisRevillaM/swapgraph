#!/usr/bin/env bash
set -euo pipefail

M="M99"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (trust and safety risk-signal contracts)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m99-trust-safety-contracts-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M99.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"
  "docs/spec/CONFORMANCE.md"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/trust_safety.signal.record.request.json"
  "docs/spec/examples/api/trust_safety.signal.record.response.json"
  "docs/spec/examples/api/trust_safety.decision.record.request.json"
  "docs/spec/examples/api/trust_safety.decision.record.response.json"
  "docs/spec/examples/api/trust_safety.decision.get.response.json"
  "docs/spec/examples/api/trust_safety.decision.export.response.json"

  "docs/spec/schemas/TrustSafetySignal.schema.json"
  "docs/spec/schemas/TrustSafetySignalRecordRequest.schema.json"
  "docs/spec/schemas/TrustSafetySignalRecordResponse.schema.json"
  "docs/spec/schemas/TrustSafetyDecision.schema.json"
  "docs/spec/schemas/TrustSafetyDecisionRecordRequest.schema.json"
  "docs/spec/schemas/TrustSafetyDecisionRecordResponse.schema.json"
  "docs/spec/schemas/TrustSafetyDecisionGetResponse.schema.json"
  "docs/spec/schemas/TrustSafetyDecisionExportResponse.schema.json"

  "src/service/trustSafetyService.mjs"
  "src/server/runtimeApiServer.mjs"
  "src/store/jsonStateStore.mjs"
  "scripts/run-m99-trust-safety-contracts-scenario.mjs"
  "fixtures/release/m99_scenario.json"
  "fixtures/release/m99_expected.json"
  "milestones/M99.yaml"
  "verify/m99.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m99-trust-safety-contracts-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/trust_safety_contracts_output.json" "$LATEST_DIR/trust_safety_contracts_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
