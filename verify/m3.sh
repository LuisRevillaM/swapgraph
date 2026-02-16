#!/usr/bin/env bash
set -euo pipefail

M="M3"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (events contract + replay proof)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-events.mjs"
  echo "$ node scripts/replay-events.mjs"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M3.md"
  "docs/spec/events/manifest.v1.json"
  "scripts/validate-events.mjs"
  "scripts/replay-events.mjs"
  "fixtures/events/event_log.v1.ndjson"
  "fixtures/events/replay_expected.json"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-events.mjs > "$OUT_DIR/events_validation.json"
node scripts/replay-events.mjs > "$OUT_DIR/replay_output.json"

# Compare replay output with expected snapshot
OUT="$OUT_DIR/replay_output.json" EXP="fixtures/events/replay_expected.json" node - <<'NODE'
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const gotPath = process.env.OUT;
const expPath = process.env.EXP;
if (!gotPath || !expPath) throw new Error('missing OUT/EXP env');
const got = JSON.parse(readFileSync(gotPath, 'utf8'));
const exp = JSON.parse(readFileSync(expPath, 'utf8'));
assert.deepEqual(got, exp);
console.log('replay_matches_expected=true');
NODE

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/events_validation.json" "$LATEST_DIR/events_validation.json"
cp "$OUT_DIR/replay_output.json" "$LATEST_DIR/replay_output.json"

echo "verify ${M} pass"
