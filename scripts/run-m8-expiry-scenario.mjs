import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { CommitService } from '../src/commit/commitService.mjs';
import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { commitIdForProposalId } from '../src/commit/commitIds.mjs';

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

// Load schemas
const schemasDir = path.join(root, 'docs/spec/schemas');
const schemaFiles = readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const sf of schemaFiles) {
  ajv.addSchema(readJson(path.join(schemasDir, sf)));
}

function validateFileSchema(schemaFile, payload) {
  const schema = readJson(path.join(schemasDir, schemaFile));
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  const ok = validate(payload);
  return { ok, errors: validate.errors ?? [] };
}

// Load event manifest
const eventsManifest = readJson(path.join(root, 'docs/spec/events/manifest.v1.json'));
const typeToPayloadSchema = new Map((eventsManifest.event_types ?? []).map(e => [e.type, e.payload_schema]));

function validateEvent(evt) {
  const env = validateFileSchema(eventsManifest.event_envelope_schema, evt);
  const payloadSchema = typeToPayloadSchema.get(evt.type);
  const payload = payloadSchema ? validateFileSchema(payloadSchema, evt.payload) : { ok: false, errors: [{ message: 'unknown event type' }] };
  return { event_id: evt.event_id, type: evt.type, envelope_ok: env.ok, payload_ok: payload.ok, envelope_errors: env.errors, payload_errors: payload.errors };
}

// Seed intents from matching fixture.
const matchingInput = readJson(path.join(root, 'fixtures/matching/m5_input.json'));

const storeFile = path.join(outDir, 'store.json');
const store = new JsonStateStore({ filePath: storeFile });
store.load();

for (const it of matchingInput.intents) {
  const intent = { ...it, status: it.status ?? 'active' };
  const v = validateFileSchema('SwapIntent.schema.json', intent);
  if (!v.ok) throw new Error(`seed intent invalid: ${JSON.stringify(v.errors)}`);
  store.state.intents[intent.id] = intent;
}

const matchingOut = readJson(path.join(root, 'fixtures/matching/m5_expected.json'));
const proposals = matchingOut.proposals;

const p3 = proposals.find(p => p.participants.length === 3);
const p2 = proposals.find(p => p.participants.length === 2);
if (!p3 || !p2) throw new Error('expected both a 3-cycle and 2-cycle in fixtures');

const scenario = readJson(path.join(root, 'fixtures/commit/m8_scenario.json'));

const p3_override = { ...p3, expires_at: scenario.p3_expires_at };
const p2_override = { ...p2, expires_at: scenario.p2_expires_at };

const proposalByRef = { p3: p3_override, p2: p2_override };

const svc = new CommitService({ store });

const opsResults = [];
for (const op of scenario.operations) {
  if (op.op === 'cycleProposals.accept') {
    const proposal = proposalByRef[op.proposal_ref];
    const req = { proposal_id: proposal.id };
    const vreq = validateFileSchema('CommitAcceptRequest.schema.json', req);
    if (!vreq.ok) throw new Error(`accept request invalid: ${JSON.stringify(vreq.errors)}`);

    const r = svc.accept({ actor: op.actor, idempotencyKey: op.idempotency_key, proposal, requestBody: req, occurredAt: op.occurred_at });
    const res = r.result;

    if (res.ok) {
      const vres = validateFileSchema('CommitResponse.schema.json', res.body);
      if (!vres.ok) throw new Error(`accept response invalid: ${JSON.stringify(vres.errors)}`);
    } else {
      const verr = validateFileSchema('ErrorResponse.schema.json', res.body);
      if (!verr.ok) throw new Error(`accept error invalid: ${JSON.stringify(verr.errors)}`);
    }

    opsResults.push({ op: op.op, proposal_id: proposal.id, ok: res.ok, replayed: r.replayed, error_code: res.ok ? null : res.body.error.code, commit_phase: res.ok ? res.body.commit.phase : null });
    continue;
  }

  if (op.op === 'expire.accept_window') {
    const r = svc.expireAcceptPhase({
      proposals: [p3_override, p2_override],
      nowIso: scenario.expire_now,
      actor: scenario.actor_system
    });
    opsResults.push({ op: op.op, ok: r.ok, expired_commit_ids: r.expired_commit_ids });
    continue;
  }

  throw new Error(`unsupported op in scenario: ${op.op}`);
}

store.save();

const storeReload = new JsonStateStore({ filePath: storeFile });
storeReload.load();

// Validate events in outbox.
const events = storeReload.state.events;
const validations = events.map(validateEvent);
const allOk = validations.every(v => v.envelope_ok && v.payload_ok);
if (!allOk) throw new Error(`event schema validation failed: ${JSON.stringify(validations, null, 2)}`);

const commit3Id = commitIdForProposalId(p3_override.id);
const commit2Id = commitIdForProposalId(p2_override.id);

const out = {
  operations: opsResults,
  reservations: storeReload.state.reservations,
  commit3_phase: storeReload.state.commits[commit3Id]?.phase ?? null,
  commit2_phase: storeReload.state.commits[commit2Id]?.phase ?? null,
  events_count: events.length,
  events_unique: new Set(events.map(e => e.event_id)).size
};

const expectedPath = path.join(root, 'fixtures/commit/m8_expected.json');
const expected = readJson(expectedPath);
assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'expiry_output.json'), JSON.stringify(out, null, 2));
writeFileSync(path.join(outDir, 'events_outbox.ndjson'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
writeFileSync(path.join(outDir, 'events_validation.json'), JSON.stringify({ overall: true, validations }, null, 2));
writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M8', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: opsResults.length, events: events.length } }, null, 2));
