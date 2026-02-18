#!/usr/bin/env bash
set -euo pipefail

M="M43"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (consent challenge context + export checkpoint compaction)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 POLICY_CONSENT_TIER_ENFORCE=1 POLICY_CONSENT_PROOF_BIND_ENFORCE=1 POLICY_CONSENT_PROOF_SIG_ENFORCE=1 POLICY_CONSENT_PROOF_REPLAY_ENFORCE=1 POLICY_CONSENT_PROOF_CHALLENGE_ENFORCE=1 POLICY_AUDIT_EXPORT_CHECKPOINT_ENFORCE=1 POLICY_AUDIT_RETENTION_DAYS=30 OUT_DIR=$OUT_DIR node scripts/run-m43-consent-challenge-checkpoint-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M43.md"
  "docs/spec/API.md"
  "docs/spec/AUTH.md"
  "docs/spec/KEYS.md"
  "docs/spec/GAPS.md"

  "docs/spec/schemas/PolicyAuditExportResponse.schema.json"
  "docs/spec/examples/api/policy_audit.delegated_writes.export.response.json"

  "src/core/tradingPolicyBoundaries.mjs"
  "src/crypto/policyIntegritySigning.mjs"
  "src/read/policyAuditReadService.mjs"
  "src/service/swapIntentsService.mjs"
  "src/store/jsonStateStore.mjs"

  "scripts/run-m43-consent-challenge-checkpoint-scenario.mjs"
  "fixtures/delegation/m43_scenario.json"
  "fixtures/delegation/m43_expected.json"

  "verify/m43.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 POLICY_CONSENT_TIER_ENFORCE=1 POLICY_CONSENT_PROOF_BIND_ENFORCE=1 POLICY_CONSENT_PROOF_SIG_ENFORCE=1 POLICY_CONSENT_PROOF_REPLAY_ENFORCE=1 POLICY_CONSENT_PROOF_CHALLENGE_ENFORCE=1 POLICY_AUDIT_EXPORT_CHECKPOINT_ENFORCE=1 POLICY_AUDIT_RETENTION_DAYS=30 OUT_DIR="$OUT_DIR" node scripts/run-m43-consent-challenge-checkpoint-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/consent_challenge_checkpoint_output.json" "$LATEST_DIR/consent_challenge_checkpoint_output.json"
cp "$OUT_DIR/store.json" "$LATEST_DIR/store.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
