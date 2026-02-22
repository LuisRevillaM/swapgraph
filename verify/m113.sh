#!/usr/bin/env bash
set -euo pipefail

M="M113"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (render deployment smoke hardening, integration-gated)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 INTEGRATION_ENABLED=1 OUT_DIR=$OUT_DIR node scripts/run-m113-render-smoke-hardening-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M113.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"

  "scripts/run-m113-render-smoke-hardening-scenario.mjs"
  "fixtures/integration/m113_scenario.json"
  "fixtures/integration/m113_expected.json"
  "milestones/M113.yaml"
  "verify/m113.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

if [[ "${INTEGRATION_ENABLED:-0}" != "1" ]]; then
  cat > "$OUT_DIR/integration_gate_failure.json" <<EOF
{
  "ok": false,
  "reason": "integration_gate_disabled",
  "required_env": "INTEGRATION_ENABLED=1"
}
EOF
  cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
  cp "$OUT_DIR/integration_gate_failure.json" "$LATEST_DIR/integration_gate_failure.json"
  echo "integration_gate_failed=INTEGRATION_ENABLED must be 1" >> "$OUT_DIR/commands.log"
  exit 3
fi

if [[ -z "${RENDER_API_KEY:-}" ]]; then
  cat > "$OUT_DIR/integration_gate_failure.json" <<EOF
{
  "ok": false,
  "reason": "missing_render_api_key",
  "required_env": "RENDER_API_KEY"
}
EOF
  cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
  cp "$OUT_DIR/integration_gate_failure.json" "$LATEST_DIR/integration_gate_failure.json"
  echo "integration_gate_failed=RENDER_API_KEY must be set" >> "$OUT_DIR/commands.log"
  exit 3
fi

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 INTEGRATION_ENABLED=1 OUT_DIR="$OUT_DIR" node scripts/run-m113-render-smoke-hardening-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/render_smoke_hardening_output.json" "$LATEST_DIR/render_smoke_hardening_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"
rm -f "$LATEST_DIR/integration_gate_failure.json"

echo "verify ${M} pass"
