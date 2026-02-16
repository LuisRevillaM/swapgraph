#!/usr/bin/env bash
set -euo pipefail

M="M0"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (repo bootstrap)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$OUT_DIR/commands.log"

# Required files
req_files=(
  "PLAN.md"
  "README.md"
  "docs/STATUS.md"
  "docs/source/SwapGraph_System_Plan_v1.3_Feb2026.md"
  "docs/prd/M0.md"
  "docs/spec/GAPS.md"
  "package.json"
  "milestones/M0.yaml"
  "verify/runner.ts"
  "verify/m0.sh"
  "ops/runner-state.json"
  "ops/RUNNER.md"
  "ops/SUPERVISOR.md"
)

for f in "${req_files[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "missing_file=$f" >> "$OUT_DIR/commands.log"
    echo "Missing required file: $f" >&2
    exit 2
  fi
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

grep -q '^AUTOPILOT_APPROVED:' PLAN.md

tmp_json="$OUT_DIR/assertions.json"
cat > "$tmp_json" <<JSON
{
  "milestone": "${M}",
  "status": "pass",
  "utc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "mvp_trade_hold_policy": "exclude_by_default_per_plan_v1_3"
}
JSON

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$tmp_json" "$LATEST_DIR/assertions.json"

echo "verify ${M} pass"
