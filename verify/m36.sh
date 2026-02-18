#!/usr/bin/env bash
set -euo pipefail

M="M36"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (delegation-token key publication/rotation + introspection)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m36-delegation-key-rotation-introspection-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M36.md"
  "docs/spec/API.md"
  "docs/spec/AUTH.md"
  "docs/spec/KEYS.md"
  "docs/spec/GAPS.md"
  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"

  "docs/spec/schemas/DelegationTokenSigningKey.schema.json"
  "docs/spec/schemas/DelegationTokenSigningKeysGetResponse.schema.json"
  "docs/spec/schemas/DelegationTokenIntrospectRequest.schema.json"
  "docs/spec/schemas/DelegationTokenIntrospectResponse.schema.json"

  "docs/spec/examples/DelegationTokenSigningKey.example.json"
  "docs/spec/examples/api/keys.delegation_token_signing.get.response.json"
  "docs/spec/examples/api/auth.delegation_token.introspect.request.json"
  "docs/spec/examples/api/auth.delegation_token.introspect.response.json"

  "fixtures/keys/delegation_token_signing_dev_dt_k1_private.pem"
  "fixtures/keys/delegation_token_signing_dev_dt_k1_public.pem"
  "fixtures/keys/delegation_token_signing_dev_dt_k2_private.pem"
  "fixtures/keys/delegation_token_signing_dev_dt_k2_public.pem"

  "src/crypto/delegationTokenSigning.mjs"
  "src/service/delegationTokenAuthService.mjs"
  "src/service/delegationsService.mjs"

  "scripts/validate-schemas.mjs"
  "scripts/run-m36-delegation-key-rotation-introspection-scenario.mjs"

  "fixtures/delegation/m36_scenario.json"
  "fixtures/delegation/m36_expected.json"

  "verify/m36.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m36-delegation-key-rotation-introspection-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/delegation_rotation_introspection_output.json" "$LATEST_DIR/delegation_rotation_introspection_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
