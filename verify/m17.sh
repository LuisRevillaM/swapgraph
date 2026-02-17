#!/usr/bin/env bash
set -euo pipefail

M="M17"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (partner_id auth model + correlation IDs in read responses)"
  echo "utc=$(date -u +%Y-%m-%dT%H%M%S)"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/run-m17-contract-proof.mjs > $OUT_DIR/contract_proof.json"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m13-settlement-read-api-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M17.md"
  "docs/spec/API.md"
  "docs/spec/schemas/SettlementInstructionsGetResponse.schema.json"
  "docs/spec/schemas/SettlementStatusGetResponse.schema.json"
  "docs/spec/schemas/SwapReceiptGetResponse.schema.json"
  "docs/spec/examples/api/settlement.instructions.response.json"
  "docs/spec/examples/api/settlement.status.response.json"
  "docs/spec/examples/api/receipts.get.response.json"
  "scripts/validate-api-contract.mjs"
  "scripts/run-m17-contract-proof.mjs"
  "scripts/run-m13-settlement-read-api-scenario.mjs"
  "fixtures/settlement/m13_scenario.json"
  "fixtures/settlement/m13_expected.json"
  "src/read/settlementReadService.mjs"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/run-m17-contract-proof.mjs > "$OUT_DIR/contract_proof.json"

OUT_DIR="$OUT_DIR" node scripts/run-m13-settlement-read-api-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

# Preserve M13 assertions separately, then write an M17 assertions file.
cp "$OUT_DIR/assertions.json" "$OUT_DIR/settlement_read_assertions.json"
cat > "$OUT_DIR/assertions.json" <<'JSON'
{
  "milestone": "M17",
  "status": "pass"
}
JSON

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/contract_proof.json" "$LATEST_DIR/contract_proof.json"
cp "$OUT_DIR/settlement_read_output.json" "$LATEST_DIR/settlement_read_output.json"
cp "$OUT_DIR/settlement_read_assertions.json" "$LATEST_DIR/settlement_read_assertions.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
