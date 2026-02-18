#!/usr/bin/env bash
set -euo pipefail

M="M34"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (delegation lifecycle APIs + revocation persistence)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m34-delegations-revocation-persistence-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M34.md"
  "docs/spec/AUTH.md"
  "docs/spec/api/manifest.v1.json"

  "docs/spec/schemas/DelegationGrant.schema.json"
  "docs/spec/schemas/DelegationCreateRequest.schema.json"
  "docs/spec/schemas/DelegationCreateResponse.schema.json"
  "docs/spec/schemas/DelegationGetResponse.schema.json"
  "docs/spec/schemas/DelegationRevokeRequest.schema.json"
  "docs/spec/schemas/DelegationRevokeResponse.schema.json"

  "docs/spec/examples/api/delegations.create.request.json"
  "docs/spec/examples/api/delegations.create.response.json"
  "docs/spec/examples/api/delegations.get.response.json"
  "docs/spec/examples/api/delegations.revoke.request.json"
  "docs/spec/examples/api/delegations.revoke.response.json"
  "docs/spec/examples/api/_manifest.v1.json"

  "fixtures/delegation/m34_scenario.json"
  "fixtures/delegation/m34_expected.json"

  "scripts/run-m34-delegations-revocation-persistence-scenario.mjs"

  "src/core/authz.mjs"
  "src/store/jsonStateStore.mjs"
  "src/service/delegationsService.mjs"
  "src/read/cycleProposalsReadService.mjs"

  "verify/m34.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m34-delegations-revocation-persistence-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

# ---- copy stable artifacts to latest ----
cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/delegations_output.json" "$LATEST_DIR/delegations_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
