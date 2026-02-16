import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { buildProposalCreatedEvent, buildProposalExpiringEvent } from '../src/delivery/proposalDelivery.mjs';

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

const schemasDir = path.join(root, 'docs/spec/schemas');
const eventsManifest = readJson(path.join(root, 'docs/spec/events/manifest.v1.json'));
const typeToSchemaFile = new Map((eventsManifest.event_types ?? []).map(e => [e.type, e.payload_schema]));

// Load schemas into AJV
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const schemaFiles = readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'));
for (const sf of schemaFiles) {
  const s = readJson(path.join(schemasDir, sf));
  ajv.addSchema(s);
}

function validateBySchemaFile(schemaFile, payload) {
  const schema = readJson(path.join(schemasDir, schemaFile));
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  const ok = validate(payload);
  return { ok, errors: validate.errors ?? [] };
}

function validateEventEnvelope(evt) {
  const envSchema = readJson(path.join(schemasDir, eventsManifest.event_envelope_schema));
  const validate = ajv.getSchema(envSchema.$id) ?? ajv.compile(envSchema);
  const ok = validate(evt);
  return { ok, errors: validate.errors ?? [] };
}

function validateEventPayload(evt) {
  const schemaFile = typeToSchemaFile.get(evt.type);
  if (!schemaFile) return { ok: false, errors: [{ message: `unknown event type ${evt.type}` }] };
  return validateBySchemaFile(schemaFile, evt.payload);
}

// Input proposals come from matching fixture output (keeps delivery decoupled from matching code changes)
const matchingOut = readJson(path.join(root, 'fixtures/matching/m5_expected.json'));
const proposals = matchingOut.proposals;

const input = readJson(path.join(root, 'fixtures/delivery/m6_input.json'));
const actor = input.actor;
const occurredAt = input.occurred_at;

// Build polling response
const pollingResponse = { proposals };
const vPoll = validateBySchemaFile('CycleProposalListResponse.schema.json', pollingResponse);
if (!vPoll.ok) throw new Error(`polling response invalid: ${JSON.stringify(vPoll.errors)}`);

// Build webhook events
const events = [];
for (const p of proposals.slice().sort((a, b) => a.id.localeCompare(b.id))) {
  const correlationId = `corr_${p.id}`;
  events.push(buildProposalCreatedEvent({ proposal: p, actor, occurredAt, correlationId }));
  if (input.emit_expiring) {
    events.push(buildProposalExpiringEvent({ proposalId: p.id, expiresAt: p.expires_at, actor, occurredAt, correlationId }));
  }
}

if (input.emit_duplicates && events.length > 0) {
  // duplicate first event to demonstrate at-least-once delivery and dedupe-by-event_id.
  events.push(events[0]);
}

// Validate events against envelope + payload schemas
const eventValidation = events.map((evt) => {
  const env = validateEventEnvelope(evt);
  const payload = validateEventPayload(evt);
  return {
    event_id: evt.event_id,
    type: evt.type,
    envelope_ok: env.ok,
    payload_ok: payload.ok,
    envelope_errors: env.errors,
    payload_errors: payload.errors
  };
});

const overall = eventValidation.every(r => r.envelope_ok && r.payload_ok);
if (!overall) {
  throw new Error(`event validation failed: ${JSON.stringify(eventValidation, null, 2)}`);
}

// Deterministic output package
const out = {
  polling_response: pollingResponse,
  webhook_events: events,
  stats: {
    proposals: proposals.length,
    events_total: events.length,
    events_unique: new Set(events.map(e => e.event_id)).size
  }
};

// Expected snapshot
const expectedPath = path.join(root, 'fixtures/delivery/m6_expected.json');
if (readFileSync(expectedPath, 'utf8').trim().length > 0) {
  const expected = readJson(expectedPath);
  assert.deepEqual(out, expected);
}

writeFileSync(path.join(outDir, 'polling_response.json'), JSON.stringify(pollingResponse, null, 2));
writeFileSync(path.join(outDir, 'webhook_events.ndjson'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
writeFileSync(path.join(outDir, 'delivery_output.json'), JSON.stringify(out, null, 2));
writeFileSync(path.join(outDir, 'delivery_validation.json'), JSON.stringify({ overall: true, eventValidation }, null, 2));
writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M6', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: out.stats }, null, 2));
