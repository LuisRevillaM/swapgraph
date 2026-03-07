#!/usr/bin/env bash
set -euo pipefail
M="M145"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"
node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-api-auth.mjs > "$OUT_DIR/api_auth_validation.json"
AUTHZ_ENFORCE=1 OUT_DIR="$OUT_DIR" node scripts/run-m145-market-agent-cli-smoke-scenario.mjs > "$OUT_DIR/commands.log" 2>&1
cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/api_auth_validation.json" "$LATEST_DIR/api_auth_validation.json"
cp "$OUT_DIR/market_agent_cli_smoke_output.json" "$LATEST_DIR/market_agent_cli_smoke_output.json"
cp "$OUT_DIR/server.log" "$LATEST_DIR/server.log"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"
echo "verify ${M} pass"
