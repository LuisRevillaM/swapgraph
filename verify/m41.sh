#!/usr/bin/env bash
set -euo pipefail

M="M41"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (consent proof signatures + delegated audit export integrity)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 POLICY_CONSENT_TIER_ENFORCE=1 POLICY_CONSENT_PROOF_BIND_ENFORCE=1 POLICY_CONSENT_PROOF_SIG_ENFORCE=1 POLICY_AUDIT_RETENTION_DAYS=30 OUT_DIR=$OUT_DIR node scripts/run-m41-consent-proof-signature-audit-export-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M41.md"
  "docs/spec/API.md"
  "docs/spec/AUTH.md"
  "docs/spec/KEYS.md"
  "docs/spec/GAPS.md"
  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"

  "docs/spec/schemas/PolicyIntegritySigningKey.schema.json"
  "docs/spec/schemas/PolicyIntegritySigningKeysGetResponse.schema.json"
  "docs/spec/schemas/PolicyAuditExportResponse.schema.json"
  "docs/spec/examples/PolicyIntegritySigningKey.example.json"
  "docs/spec/examples/api/keys.policy_integrity_signing.get.response.json"
  "docs/spec/examples/api/policy_audit.delegated_writes.export.response.json"

  "src/crypto/policyIntegritySigning.mjs"
  "src/core/tradingPolicyBoundaries.mjs"
  "src/read/policyAuditReadService.mjs"
  "src/service/policyIntegritySigningService.mjs"

  "fixtures/keys/policy_integrity_signing_dev_pi_k1_private.pem"
  "fixtures/keys/policy_integrity_signing_dev_pi_k1_public.pem"
  "fixtures/keys/policy_integrity_signing_dev_pi_k2_private.pem"
  "fixtures/keys/policy_integrity_signing_dev_pi_k2_public.pem"

  "scripts/validate-schemas.mjs"
  "scripts/run-m41-consent-proof-signature-audit-export-scenario.mjs"
  "fixtures/delegation/m41_scenario.json"
  "fixtures/delegation/m41_expected.json"

  "verify/m41.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 POLICY_CONSENT_TIER_ENFORCE=1 POLICY_CONSENT_PROOF_BIND_ENFORCE=1 POLICY_CONSENT_PROOF_SIG_ENFORCE=1 POLICY_AUDIT_RETENTION_DAYS=30 OUT_DIR="$OUT_DIR" node scripts/run-m41-consent-proof-signature-audit-export-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/consent_proof_signature_audit_export_output.json" "$LATEST_DIR/consent_proof_signature_audit_export_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
