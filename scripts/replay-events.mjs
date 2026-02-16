import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = process.cwd();
const schemasDir = path.join(root, 'docs/spec/schemas');
const manifestPath = path.join(root, 'docs/spec/events/manifest.v1.json');
const logPath = path.join(root, 'fixtures/events/event_log.v1.ndjson');

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

const manifest = readJson(manifestPath);
const typeToSchemaFile = new Map((manifest.event_types ?? []).map(e => [e.type, e.payload_schema]));

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

// Load all schemas so $ref resolution works (envelope/payload schemas reference core primitives).
const schemaFiles = readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'));
for (const sf of schemaFiles) {
  const s = readJson(path.join(schemasDir, sf));
  ajv.addSchema(s);
}

const envelopeSchema = readJson(path.join(schemasDir, manifest.event_envelope_schema));
const validateEnvelope = ajv.getSchema(envelopeSchema.$id) ?? ajv.compile(envelopeSchema);

function validatePayload(type, payload) {
  const sf = typeToSchemaFile.get(type);
  if (!sf) throw new Error(`Unknown event type: ${type}`);
  const schema = readJson(path.join(schemasDir, sf));
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  const ok = validate(payload);
  return { ok, errors: validate.errors ?? [] };
}

const state = {
  intents: {},
  proposals: {},
  cycles: {},
  receipts: {},
  stats: { events_total: 0, events_deduped: 0 }
};

const seen = new Set();
const lines = readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
state.stats.events_total = lines.length;

for (const line of lines) {
  const evt = JSON.parse(line);

  const okEnv = validateEnvelope(evt);
  if (!okEnv) {
    throw new Error(`Envelope invalid for event_id=${evt.event_id}: ${JSON.stringify(validateEnvelope.errors)}`);
  }

  if (seen.has(evt.event_id)) continue;
  seen.add(evt.event_id);

  const vp = validatePayload(evt.type, evt.payload);
  if (!vp.ok) {
    throw new Error(`Payload invalid for type=${evt.type} event_id=${evt.event_id}: ${JSON.stringify(vp.errors)}`);
  }

  // Apply minimal state transitions (contract replay demo).
  if (evt.type === 'proposal.created') {
    const p = evt.payload.proposal;
    state.proposals[p.id] = { expires_at: p.expires_at };
  }
  if (evt.type === 'intent.reserved') {
    state.intents[evt.payload.intent_id] = { reserved: true, cycle_id: evt.payload.cycle_id };
  }
  if (evt.type === 'intent.unreserved') {
    state.intents[evt.payload.intent_id] = { reserved: false, cycle_id: evt.payload.cycle_id };
  }
  if (evt.type === 'cycle.state_changed') {
    state.cycles[evt.payload.cycle_id] = { state: evt.payload.to_state };
  }
  if (evt.type === 'receipt.created') {
    const r = evt.payload.receipt;
    state.receipts[r.id] = { cycle_id: r.cycle_id, final_state: r.final_state };
  }
}

state.stats.events_deduped = seen.size;

console.log(JSON.stringify(state, null, 2));
