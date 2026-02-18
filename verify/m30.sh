#!/usr/bin/env bash
set -euo pipefail

M="M30"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (auth scopes contract + webhook ingestion hardening)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ node scripts/validate-events.mjs > $OUT_DIR/events_manifest_validation.json"
  echo "$ OUT_DIR=$OUT_DIR node scripts/run-m30-webhook-hardening-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M30.md"
  "docs/spec/AUTH.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/events/manifest.v1.json"
  "docs/spec/examples/api/keys.event_signing.get.response.json"

  "fixtures/delivery/m6_expected.json"
  "fixtures/delivery/m30_scenario.json"
  "fixtures/delivery/m30_expected.json"

  "scripts/validate-schemas.mjs"
  "scripts/validate-api-contract.mjs"
  "scripts/validate-api-auth.mjs"
  "scripts/validate-events.mjs"
  "scripts/run-m30-webhook-hardening-scenario.mjs"

  "src/crypto/eventSigning.mjs"
  "src/delivery/proposalIngestService.mjs"
  "src/store/jsonStateStore.mjs"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"
node scripts/validate-events.mjs > "$OUT_DIR/events_manifest_validation.json"

OUT_DIR="$OUT_DIR" node scripts/run-m30-webhook-hardening-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

# ---- copy stable artifacts to latest ----
cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/events_manifest_validation.json" "$LATEST_DIR/events_manifest_validation.json"
cp "$OUT_DIR/webhook_hardening_output.json" "$LATEST_DIR/webhook_hardening_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
