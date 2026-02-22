#!/usr/bin/env bash
set -euo pipefail

M="M112"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (storage hardening and sqlite migration path)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m112-storage-hardening-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M112.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"
  "docs/spec/CONFORMANCE.md"

  "src/server/runtimeApiServer.mjs"
  "src/store/createStateStore.mjs"
  "src/store/jsonStateStore.mjs"
  "src/store/sqliteStateStore.mjs"
  "src/store/stateStoreMigration.mjs"
  "scripts/run-api-server.mjs"
  "scripts/migrate-state-store.mjs"
  "scripts/migrate-json-state-to-sqlite.mjs"
  "scripts/run-m112-storage-hardening-scenario.mjs"
  "fixtures/release/m112_scenario.json"
  "fixtures/release/m112_expected.json"
  "milestones/M112.yaml"
  "verify/m112.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m112-storage-hardening-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/storage_hardening_output.json" "$LATEST_DIR/storage_hardening_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"
cp "$OUT_DIR/runtime-api-state.json" "$LATEST_DIR/runtime-api-state.json"
cp "$OUT_DIR/runtime-api-state.sqlite" "$LATEST_DIR/runtime-api-state.sqlite"
cp "$OUT_DIR/runtime-api-state.backup.json" "$LATEST_DIR/runtime-api-state.backup.json"
cp "$OUT_DIR/runtime-api-state-restored.sqlite" "$LATEST_DIR/runtime-api-state-restored.sqlite"

echo "verify ${M} pass"
