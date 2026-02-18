#!/usr/bin/env bash
set -euo pipefail

M="M35"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (signed delegation token format + auth header parsing)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m35-delegation-token-auth-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M35.md"
  "docs/spec/API.md"
  "docs/spec/AUTH.md"

  "docs/spec/schemas/DelegationGrant.schema.json"
  "docs/spec/schemas/DelegationToken.schema.json"
  "docs/spec/schemas/DelegationCreateResponse.schema.json"
  "docs/spec/schemas/DelegationGetResponse.schema.json"
  "docs/spec/schemas/DelegationRevokeResponse.schema.json"

  "docs/spec/examples/DelegationGrant.example.json"
  "docs/spec/examples/DelegationToken.example.json"

  "docs/spec/examples/api/delegations.create.response.json"
  "docs/spec/examples/api/delegations.get.response.json"
  "docs/spec/examples/api/delegations.revoke.response.json"

  "fixtures/keys/delegation_token_signing_dev_dt_k1_private.pem"
  "fixtures/keys/delegation_token_signing_dev_dt_k1_public.pem"

  "src/crypto/delegationTokenSigning.mjs"
  "src/core/authHeaders.mjs"
  "src/service/delegationsService.mjs"
  "src/core/authz.mjs"

  "fixtures/delegation/m35_scenario.json"
  "fixtures/delegation/m35_expected.json"
  "scripts/run-m35-delegation-token-auth-scenario.mjs"

  "verify/m35.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m35-delegation-token-auth-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

# ---- copy stable artifacts to latest ----
cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/delegation_token_auth_output.json" "$LATEST_DIR/delegation_token_auth_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
