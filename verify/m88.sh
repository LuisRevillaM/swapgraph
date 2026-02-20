#!/usr/bin/env bash
set -euo pipefail

M="M88"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (unified inclusion-proof linkage contract)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 INCLUSION_PROOF_EXPORT_CHECKPOINT_ENFORCE=1 INCLUSION_PROOF_EXPORT_CHECKPOINT_RETENTION_DAYS=1 OUT_DIR=$OUT_DIR node scripts/run-m88-inclusion-proof-linkage-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M88.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"

  "src/store/jsonStateStore.mjs"
  "src/service/inclusionProofLinkageService.mjs"
  "src/service/transparencyLogService.mjs"
  "src/crypto/policyIntegritySigning.mjs"
  "src/crypto/receiptSigning.mjs"
  "src/custody/proofOfCustody.mjs"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/inclusion_proof.linkage.record.request.json"
  "docs/spec/examples/api/inclusion_proof.linkage.record.response.json"
  "docs/spec/examples/api/inclusion_proof.linkage.export.response.json"

  "docs/spec/schemas/InclusionProofLinkageRecordRequest.schema.json"
  "docs/spec/schemas/InclusionProofLinkageRecordResponse.schema.json"
  "docs/spec/schemas/InclusionProofLinkageExportResponse.schema.json"

  "scripts/run-m88-inclusion-proof-linkage-scenario.mjs"
  "fixtures/inclusion/m88_scenario.json"
  "fixtures/inclusion/m88_expected.json"

  "milestones/M88.yaml"
  "verify/m88.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 \
INCLUSION_PROOF_EXPORT_CHECKPOINT_ENFORCE=1 \
INCLUSION_PROOF_EXPORT_CHECKPOINT_RETENTION_DAYS=1 \
OUT_DIR="$OUT_DIR" \
node scripts/run-m88-inclusion-proof-linkage-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/inclusion_proof_linkage_output.json" "$LATEST_DIR/inclusion_proof_linkage_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
