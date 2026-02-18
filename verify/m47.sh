#!/usr/bin/env bash
set -euo pipefail

M="M47"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (vault lifecycle scaffold)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m47-vault-lifecycle-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M47.md"
  "docs/STATUS.md"
  "docs/spec/PRIMITIVES.md"
  "docs/spec/GAPS.md"

  "docs/spec/schemas/VaultHolding.schema.json"
  "docs/spec/schemas/VaultEvent.schema.json"
  "docs/spec/examples/VaultHolding.example.json"
  "docs/spec/examples/VaultEvent.example.json"

  "src/vault/vaultLifecycleService.mjs"

  "scripts/run-m47-vault-lifecycle-scenario.mjs"
  "fixtures/vault/m47_scenario.json"
  "fixtures/vault/m47_expected.json"

  "verify/m47.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

OUT_DIR="$OUT_DIR" node scripts/run-m47-vault-lifecycle-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/vault_lifecycle_output.json" "$LATEST_DIR/vault_lifecycle_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
