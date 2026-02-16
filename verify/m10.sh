#!/usr/bin/env bash
set -euo pipefail

M="M10"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (settlement+receipts contract)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs"
  echo "$ node scripts/validate-api-contract.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M10.md"
  "docs/spec/schemas/SettlementTimeline.schema.json"
  "docs/spec/examples/SettlementTimeline.example.json"
  "docs/spec/API.md"
  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "scripts/validate-schemas.mjs"
  "scripts/validate-api-contract.mjs"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schema_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"

printf '{"milestone":"%s","status":"pass"}\n' "$M" > "$OUT_DIR/assertions.json"

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schema_validation.json" "$LATEST_DIR/schema_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
