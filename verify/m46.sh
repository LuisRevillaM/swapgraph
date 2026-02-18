#!/usr/bin/env bash
set -euo pipefail

M="M46"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (proof-of-custody primitives)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m46-proof-of-custody-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M46.md"
  "docs/spec/PRIMITIVES.md"
  "docs/spec/GAPS.md"

  "docs/spec/schemas/CustodyHolding.schema.json"
  "docs/spec/schemas/CustodySnapshot.schema.json"
  "docs/spec/schemas/CustodyInclusionProof.schema.json"

  "docs/spec/examples/CustodyHolding.example.json"
  "docs/spec/examples/CustodySnapshot.example.json"
  "docs/spec/examples/CustodyInclusionProof.example.json"

  "src/custody/proofOfCustody.mjs"

  "scripts/run-m46-proof-of-custody-scenario.mjs"
  "fixtures/custody/m46_scenario.json"
  "fixtures/custody/m46_expected.json"

  "verify/m46.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

OUT_DIR="$OUT_DIR" node scripts/run-m46-proof-of-custody-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/proof_of_custody_output.json" "$LATEST_DIR/proof_of_custody_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
