#!/usr/bin/env bash
set -euo pipefail

M="M59"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (rollout governance controls hardening)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 SETTLEMENT_VAULT_EXPORT_PARTNER_PROGRAM_ENFORCE=1 PARTNER_PROGRAM_ADMIN_ALLOWLIST=ops-admin PARTNER_PROGRAM_ROLLOUT_POLICY_EXPORT_CHECKPOINT_ENFORCE=1 PARTNER_PROGRAM_ROLLOUT_POLICY_EXPORT_CHECKPOINT_RETENTION_DAYS=30 OUT_DIR=$OUT_DIR node scripts/run-m59-rollout-controls-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M59.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"

  "src/read/settlementReadService.mjs"
  "src/store/jsonStateStore.mjs"
  "src/partnerProgram/vaultExportRolloutPolicy.mjs"
  "src/service/partnerProgramGovernanceService.mjs"
  "src/crypto/policyIntegritySigning.mjs"

  "docs/spec/api/manifest.v1.json"

  "docs/spec/schemas/PartnerProgramVaultExportGetResponse.schema.json"
  "docs/spec/schemas/PartnerProgramVaultExportRolloutPolicyView.schema.json"
  "docs/spec/schemas/PartnerProgramVaultExportRolloutPolicyAuditEntry.schema.json"
  "docs/spec/schemas/PartnerProgramVaultExportRolloutPolicyAdminActionRequest.schema.json"
  "docs/spec/schemas/PartnerProgramVaultExportRolloutPolicyAdminActionResponse.schema.json"
  "docs/spec/schemas/PartnerProgramVaultExportRolloutPolicyAuditExportResponse.schema.json"

  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/partner_program.vault_export.get.response.json"
  "docs/spec/examples/api/partner_program.vault_export.rollout_policy.get.response.json"
  "docs/spec/examples/api/partner_program.vault_export.rollout_policy.upsert.response.json"
  "docs/spec/examples/api/partner_program.vault_export.rollout_policy.admin_action.request.json"
  "docs/spec/examples/api/partner_program.vault_export.rollout_policy.admin_action.response.json"
  "docs/spec/examples/api/partner_program.vault_export.rollout_policy_audit.export.response.json"

  "scripts/run-m59-rollout-controls-scenario.mjs"
  "fixtures/vault/m59_scenario.json"
  "fixtures/vault/m59_expected.json"

  "milestones/M59.yaml"
  "verify/m59.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 \
SETTLEMENT_VAULT_EXPORT_PARTNER_PROGRAM_ENFORCE=1 \
PARTNER_PROGRAM_ADMIN_ALLOWLIST=ops-admin \
PARTNER_PROGRAM_ROLLOUT_POLICY_EXPORT_CHECKPOINT_ENFORCE=1 \
PARTNER_PROGRAM_ROLLOUT_POLICY_EXPORT_CHECKPOINT_RETENTION_DAYS=30 \
OUT_DIR="$OUT_DIR" \
node scripts/run-m59-rollout-controls-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/rollout_controls_output.json" "$LATEST_DIR/rollout_controls_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
