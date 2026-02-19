#!/usr/bin/env bash
set -euo pipefail

M="M56"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (partner program governance surfaces + rollout policy hooks)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 SETTLEMENT_VAULT_EXPORT_PARTNER_PROGRAM_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m56-partner-program-governance-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M56.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/GAPS.md"

  "src/read/settlementReadService.mjs"
  "src/store/jsonStateStore.mjs"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/schemas/PartnerProgramVaultExportGetResponse.schema.json"
  "docs/spec/schemas/SettlementVaultReconciliationExportResponse.schema.json"

  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/partner_program.vault_export.get.response.json"
  "docs/spec/examples/api/settlement.vault_reconciliation.export.paginated.response.json"

  "scripts/run-m56-partner-program-governance-scenario.mjs"
  "fixtures/vault/m56_scenario.json"
  "fixtures/vault/m56_expected.json"

  "milestones/M56.yaml"
  "verify/m56.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 SETTLEMENT_VAULT_EXPORT_PARTNER_PROGRAM_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m56-partner-program-governance-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/partner_program_governance_output.json" "$LATEST_DIR/partner_program_governance_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
