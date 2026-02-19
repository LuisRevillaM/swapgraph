#!/usr/bin/env bash
set -euo pipefail

M="M57"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (partner rollout-policy governance + signed audit export)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 SETTLEMENT_VAULT_EXPORT_PARTNER_PROGRAM_ENFORCE=1 PARTNER_PROGRAM_ADMIN_ALLOWLIST=ops-admin OUT_DIR=$OUT_DIR node scripts/run-m57-partner-program-rollout-governance-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M57.md"
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

  "docs/spec/schemas/PartnerProgramVaultExportRolloutPolicyView.schema.json"
  "docs/spec/schemas/PartnerProgramVaultExportRolloutPolicyUpsertRequest.schema.json"
  "docs/spec/schemas/PartnerProgramVaultExportRolloutPolicyGetResponse.schema.json"
  "docs/spec/schemas/PartnerProgramVaultExportRolloutPolicyUpsertResponse.schema.json"
  "docs/spec/schemas/PartnerProgramVaultExportRolloutPolicyAuditEntry.schema.json"
  "docs/spec/schemas/PartnerProgramVaultExportRolloutPolicyAuditExportResponse.schema.json"

  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/partner_program.vault_export.rollout_policy.get.response.json"
  "docs/spec/examples/api/partner_program.vault_export.rollout_policy.upsert.request.json"
  "docs/spec/examples/api/partner_program.vault_export.rollout_policy.upsert.response.json"
  "docs/spec/examples/api/partner_program.vault_export.rollout_policy_audit.export.response.json"

  "scripts/run-m57-partner-program-rollout-governance-scenario.mjs"
  "fixtures/vault/m57_scenario.json"
  "fixtures/vault/m57_expected.json"

  "milestones/M57.yaml"
  "verify/m57.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 SETTLEMENT_VAULT_EXPORT_PARTNER_PROGRAM_ENFORCE=1 PARTNER_PROGRAM_ADMIN_ALLOWLIST=ops-admin OUT_DIR="$OUT_DIR" node scripts/run-m57-partner-program-rollout-governance-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/partner_program_rollout_governance_output.json" "$LATEST_DIR/partner_program_rollout_governance_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
