#!/usr/bin/env bash
set -euo pipefail

STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/drills"
VERIFY_DIR="${OUT_DIR}/verify-${STAMP}"
LATEST_VERIFY_DIR="${OUT_DIR}/latest-verify-render-drill"
mkdir -p "$OUT_DIR" "$VERIFY_DIR" "$LATEST_VERIFY_DIR"

{
  echo "# verify render live intent-cycle drill"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ INTEGRATION_ENABLED=1 DRILL_OUT_DIR=$OUT_DIR DRILL_RUNS=${DRILL_RUNS:-2} node scripts/run-render-intent-cycle-drill.mjs"
} > "$VERIFY_DIR/commands.log"

req=(
  "scripts/run-render-intent-cycle-drill.mjs"
  "verify/render-drill.sh"
  "package.json"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$VERIFY_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$VERIFY_DIR/commands.log"
done

# Optional local credential bootstrap for non-interactive shells.
RENDER_ENV_FILE="${RENDER_ENV_FILE:-$HOME/.swapgraph-render.env}"
if [[ -f "$RENDER_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$RENDER_ENV_FILE"
  set +a
  echo "sourced_render_env_file=$RENDER_ENV_FILE" >> "$VERIFY_DIR/commands.log"
else
  echo "sourced_render_env_file=none" >> "$VERIFY_DIR/commands.log"
fi

if [[ "${INTEGRATION_ENABLED:-0}" != "1" ]]; then
  cat > "$VERIFY_DIR/integration_gate_failure.json" <<EOF
{
  "ok": false,
  "reason": "integration_gate_disabled",
  "required_env": "INTEGRATION_ENABLED=1"
}
EOF
  cp "$VERIFY_DIR/commands.log" "$LATEST_VERIFY_DIR/commands.log"
  cp "$VERIFY_DIR/integration_gate_failure.json" "$LATEST_VERIFY_DIR/integration_gate_failure.json"
  echo "integration_gate_failed=INTEGRATION_ENABLED must be 1" >> "$VERIFY_DIR/commands.log"
  exit 3
fi

RUNTIME_SERVICE_URL="${RUNTIME_SERVICE_URL:-${RENDER_SERVICE_URL:-https://swapgraph-runtime-api.onrender.com}}"
DRILL_RUNS="${DRILL_RUNS:-2}"
DRILL_OUT_DIR="${DRILL_OUT_DIR:-$OUT_DIR}"

RUNTIME_SERVICE_URL="$RUNTIME_SERVICE_URL" \
  DRILL_RUNS="$DRILL_RUNS" \
  DRILL_OUT_DIR="$DRILL_OUT_DIR" \
  node scripts/run-render-intent-cycle-drill.mjs >> "$VERIFY_DIR/commands.log" 2>&1

DRILL_OUT_DIR="$DRILL_OUT_DIR" EXPECTED_RUNS="$DRILL_RUNS" node --input-type=module <<'NODE' > "$VERIFY_DIR/assertions.json"
import { readFileSync } from 'node:fs';
import path from 'node:path';

const outDir = process.env.DRILL_OUT_DIR ?? 'artifacts/drills';
const expectedRuns = Number.parseInt(process.env.EXPECTED_RUNS ?? '2', 10);
const summaryPath = path.join(outDir, 'latest-render-intent-cycle-drill-summary.json');
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
const results = Array.isArray(summary?.results) ? summary.results : [];

const ok = Boolean(
  summary?.ok === true
  && Number(summary?.runs_requested) === expectedRuns
  && Number(summary?.runs_completed) === expectedRuns
  && Number(summary?.failure_count) === 0
  && results.length === expectedRuns
  && results.every(result =>
    result?.ok === true
    && result?.cleanup_ok === true
    && typeof result?.run_id === 'string'
    && result.run_id.length > 0
    && typeof result?.matched_proposal_id === 'string'
    && result.matched_proposal_id.length > 0
  )
);

const assertions = {
  ok,
  expected_runs: expectedRuns,
  summary_file: summaryPath,
  runs_completed: Number(summary?.runs_completed ?? 0),
  failure_count: Number(summary?.failure_count ?? 0),
  run_ids: results.map(result => result?.run_id).filter(Boolean)
};

process.stdout.write(JSON.stringify(assertions, null, 2));
if (!ok) process.exit(1);
NODE

cp "$VERIFY_DIR/commands.log" "$LATEST_VERIFY_DIR/commands.log"
cp "$VERIFY_DIR/assertions.json" "$LATEST_VERIFY_DIR/assertions.json"
rm -f "$LATEST_VERIFY_DIR/integration_gate_failure.json"

echo "verify render drill pass"
