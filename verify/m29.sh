#!/usr/bin/env bash
set -euo pipefail

M="M29"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="artifacts/milestones/${M}/${STAMP}"
LATEST_DIR="artifacts/milestones/${M}/latest"
mkdir -p "$OUT_DIR" "$LATEST_DIR"

{
  echo "# verify ${M} (webhook/event signing + replay protection)"
  echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$ node scripts/validate-schemas.mjs > $OUT_DIR/schemas_validation.json"
  echo "$ node scripts/validate-api-contract.mjs > $OUT_DIR/api_contract_validation.json"
  echo "$ node scripts/validate-events.mjs > $OUT_DIR/events_manifest_validation.json"
  echo "$ OUT_DIR=$OUT_DIR/m6 node scripts/run-m6-delivery-fixture.mjs"
  echo "$ OUT_DIR=$OUT_DIR/m7 node scripts/run-m7-commit-scenario.mjs"
  echo "$ OUT_DIR=$OUT_DIR/m9 node scripts/run-m9-settlement-scenario.mjs"
  echo "$ node scripts/replay-events.mjs > $OUT_DIR/replay_v1_output.json"
  echo "$ OUT_DIR=$OUT_DIR/replay_v2 node scripts/replay-events-v2.mjs"
  echo "$ node scripts/verify-event-signatures.mjs --keys-example docs/spec/examples/api/keys.event_signing.get.response.json fixtures/events/event_log.v1.ndjson fixtures/events/event_log.v2.ndjson docs/spec/examples/EventEnvelope.example.json fixtures/delivery/m6_expected.json $OUT_DIR/m6/webhook_events.ndjson $OUT_DIR/m7/events_outbox.ndjson $OUT_DIR/m9/events_outbox.ndjson > $OUT_DIR/event_signature_verification.json"
} > "$OUT_DIR/commands.log"

req=(
  "docs/prd/M29.md"

  "docs/spec/API.md"
  "docs/spec/EVENTS.md"
  "docs/spec/KEYS.md"

  "docs/spec/events/manifest.v1.json"

  "docs/spec/schemas/EventSignature.schema.json"
  "docs/spec/schemas/EventEnvelope.schema.json"
  "docs/spec/schemas/EventSigningKey.schema.json"
  "docs/spec/schemas/EventSigningKeysGetResponse.schema.json"

  "docs/spec/examples/EventSignature.example.json"
  "docs/spec/examples/EventEnvelope.example.json"

  "docs/spec/api/manifest.v1.json"
  "docs/spec/examples/api/_manifest.v1.json"
  "docs/spec/examples/api/keys.event_signing.get.response.json"

  "fixtures/keys/event_signing_dev_ev_k1_public.pem"
  "fixtures/keys/event_signing_dev_ev_k1_private.pem"

  "fixtures/events/event_log.v1.ndjson"
  "fixtures/events/event_log.v2.ndjson"
  "fixtures/events/replay_expected.json"
  "fixtures/events/replay_expected_v2.json"
  "fixtures/events/checkpoint.v1.json"

  "fixtures/delivery/m6_expected.json"

  "scripts/validate-schemas.mjs"
  "scripts/validate-api-contract.mjs"
  "scripts/validate-events.mjs"
  "scripts/verify-event-signatures.mjs"
  "scripts/run-m6-delivery-fixture.mjs"
  "scripts/run-m7-commit-scenario.mjs"
  "scripts/run-m9-settlement-scenario.mjs"
  "scripts/replay-events.mjs"
  "scripts/replay-events-v2.mjs"

  "src/crypto/eventSigning.mjs"
  "src/delivery/proposalDelivery.mjs"
  "src/commit/commitService.mjs"
  "src/settlement/settlementService.mjs"
)

for f in "${req[@]}"; do
  test -f "$f" || { echo "missing_file=$f" >> "$OUT_DIR/commands.log"; exit 2; }
  echo "found_file=$f" >> "$OUT_DIR/commands.log"
done

node scripts/validate-schemas.mjs > "$OUT_DIR/schemas_validation.json"
node scripts/validate-api-contract.mjs > "$OUT_DIR/api_contract_validation.json"
node scripts/validate-events.mjs > "$OUT_DIR/events_manifest_validation.json"

mkdir -p "$OUT_DIR/m6" "$OUT_DIR/m7" "$OUT_DIR/m9" "$OUT_DIR/replay_v2"

