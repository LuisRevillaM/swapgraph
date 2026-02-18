#!/usr/bin/env bash
set -euo pipefail

M="M49"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (vault auth/scope transport wiring)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m49-vault-auth-surface-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M49.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/AUTH.md"
  "docs/spec/GAPS.md"
  "docs/spec/api/manifest.v1.json"

  "scripts/validate-api-auth.mjs"

  "src/vault/vaultLifecycleService.mjs"
  "src/vault/custodyPublicationService.mjs"

  "docs/spec/schemas/VaultDepositRequest.schema.json"
  "docs/spec/schemas/VaultReservationRequest.schema.json"
  "docs/spec/schemas/VaultWithdrawRequest.schema.json"
  "docs/spec/schemas/VaultHoldingMutationResponse.schema.json"
  "docs/spec/schemas/VaultHoldingGetResponse.schema.json"
  "docs/spec/schemas/VaultHoldingListResponse.schema.json"
  "docs/spec/schemas/VaultCustodySnapshotSummary.schema.json"
  "docs/spec/schemas/VaultCustodyPublishRequest.schema.json"
  "docs/spec/schemas/VaultCustodyPublishResponse.schema.json"
  "docs/spec/schemas/VaultCustodySnapshotListResponse.schema.json"
  "docs/spec/schemas/VaultCustodySnapshotGetResponse.schema.json"
  "docs/spec/schemas/VaultCustodyInclusionProofGetResponse.schema.json"

  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/vault.deposit.request.json"
  "docs/spec/examples/api/vault.deposit.response.json"
  "docs/spec/examples/api/vault.reserve.request.json"
  "docs/spec/examples/api/vault.reserve.response.json"
  "docs/spec/examples/api/vault.release.request.json"
  "docs/spec/examples/api/vault.release.response.json"
  "docs/spec/examples/api/vault.withdraw.request.json"
  "docs/spec/examples/api/vault.withdraw.response.json"
  "docs/spec/examples/api/vault.get.response.json"
  "docs/spec/examples/api/vault.list.response.json"
  "docs/spec/examples/api/vault.custody.publish.request.json"
  "docs/spec/examples/api/vault.custody.publish.response.json"
  "docs/spec/examples/api/vault.custody.list.response.json"
  "docs/spec/examples/api/vault.custody.get.response.json"
  "docs/spec/examples/api/vault.custody.proof.response.json"

  "scripts/run-m49-vault-auth-surface-scenario.mjs"
  "fixtures/vault/m49_scenario.json"
  "fixtures/vault/m49_expected.json"

  "verify/m49.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m49-vault-auth-surface-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/vault_auth_surface_output.json" "$LATEST_DIR/vault_auth_surface_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
