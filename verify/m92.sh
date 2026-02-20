#!/usr/bin/env bash
set -euo pipefail

M="M92"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (full-plan conformance and release-readiness gate)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-api-auth.mjs > $OUT_DIR/api_auth_validation.json"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m92-release-readiness-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M92.md"
  "docs/STATUS.md"
  "docs/spec/GAPS.md"
  "docs/spec/CONFORMANCE.md"
  "BLOCKERS.md"

  "scripts/run-m92-release-readiness-scenario.mjs"
  "fixtures/release/m92_scenario.json"
  "fixtures/release/m92_expected.json"

  "milestones/M92.yaml"
  "verify/m92.sh"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

for n in $(seq 71 92); do
  for f in "docs/prd/M${n}.md" "milestones/M${n}.yaml" "verify/m${n}.sh"; do
    test -f "$f" || { echo "missing_milestone_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
    echo "found_milestone_file=$f" >> "$OUT_DIR/commands.log"
  done
done

for n in $(seq 71 91); do
  f="artifacts/milestones/M${n}/latest/commands.log"
  test -f "$f" || { echo "missing_milestone_evidence=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_milestone_evidence=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m92-release-readiness-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/release_readiness_conformance_output.json" "$LATEST_DIR/release_readiness_conformance_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