OUT_DIR="$OUT_DIR/m6" node scripts/run-m6-delivery-fixture.mjs >> "$OUT_DIR/commands.log" 2>&1
OUT_DIR="$OUT_DIR/m7" node scripts/run-m7-commit-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1
OUT_DIR="$OUT_DIR/m9" node scripts/run-m9-settlement-scenario.mjs >> "$OUT_DIR/commands.log" 2>&1

node scripts/replay-events.mjs > "$OUT_DIR/replay_v1_output.json"

# Compare replay v1 output with expected snapshot
OUT="$OUT_DIR/replay_v1_output.json" EXP="fixtures/events/replay_expected.json" node - <<'NODE'
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const gotPath = process.env.OUT;
const expPath = process.env.EXP;
if (!gotPath || !expPath) throw new Error('missing OUT/EXP env');
const got = JSON.parse(readFileSync(gotPath, 'utf8'));
const exp = JSON.parse(readFileSync(expPath, 'utf8'));
assert.deepEqual(got, exp);
console.log('replay_v1_matches_expected=true');
NODE

OUT_DIR="$OUT_DIR/replay_v2" node scripts/replay-events-v2.mjs >> "$OUT_DIR/commands.log" 2>&1

node scripts/verify-event-signatures.mjs --keys-example docs/spec/examples/api/keys.event_signing.get.response.json \
  fixtures/events/event_log.v1.ndjson \
  fixtures/events/event_log.v2.ndjson \
  docs/spec/examples/EventEnvelope.example.json \
  fixtures/delivery/m6_expected.json \
  "$OUT_DIR/m6/webhook_events.ndjson" \
  "$OUT_DIR/m7/events_outbox.ndjson" \
  "$OUT_DIR/m9/events_outbox.ndjson" \
  > "$OUT_DIR/event_signature_verification.json"

cat > "$OUT_DIR/assertions.json" <<'JSON'
{
  "milestone": "M29",
  "status": "pass"
}
JSON

# ---- copy stable artifacts to latest ----
mkdir -p "$LATEST_DIR/m6" "$LATEST_DIR/m7" "$LATEST_DIR/m9" "$LATEST_DIR/replay_v2"

cp "$OUT_DIR/commands.log" "$LATEST_DIR/commands.log"
cp "$OUT_DIR/schemas_validation.json" "$LATEST_DIR/schemas_validation.json"
cp "$OUT_DIR/api_contract_validation.json" "$LATEST_DIR/api_contract_validation.json"
cp "$OUT_DIR/events_manifest_validation.json" "$LATEST_DIR/events_manifest_validation.json"
cp "$OUT_DIR/replay_v1_output.json" "$LATEST_DIR/replay_v1_output.json"
cp "$OUT_DIR/event_signature_verification.json" "$LATEST_DIR/event_signature_verification.json"
cp "$OUT_DIR/assertions.json" "$LATEST_DIR/assertions.json"

cp "$OUT_DIR/m6/delivery_output.json" "$LATEST_DIR/m6/delivery_output.json"
cp "$OUT_DIR/m6/webhook_events.ndjson" "$LATEST_DIR/m6/webhook_events.ndjson"
cp "$OUT_DIR/m6/delivery_validation.json" "$LATEST_DIR/m6/delivery_validation.json"
cp "$OUT_DIR/m6/assertions.json" "$LATEST_DIR/m6/assertions.json"

cp "$OUT_DIR/m7/commit_output.json" "$LATEST_DIR/m7/commit_output.json"
cp "$OUT_DIR/m7/events_outbox.ndjson" "$LATEST_DIR/m7/events_outbox.ndjson"
cp "$OUT_DIR/m7/events_validation.json" "$LATEST_DIR/m7/events_validation.json"
cp "$OUT_DIR/m7/assertions.json" "$LATEST_DIR/m7/assertions.json"

cp "$OUT_DIR/m9/settlement_output.json" "$LATEST_DIR/m9/settlement_output.json"
cp "$OUT_DIR/m9/events_outbox.ndjson" "$LATEST_DIR/m9/events_outbox.ndjson"
cp "$OUT_DIR/m9/events_validation.json" "$LATEST_DIR/m9/events_validation.json"
cp "$OUT_DIR/m9/assertions.json" "$LATEST_DIR/m9/assertions.json"

cp "$OUT_DIR/replay_v2/replay_output.json" "$LATEST_DIR/replay_v2/replay_output.json"
cp "$OUT_DIR/replay_v2/events_validation.json" "$LATEST_DIR/replay_v2/events_validation.json"
cp "$OUT_DIR/replay_v2/assertions.json" "$LATEST_DIR/replay_v2/assertions.json"

echo "verify ${M} pass"
