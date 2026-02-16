#!/usr/bin/env bash
set -euo pipefail

M="M1"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (platform contract: schemas + examples)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs"
} > "$OUT_DIR/commands.log"

# Required docs
req=(
  "docs/prd/M1.md"
  "docs/spec/PRIMITIVES.md"
  "docs/spec/IDEMPOTENCY.md"
  "docs/spec/EVENTS.md"
  "docs/spec/ERRORS.md"
)
for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schema_validation.json"

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schema_validation.json" "$LATEST_DIR/schema_validation.json"

echo "verify ${M} pass"
