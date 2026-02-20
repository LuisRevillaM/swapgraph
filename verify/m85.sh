#!/usr/bin/env bash
set -euo pipefail

M="M85"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (steam deposit-per-swap live proof, integration-gated)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 INTEGRATION_ENABLED=1 OUT_DIR=$OUT_DIR node scripts/run-m85-steam-deposit-per-swap-live-proof-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M85.md"
  "docs/STATUS.md"
  "docs/spec/API.md"
  "docs/spec/ERRORS.md"
  "docs/spec/GAPS.md"

  "src/store/jsonStateStore.mjs"
  "src/service/steamAdapterContractService.mjs"
  "src/service/steamAdapterLiveProofService.mjs"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/adapter.steam_tier1.live_proof.deposit_per_swap.record.request.json"
  "docs/spec/examples/api/adapter.steam_tier1.live_proof.deposit_per_swap.record.response.json"

  "docs/spec/schemas/SteamTier1DepositPerSwapLiveProofRecordRequest.schema.json"
  "docs/spec/schemas/SteamTier1DepositPerSwapLiveProofRecordResponse.schema.json"

  "scripts/run-m85-steam-deposit-per-swap-live-proof-scenario.mjs"
  "fixtures/integration/m85_scenario.json"
  "fixtures/integration/m85_expected.json"
  "ops/M85_LIVE_PROOF_RUNBOOK.md"

  "milestones/M85.yaml"
  "verify/m85.sh"
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

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 INTEGRATION_ENABLED=1 OUT_DIR="$OUT_DIR" node scripts/run-m85-steam-deposit-per-swap-live-proof-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/steam_deposit_per_swap_live_proof_output.json" "$LATEST_DIR/steam_deposit_per_swap_live_proof_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
