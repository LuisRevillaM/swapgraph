#!/usr/bin/env bash
set -euo pipefail

M="M2"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (API surface contract + fixtures)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-api-contract.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M2.md"
  "docs/spec/API.md"
  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "scripts/validate-api-contract.mjs"
)
for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"

echo "verify ${M} pass"
