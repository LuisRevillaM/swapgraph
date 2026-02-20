#!/usr/bin/env bash
set -euo pipefail

M="M89"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (tier2 adapter capability contract, cross-ecosystem preflight)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m89-tier2-adapter-capability-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M89.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"

  "src/store/jsonStateStore.mjs"
  "src/service/tier2AdapterCapabilityService.mjs"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/adapter.tier2.capability.upsert.request.json"
  "docs/spec/examples/api/adapter.tier2.capability.upsert.response.json"
  "docs/spec/examples/api/adapter.tier2.capability.get.response.json"
  "docs/spec/examples/api/adapter.tier2.preflight.request.json"
  "docs/spec/examples/api/adapter.tier2.preflight.response.json"

  "docs/spec/schemas/Tier2AdapterCapabilityUpsertRequest.schema.json"
  "docs/spec/schemas/Tier2AdapterCapabilityUpsertResponse.schema.json"
  "docs/spec/schemas/Tier2AdapterCapabilityGetResponse.schema.json"
  "docs/spec/schemas/Tier2AdapterPreflightRequest.schema.json"
  "docs/spec/schemas/Tier2AdapterPreflightResponse.schema.json"

  "scripts/run-m89-tier2-adapter-capability-scenario.mjs"
  "fixtures/adapters/m89_scenario.json"
  "fixtures/adapters/m89_expected.json"

  "milestones/M89.yaml"
  "verify/m89.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m89-tier2-adapter-capability-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/tier2_adapter_capability_output.json" "$LATEST_DIR/tier2_adapter_capability_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
