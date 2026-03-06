#!/usr/bin/env bash
set -euo pipefail

M="M140"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (market listings/edges/feed contracts)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m140-market-listing-edge-feed-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M140.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/AUTH.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"
  "docs/spec/CONFORMANCE.md"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"

  "docs/spec/schemas/MarketActionRequest.schema.json"
  "docs/spec/schemas/MarketListingView.schema.json"
  "docs/spec/schemas/MarketListingCreateRequest.schema.json"
  "docs/spec/schemas/MarketListingPatchRequest.schema.json"
  "docs/spec/schemas/MarketListingResponse.schema.json"
  "docs/spec/schemas/MarketListingListResponse.schema.json"
  "docs/spec/schemas/MarketEdgeRef.schema.json"
  "docs/spec/schemas/MarketEdgeView.schema.json"
  "docs/spec/schemas/MarketEdgeCreateRequest.schema.json"
  "docs/spec/schemas/MarketEdgeResponse.schema.json"
  "docs/spec/schemas/MarketEdgeListResponse.schema.json"
  "docs/spec/schemas/MarketFeedItem.schema.json"
  "docs/spec/schemas/MarketFeedGetResponse.schema.json"

  "docs/spec/examples/api/market.listings.create.request.json"
  "docs/spec/examples/api/market.listings.create.response.json"
  "docs/spec/examples/api/market.listings.patch.request.json"
  "docs/spec/examples/api/market.listings.patch.response.json"
  "docs/spec/examples/api/market.listings.pause.request.json"
  "docs/spec/examples/api/market.listings.pause.response.json"
  "docs/spec/examples/api/market.listings.close.request.json"
  "docs/spec/examples/api/market.listings.close.response.json"
  "docs/spec/examples/api/market.listings.get.response.json"
  "docs/spec/examples/api/market.listings.list.response.json"
  "docs/spec/examples/api/market.edges.create.request.json"
  "docs/spec/examples/api/market.edges.create.response.json"
  "docs/spec/examples/api/market.edges.accept.request.json"
  "docs/spec/examples/api/market.edges.accept.response.json"
  "docs/spec/examples/api/market.edges.decline.request.json"
  "docs/spec/examples/api/market.edges.decline.response.json"
  "docs/spec/examples/api/market.edges.withdraw.request.json"
  "docs/spec/examples/api/market.edges.withdraw.response.json"
  "docs/spec/examples/api/market.edges.get.response.json"
  "docs/spec/examples/api/market.edges.list.response.json"
  "docs/spec/examples/api/market.feed.get.response.json"

  "src/service/marketService.mjs"
  "src/server/runtimeApiServer.mjs"
  "src/store/jsonStateStore.mjs"
  "scripts/validate-api-auth.mjs"

  "scripts/run-m140-market-listing-edge-feed-scenario.mjs"
  "fixtures/release/m140_scenario.json"
  "fixtures/release/m140_expected.json"
  "milestones/M140.yaml"
  "verify/m140.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"
AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m140-market-listing-edge-feed-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/market_listing_edge_feed_output.json" "$LATEST_DIR/market_listing_edge_feed_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
