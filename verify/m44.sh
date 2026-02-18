#!/usr/bin/env bash
set -euo pipefail

M="M44"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (stateful checkpoint continuity)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 POLICY_AUDIT_EXPORT_CHECKPOINT_ENFORCE=1 POLICY_AUDIT_RETENTION_DAYS=30 OUT_DIR=$OUT_DIR node scripts/run-m44-export-checkpoint-continuity-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M44.md"
  "docs/spec/API.md"
  "docs/spec/AUTH.md"
  "docs/spec/GAPS.md"

  "src/read/policyAuditReadService.mjs"
  "src/store/jsonStateStore.mjs"

  "scripts/run-m44-export-checkpoint-continuity-scenario.mjs"
  "fixtures/delegation/m44_scenario.json"
  "fixtures/delegation/m44_expected.json"

  "verify/m44.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 POLICY_AUDIT_EXPORT_CHECKPOINT_ENFORCE=1 POLICY_AUDIT_RETENTION_DAYS=30 OUT_DIR="$OUT_DIR" node scripts/run-m44-export-checkpoint-continuity-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/export_checkpoint_continuity_output.json" "$LATEST_DIR/export_checkpoint_continuity_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
