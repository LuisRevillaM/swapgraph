#!/usr/bin/env bash
set -euo pipefail

M="M114"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (explicit edge-intent + hybrid graph matching contracts)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m114-edge-intents-hybrid-matching-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M114.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"
  "docs/spec/CONFORMANCE.md"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/edge_intents.upsert.request.json"
  "docs/spec/examples/api/edge_intents.upsert.response.json"
  "docs/spec/examples/api/edge_intents.list.response.json"
  "docs/spec/examples/api/edge_intents.get.response.json"

  "docs/spec/schemas/EdgeIntentUpsertRequest.schema.json"
  "docs/spec/schemas/EdgeIntentView.schema.json"
  "docs/spec/schemas/EdgeIntentUpsertResponse.schema.json"
  "docs/spec/schemas/EdgeIntentListResponse.schema.json"
  "docs/spec/schemas/EdgeIntentGetResponse.schema.json"

  "src/service/edgeIntentService.mjs"
  "src/service/marketplaceMatchingService.mjs"
  "src/matching/graph.mjs"
  "src/matching/engine.mjs"
  "src/matching/proposals.mjs"
  "src/server/runtimeApiServer.mjs"
  "src/store/jsonStateStore.mjs"

  "scripts/run-m114-edge-intents-hybrid-matching-scenario.mjs"
  "fixtures/release/m114_scenario.json"
  "fixtures/release/m114_expected.json"
  "milestones/M114.yaml"
  "verify/m114.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m114-edge-intents-hybrid-matching-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/edge_intents_hybrid_matching_output.json" "$LATEST_DIR/edge_intents_hybrid_matching_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
