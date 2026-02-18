import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

import { ingestWebhookEvents } from '../src/delivery/proposalIngestService.mjs';
import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const root = process.cwd();
const outDir = process.env.OUT_DIR;
if (!outDir) {
  console.error('Missing OUT_DIR env');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

const scenarioPath = path.join(root, 'fixtures/delivery/m30_scenario.json');
const expectedPath = path.join(root, 'fixtures/delivery/m30_expected.json');

const scenario = readJson(scenarioPath);
const expected = readJson(expectedPath);

const delivery = readJson(path.join(root, scenario.delivery_fixture));
const keySet = readJson(path.join(root, scenario.event_signing_keys_fixture));

if (!Array.isArray(delivery.webhook_events) || delivery.webhook_events.length === 0) {
  throw new Error('delivery fixture missing webhook_events');
}

function storeSnapshot(store) {
  const proposalIds = Object.keys(store.state.proposals ?? {}).slice().sort();
  const seenIds = Object.keys(store.state.delivery?.webhook_seen_event_ids ?? {}).slice().sort();
  return {
    proposals_count: proposalIds.length,
    proposal_ids: proposalIds,
    seen_event_ids_count: seenIds.length,
    seen_event_ids: seenIds
  };
}

// Build a tampered event that still matches schema shape, but fails signature verification.
const tamperIndex = scenario.tamper?.event_index ?? 0;
const tampered = JSON.parse(JSON.stringify(delivery.webhook_events[tamperIndex]));
if (!tampered?.payload?.proposal) throw new Error('expected proposal payload in tampered event');

const oldExpiresAt = tampered.payload.proposal.expires_at;
const newExpiresAt = scenario.tamper?.new_expires_at;
if (!newExpiresAt) throw new Error('scenario.tamper.new_expires_at is required');

tampered.payload.proposal.expires_at = newExpiresAt;

const storeFile = path.join(outDir, 'store.json');

// Round 0: tampered event must be rejected and not recorded as seen.
const store0 = new JsonStateStore({ filePath: storeFile });
store0.load();

const ops = [];

const rTamper = ingestWebhookEvents({ store: store0, events: [tampered], keySet });
store0.save();
ops.push({
  op: 'delivery.ingest_webhooks',
  label: 'tampered',
  ok: rTamper.ok,
  ...rTamper.stats,
  invalid_signatures: rTamper.invalid_signatures,
  tamper: {
    event_id: tampered.event_id,
    type: tampered.type,
    old_expires_at: oldExpiresAt,
    new_expires_at: newExpiresAt
  },
  store: storeSnapshot(store0)
});

// Round 1: ingest valid fixture events.
const r1 = ingestWebhookEvents({ store: store0, events: delivery.webhook_events, keySet });
store0.save();
ops.push({
  op: 'delivery.ingest_webhooks',
  label: 'round1',
  ok: r1.ok,
  ...r1.stats,
  invalid_signatures: r1.invalid_signatures,
  store: storeSnapshot(store0)
});

const snapBeforeRestart = storeSnapshot(store0);

// Round 2: reload store and re-ingest the same events; duplicates must be detected via persisted dedupe.
const storeReloaded = new JsonStateStore({ filePath: storeFile });
storeReloaded.load();

const r2 = ingestWebhookEvents({ store: storeReloaded, events: delivery.webhook_events, keySet });
storeReloaded.save();
ops.push({
  op: 'delivery.ingest_webhooks',
  label: 'after_restart',
  ok: r2.ok,
  ...r2.stats,
  invalid_signatures: r2.invalid_signatures,
  store: storeSnapshot(storeReloaded)
});

const snapAfterRestart = storeSnapshot(storeReloaded);

const checks = {
  tamper_rejected: ops[0].ok === false && ops[0].events_invalid_signature === 1,
  dedupe_persisted_across_restart: JSON.stringify(snapBeforeRestart) === JSON.stringify(snapAfterRestart),
  proposals_present: snapAfterRestart.proposals_count === 2 && snapAfterRestart.seen_event_ids_count > 0
};

const out = canonicalize({
  operations: ops,
  final: {
    before_restart: snapBeforeRestart,
    after_restart: snapAfterRestart
  },
  checks
});

writeFileSync(path.join(outDir, 'webhook_hardening_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M30', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: ops.length } }, null, 2));
