#!/usr/bin/env bash
set -euo pipefail

M="M97"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (staging evidence refresh + operator conformance runbook pack)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m97-staging-evidence-conformance-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M97.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"
  "docs/spec/CONFORMANCE.md"

  "ops/M85_LIVE_PROOF_RUNBOOK.md"
  "ops/M86_VAULT_LIVE_PROOF_RUNBOOK.md"
  "ops/M97_STAGING_EVIDENCE_CONFORMANCE_RUNBOOK.md"

  "src/store/jsonStateStore.mjs"
  "src/crypto/policyIntegritySigning.mjs"
  "src/service/stagingEvidenceConformanceService.mjs"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/staging.evidence_bundle.record.request.json"
  "docs/spec/examples/api/staging.evidence_bundle.record.response.json"
  "docs/spec/examples/api/staging.evidence_bundle.export.response.json"

  "docs/spec/schemas/StagingEvidenceBundleRecordRequest.schema.json"
  "docs/spec/schemas/StagingEvidenceBundleRecordResponse.schema.json"
  "docs/spec/schemas/StagingEvidenceBundleExportResponse.schema.json"

  "fixtures/release/m97_scenario.json"
  "fixtures/release/m97_expected.json"

  "scripts/run-m97-staging-evidence-conformance-scenario.mjs"
  "milestones/M97.yaml"
  "verify/m97.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m97-staging-evidence-conformance-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/staging_evidence_conformance_output.json" "$LATEST_DIR/staging_evidence_conformance_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
