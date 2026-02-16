import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

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

// ---- Load schemas + events manifest ----
const schemasDir = path.join(root, 'docs/spec/schemas');
const eventsManifest = readJson(path.join(root, 'docs/spec/events/manifest.v1.json'));
const typeToSchemaFile = new Map((eventsManifest.event_types ?? []).map(e => [e.type, e.payload_schema]));

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

const schemaFiles = readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'));
for (const sf of schemaFiles) {
  ajv.addSchema(readJson(path.join(schemasDir, sf)));
}

function validateBySchemaFile(schemaFile, payload) {
  const schema = readJson(path.join(schemasDir, schemaFile));
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  const ok = validate(payload);
  return { ok, errors: validate.errors ?? [] };
}

function validateEvent(evt) {
  const env = validateBySchemaFile(eventsManifest.event_envelope_schema, evt);
  const schemaFile = typeToSchemaFile.get(evt.type);
  if (!schemaFile) {
    return { event_id: evt.event_id, type: evt.type, envelope_ok: env.ok, payload_ok: false, envelope_errors: env.errors, payload_errors: [{ message: `unknown event type ${evt.type}` }] };
  }
  const payload = validateBySchemaFile(schemaFile, evt.payload);
  return {
    event_id: evt.event_id,
    type: evt.type,
    envelope_ok: env.ok,
    payload_ok: payload.ok,
    envelope_errors: env.errors,
    payload_errors: payload.errors
  };
}

// ---- Read log + checkpoint fixtures ----
const logPath = path.join(root, 'fixtures/events/event_log.v2.ndjson');
const checkpointPath = path.join(root, 'fixtures/events/checkpoint.v1.json');
const expectedPath = path.join(root, 'fixtures/events/replay_expected_v2.json');

const lines = readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);

const rawEvents = lines.map(l => JSON.parse(l));

// Validate + dedupe (keep first occurrence)
const validations = rawEvents.map(validateEvent);
const overall = validations.every(v => v.envelope_ok && v.payload_ok);
if (!overall) {
  writeFileSync(path.join(outDir, 'events_validation.json'), JSON.stringify({ overall: false, validations }, null, 2));
  throw new Error('event validation failed');
}

const seen = new Set();
const deduped = [];
for (const evt of rawEvents) {
  if (seen.has(evt.event_id)) continue;
  seen.add(evt.event_id);
  deduped.push(evt);
}

function initState() {
  return {
    intents: {},
    cycles: {},
    settlement: {},
    receipts: {},
    proposals: {}
  };
}

function ensureSettlement(state, cycleId) {
  state.settlement[cycleId] ||= { deposits: {}, executing: false };
  state.settlement[cycleId].deposits ||= {};
  state.settlement[cycleId].executing ||= false;
  return state.settlement[cycleId];
}

function applyEvent(state, evt) {
  if (evt.type === 'proposal.created') {
    const p = evt.payload.proposal;
    state.proposals[p.id] = { expires_at: p.expires_at };
    return;
  }

  if (evt.type === 'intent.reserved') {
    state.intents[evt.payload.intent_id] = { reserved: true, cycle_id: evt.payload.cycle_id };
    return;
  }

  if (evt.type === 'intent.unreserved') {
    state.intents[evt.payload.intent_id] = { reserved: false, cycle_id: evt.payload.cycle_id };
    return;
  }

  if (evt.type === 'cycle.state_changed') {
    state.cycles[evt.payload.cycle_id] = { state: evt.payload.to_state };
    return;
  }

  if (evt.type === 'settlement.deposit_required') {
    const s = ensureSettlement(state, evt.payload.cycle_id);
    s.deposit_deadline_at = evt.payload.deposit_deadline_at;
    return;
  }

  if (evt.type === 'settlement.deposit_confirmed') {
    const s = ensureSettlement(state, evt.payload.cycle_id);
    s.deposits[evt.payload.intent_id] = evt.payload.deposit_ref;
    return;
  }

  if (evt.type === 'settlement.executing') {
    const s = ensureSettlement(state, evt.payload.cycle_id);
    s.executing = true;
    return;
  }

  if (evt.type === 'receipt.created') {
    const r = evt.payload.receipt;
    state.receipts[r.cycle_id] = { receipt_id: r.id, final_state: r.final_state };
    return;
  }

  // Unknown types are rejected earlier by validation.
}

function replay(events) {
  const state = initState();
  for (const evt of events) applyEvent(state, evt);
  return state;
}

const fullState = replay(deduped);

const checkpoint = readJson(checkpointPath);
if (!checkpoint.last_event_id) throw new Error('checkpoint missing last_event_id');
const idx = deduped.findIndex(e => e.event_id === checkpoint.last_event_id);
if (idx < 0) throw new Error(`checkpoint last_event_id not found in log: ${checkpoint.last_event_id}`);

const before = deduped.slice(0, idx + 1);
const after = deduped.slice(idx + 1);

const checkpointState = replay(before);
const resumedState = JSON.parse(JSON.stringify(checkpointState));
for (const evt of after) applyEvent(resumedState, evt);

assert.deepEqual(canonicalize(resumedState), canonicalize(fullState));

const out = canonicalize({
  manifest: eventsManifest.id,
  log: {
    file: 'fixtures/events/event_log.v2.ndjson',
    events_total: rawEvents.length,
    events_deduped: deduped.length,
    duplicates: rawEvents.length - deduped.length
  },
  checkpoint: {
    file: 'fixtures/events/checkpoint.v1.json',
    last_event_id: checkpoint.last_event_id,
    deduped_index: idx,
    events_after: after.length
  },
  checkpoint_state: checkpointState,
  full_state: fullState
});

writeFileSync(path.join(outDir, 'replay_output.json'), JSON.stringify(out, null, 2));
writeFileSync(path.join(outDir, 'events_validation.json'), JSON.stringify({ overall: true, validations }, null, 2));

const expected = readJson(expectedPath);
assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M12', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: out.log }, null, 2));
