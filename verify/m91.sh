#!/usr/bin/env bash
set -euo pipefail

M="M91"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (reliability/slo conformance pack)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m91-reliability-conformance-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M91.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"

  "src/store/jsonStateStore.mjs"
  "src/service/reliabilityConformanceService.mjs"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/reliability.slo.record.request.json"
  "docs/spec/examples/api/reliability.slo.record.response.json"
  "docs/spec/examples/api/reliability.incident_drill.record.request.json"
  "docs/spec/examples/api/reliability.incident_drill.record.response.json"
  "docs/spec/examples/api/reliability.replay_check.record.request.json"
  "docs/spec/examples/api/reliability.replay_check.record.response.json"
  "docs/spec/examples/api/reliability.conformance.export.response.json"

  "docs/spec/schemas/ReliabilitySloMetricRecordRequest.schema.json"
  "docs/spec/schemas/ReliabilitySloMetricRecordResponse.schema.json"
  "docs/spec/schemas/ReliabilityIncidentDrillRecordRequest.schema.json"
  "docs/spec/schemas/ReliabilityIncidentDrillRecordResponse.schema.json"
  "docs/spec/schemas/ReliabilityReplayCheckRecordRequest.schema.json"
  "docs/spec/schemas/ReliabilityReplayCheckRecordResponse.schema.json"
  "docs/spec/schemas/ReliabilityConformanceExportResponse.schema.json"

  "scripts/run-m91-reliability-conformance-scenario.mjs"
  "fixtures/reliability/m91_scenario.json"
  "fixtures/reliability/m91_expected.json"

  "milestones/M91.yaml"
  "verify/m91.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m91-reliability-conformance-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/reliability_conformance_output.json" "$LATEST_DIR/reliability_conformance_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
