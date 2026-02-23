#!/usr/bin/env bash
set -euo pipefail

M="M16"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (partner scoping / tenancy)"
  echo "utc=$(date -u +%Y-%m-%dT%H%M%S)"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m16-tenancy-scenario.mjs"
  echo "$ AUTHZ_ENFORCE=1 OUT_DIR=$OUT_DIR node scripts/run-m16-runtime-auth-scenario.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M16.md"
  "fixtures/settlement/m16_scenario.json"
  "fixtures/settlement/m16_expected.json"
  "fixtures/settlement/m16_runtime_scenario.json"
  "fixtures/settlement/m16_runtime_expected.json"
  "scripts/run-m16-tenancy-scenario.mjs"
  "scripts/run-m16-runtime-auth-scenario.mjs"
  "src/read/settlementReadService.mjs"
  "src/settlement/settlementService.mjs"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m16-tenancy-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1
AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m16-runtime-auth-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/tenancy_output.json" "$LATEST_DIR/tenancy_output.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"
cp "$OUT_DIR/runtime_auth_output.json" "$LATEST_DIR/runtime_auth_output.json"
cp "$OUT_DIR/runtime_auth_assertions.json" "$LATEST_DIR/runtime_auth_assertions.json"

echo "verify ${M} pass"
