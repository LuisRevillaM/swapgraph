#!/usr/bin/env bash
set -euo pipefail

M="M31"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (scope enforcement in services + proofs)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m31-authz-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M31.md"
  "docs/spec/AUTH.md"
  "docs/spec/api/manifest.v1.json"

  "fixtures/authz/m31_scenario.json"
  "fixtures/authz/m31_expected.json"

  "scripts/run-m31-authz-scenario.mjs"
  "scripts/validate-api-auth.mjs"

  "src/core/authz.mjs"
  "src/service/swapIntentsService.mjs"
  "src/read/cycleProposalsReadService.mjs"
  "src/commit/commitService.mjs"
  "src/service/settlementWriteApiService.mjs"
  "src/read/settlementReadService.mjs"

  "verify/m31.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m31-authz-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

# ---- copy stable artifacts to latest ----
cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/authz_output.json" "$LATEST_DIR/authz_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
