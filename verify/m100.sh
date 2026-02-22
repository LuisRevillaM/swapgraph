#!/usr/bin/env bash
set -euo pipefail

M="M100"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (metrics and network health contracts)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m100-metrics-network-health-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M100.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"
  "docs/spec/CONFORMANCE.md"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/metrics.north_star.get.response.json"
  "docs/spec/examples/api/metrics.marketplace_funnel.get.response.json"
  "docs/spec/examples/api/metrics.partner_health.get.response.json"
  "docs/spec/examples/api/metrics.safety_health.get.response.json"
  "docs/spec/examples/api/metrics.network_health.export.response.json"

  "docs/spec/schemas/MetricsNorthStarGetResponse.schema.json"
  "docs/spec/schemas/MetricsMarketplaceFunnelGetResponse.schema.json"
  "docs/spec/schemas/MetricsPartnerHealthGetResponse.schema.json"
  "docs/spec/schemas/MetricsSafetyHealthGetResponse.schema.json"
  "docs/spec/schemas/MetricsNetworkHealthExportResponse.schema.json"

  "src/service/metricsNetworkHealthService.mjs"
  "src/server/runtimeApiServer.mjs"
  "src/store/jsonStateStore.mjs"
  "scripts/run-m100-metrics-network-health-scenario.mjs"
  "fixtures/release/m100_scenario.json"
  "fixtures/release/m100_expected.json"
  "milestones/M100.yaml"
  "verify/m100.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m100-metrics-network-health-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/metrics_network_health_output.json" "$LATEST_DIR/metrics_network_health_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
