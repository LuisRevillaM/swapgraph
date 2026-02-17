#!/usr/bin/env bash
set -euo pipefail

M="M28"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (verifiable receipt signatures + key publication contract)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ OUT_DIR=$OUT_DIR/m9 node scripts/run-m9-settlement-scenario.mjs"
  echo "$ OUT_DIR=$OUT_DIR/m13 node scripts/run-m13-settlement-read-api-scenario.mjs"
  echo "$ node scripts/verify-receipt-signatures.mjs --keys-example docs/spec/examples/api/keys.receipt_signing.get.response.json fixtures/events/event_log.v1.ndjson fixtures/events/event_log.v2.ndjson docs/spec/examples/SwapReceipt.example.json docs/spec/examples/api/settlement.complete.response.json docs/spec/examples/api/receipts.get.response.json docs/spec/examples/api/settlement.expire_deposit_window.response.json $OUT_DIR/m9/settlement_output.json $OUT_DIR/m13/settlement_read_output.json > $OUT_DIR/receipt_signature_verification.json"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M28.md"

  "docs/spec/API.md"
  "docs/spec/KEYS.md"

  "docs/spec/schemas/SwapReceipt.schema.json"
  "docs/spec/schemas/ReceiptSigningKey.schema.json"
  "docs/spec/schemas/ReceiptSigningKeysGetResponse.schema.json"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/keys.receipt_signing.get.response.json"

  "docs/spec/examples/SwapReceipt.example.json"
  "docs/spec/examples/api/settlement.complete.response.json"
  "docs/spec/examples/api/receipts.get.response.json"
  "docs/spec/examples/api/settlement.expire_deposit_window.response.json"

  "fixtures/keys/receipt_signing_dev_k1_public.pem"
  "fixtures/keys/receipt_signing_dev_k1_private.pem"

  "fixtures/events/event_log.v1.ndjson"
  "fixtures/events/event_log.v2.ndjson"

  "fixtures/settlement/m9_expected.json"
  "fixtures/settlement/m13_expected.json"

  "scripts/validate-schemas.mjs"
  "scripts/validate-api-contract.mjs"
  "scripts/verify-receipt-signatures.mjs"
  "scripts/run-m9-settlement-scenario.mjs"
  "scripts/run-m13-settlement-read-api-scenario.mjs"

  "src/crypto/receiptSigning.mjs"
  "src/settlement/settlementService.mjs"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"

mkdir -p "$OUT_DIR/m9" "$OUT_DIR/m13"

OUT_DIR="$OUT_DIR/m9" node scripts/run-m9-settlement-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1
OUT_DIR="$OUT_DIR/m13" node scripts/run-m13-settlement-read-api-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

node scripts/verify-receipt-signatures.mjs --keys-example docs/spec/examples/api/keys.receipt_signing.get.response.json \
  fixtures/events/event_log.v1.ndjson \
  fixtures/events/event_log.v2.ndjson \
  docs/spec/examples/SwapReceipt.example.json \
  docs/spec/examples/api/settlement.complete.response.json \
  docs/spec/examples/api/receipts.get.response.json \
  docs/spec/examples/api/settlement.expire_deposit_window.response.json \
  "$OUT_DIR/m9/settlement_output.json" \
  "$OUT_DIR/m13/settlement_read_output.json" \
  > "$OUT_DIR/receipt_signature_verification.json"

cat > "$OUT_DIR/assertions.json" <<'JSON'
{
  "milestone": "M28",
  "status": "pass"
}
JSON

# ---- copy stable artifacts to latest ----
mkdir -p "$LATEST_DIR/m9" "$LATEST_DIR/m13"

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/receipt_signature_verification.json" "$LATEST_DIR/receipt_signature_verification.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

cp "$OUT_DIR/m9/settlement_output.json" "$LATEST_DIR/m9/settlement_output.json"
cp "$OUT_DIR/m9/events_outbox.ndjson" "$LATEST_DIR/m9/events_outbox.ndjson"
cp "$OUT_DIR/m9/events_validation.json" "$LATEST_DIR/m9/events_validation.json"
cp "$OUT_DIR/m9/assertions.json" "$LATEST_DIR/m9/assertions.json"

cp "$OUT_DIR/m13/settlement_read_output.json" "$LATEST_DIR/m13/settlement_read_output.json"
cp "$OUT_DIR/m13/assertions.json" "$LATEST_DIR/m13/assertions.json"

echo "verify ${M} pass"
