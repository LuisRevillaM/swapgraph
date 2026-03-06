#!/usr/bin/env bash
set -euo pipefail

M="M141"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (market threads/messages contracts)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m141-market-threads-messages-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M141.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/AUTH.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"
  "docs/spec/CONFORMANCE.md"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"

  "docs/spec/schemas/MarketThreadCreateRequest.schema.json"
  "docs/spec/schemas/MarketThreadView.schema.json"
  "docs/spec/schemas/MarketThreadResponse.schema.json"
  "docs/spec/schemas/MarketThreadListResponse.schema.json"
  "docs/spec/schemas/MarketThreadMessageCreateRequest.schema.json"
  "docs/spec/schemas/MarketThreadMessageView.schema.json"
  "docs/spec/schemas/MarketThreadMessageResponse.schema.json"
  "docs/spec/schemas/MarketThreadMessageListResponse.schema.json"

  "docs/spec/examples/api/market.threads.create.request.json"
  "docs/spec/examples/api/market.threads.create.response.json"
  "docs/spec/examples/api/market.threads.get.response.json"
  "docs/spec/examples/api/market.threads.list.response.json"
  "docs/spec/examples/api/market.threads.messages.create.request.json"
  "docs/spec/examples/api/market.threads.messages.create.response.json"
  "docs/spec/examples/api/market.threads.messages.list.response.json"

  "src/service/marketService.mjs"
  "src/server/runtimeApiServer.mjs"
  "src/store/jsonStateStore.mjs"

  "scripts/run-m141-market-threads-messages-scenario.mjs"
  "fixtures/release/m141_scenario.json"
  "fixtures/release/m141_expected.json"
  "milestones/M141.yaml"
  "verify/m141.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"
AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m141-market-threads-messages-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/market_threads_messages_output.json" "$LATEST_DIR/market_threads_messages_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
