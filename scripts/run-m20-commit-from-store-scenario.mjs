import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { CycleProposalsCommitService } from '../src/service/cycleProposalsCommitService.mjs';
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

// ---- Load schemas ----
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

// ---- Load API manifest ----
const apiManifest = readJson(path.join(root, 'docs/spec/api/manifest.v1.json'));
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(e => [e.operation_id, e]));

// ---- Load event manifest for validation ----
const eventsManifest = readJson(path.join(root, 'docs/spec/events/manifest.v1.json'));
const typeToPayloadSchema = new Map((eventsManifest.event_types ?? []).map(e => [e.type, e.payload_schema]));

function validateEvent(evt) {
  const env = validateFileSchema(eventsManifest.event_envelope_schema, evt);
  const payloadSchema = typeToPayloadSchema.get(evt.type);
  const payload = payloadSchema ? validateFileSchema(payloadSchema, evt.payload) : { ok: false, errors: [{ message: 'unknown event type' }] };
  return { event_id: evt.event_id, type: evt.type, envelope_ok: env.ok, payload_ok: payload.ok, envelope_errors: env.errors, payload_errors: payload.errors };
}

// ---- Scenario + fixtures ----
const scenario = readJson(path.join(root, 'fixtures/commit/m20_scenario.json'));
const occurredAtList = scenario.occurred_at;
const expectedPath = path.join(root, 'fixtures/commit/m20_expected.json');

// Seed store intents from matching fixture input.
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

// Seed proposals into store (this is what the real API handler would load from DB/state).
const matchingOut = readJson(path.join(root, 'fixtures/matching/m5_expected.json'));
const proposals = matchingOut.proposals;

const p3 = proposals.find(p => p.participants.length === 3);
const p2 = proposals.find(p => p.participants.length === 2);
if (!p3 || !p2) throw new Error('expected both a 3-cycle and 2-cycle proposal in fixtures');

const p3_conflict = { ...p3, id: `${p3.id}_conflict` };

const proposalByRef = {
  p3,
  p2,
  p3_conflict
};

store.state.proposals ||= {};
for (const p of [p2, p3, p3_conflict]) {
  const v = validateFileSchema('CycleProposal.schema.json', p);
  if (!v.ok) throw new Error(`seed proposal invalid: ${JSON.stringify(v.errors)}`);
  store.state.proposals[p.id] = p;
}

const commitApi = new CycleProposalsCommitService({ store });

const opsResults = [];
let tIdx = 0;
for (const op of scenario.operations) {
  const occurredAt = occurredAtList[Math.min(tIdx, occurredAtList.length - 1)];
  tIdx++;

  if (op.op === 'cycleProposals.accept') {
    const proposalId = op.proposal_id ?? proposalByRef[op.proposal_ref]?.id;
    if (!proposalId) throw new Error(`missing proposal_id (proposal_ref=${op.proposal_ref ?? 'null'})`);

    const req = { proposal_id: proposalId };
    const vreq = validateFileSchema('CommitAcceptRequest.schema.json', req);
    if (!vreq.ok) throw new Error(`accept request invalid: ${JSON.stringify(vreq.errors)}`);

    const r = commitApi.accept({ actor: op.actor, idempotencyKey: op.idempotency_key, proposalId, requestBody: req, occurredAt });
    const res = r.result;

    const endpoint = endpointsByOp.get(op.op);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

    if (res.ok) {
      const vres = validateFileSchema(endpoint.response_schema, res.body);
      if (!vres.ok) throw new Error(`accept response invalid: ${JSON.stringify(vres.errors)}`);
    } else {
      const verr = validateFileSchema('ErrorResponse.schema.json', res.body);
      if (!verr.ok) throw new Error(`accept error invalid: ${JSON.stringify(verr.errors)}`);
    }

    opsResults.push({
      op: op.op,
      proposal_id: proposalId,
      ok: res.ok,
      replayed: r.replayed,
      error_code: res.ok ? null : res.body.error.code,
      commit_phase: res.ok ? res.body.commit.phase : null
    });
    continue;
  }

  if (op.op === 'cycleProposals.decline') {
    const proposalId = op.proposal_id ?? proposalByRef[op.proposal_ref]?.id;
    if (!proposalId) throw new Error(`missing proposal_id (proposal_ref=${op.proposal_ref ?? 'null'})`);

    const req = { proposal_id: proposalId };
    const vreq = validateFileSchema('CommitDeclineRequest.schema.json', req);
    if (!vreq.ok) throw new Error(`decline request invalid: ${JSON.stringify(vreq.errors)}`);

    const r = commitApi.decline({ actor: op.actor, idempotencyKey: op.idempotency_key, proposalId, requestBody: req, occurredAt });
    const res = r.result;

    const endpoint = endpointsByOp.get(op.op);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

    if (res.ok) {
      const vres = validateFileSchema(endpoint.response_schema, res.body);
      if (!vres.ok) throw new Error(`decline response invalid: ${JSON.stringify(vres.errors)}`);
    } else {
      const verr = validateFileSchema('ErrorResponse.schema.json', res.body);
      if (!verr.ok) throw new Error(`decline error invalid: ${JSON.stringify(verr.errors)}`);
    }

    opsResults.push({
      op: op.op,
      proposal_id: proposalId,
      ok: res.ok,
      replayed: r.replayed,
      error_code: res.ok ? null : res.body.error.code,
      commit_phase: res.ok ? res.body.commit.phase : null
    });
    continue;
  }

  if (op.op === 'commits.get') {
    const proposalId = op.proposal_id ?? proposalByRef[op.proposal_ref]?.id;
    if (!proposalId) throw new Error(`missing proposal_id (proposal_ref=${op.proposal_ref ?? 'null'})`);

    const commitId = commitIdForProposalId(proposalId);
    const res = commitApi.commitSvc.get({ actor: op.actor, commitId });

    const endpoint = endpointsByOp.get(op.op);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

    if (res.ok) {
      const vres = validateFileSchema(endpoint.response_schema, res.body);
      if (!vres.ok) throw new Error(`get commit response invalid: ${JSON.stringify(vres.errors)}`);
    } else {
      const verr = validateFileSchema('ErrorResponse.schema.json', res.body);
      if (!verr.ok) throw new Error(`get commit error invalid: ${JSON.stringify(verr.errors)}`);
    }

    opsResults.push({
      op: op.op,
      commit_id: commitId,
      ok: res.ok,
      error_code: res.ok ? null : res.body.error.code,
      commit_phase: res.ok ? res.body.commit.phase : null
    });
    continue;
  }

  throw new Error(`unsupported op in scenario: ${op.op}`);
}

store.save();

const storeReload = new JsonStateStore({ filePath: storeFile });
storeReload.load();

const events = storeReload.state.events;
const validations = events.map(validateEvent);
const allOk = validations.every(v => v.envelope_ok && v.payload_ok);
if (!allOk) throw new Error(`event schema validation failed: ${JSON.stringify(validations, null, 2)}`);

const out = {
  operations: opsResults,
  reservations: storeReload.state.reservations,
  commits: storeReload.state.commits,
  idempotency_keys_count: Object.keys(storeReload.state.idempotency).length,
  events_count: events.length,
  events_unique: new Set(events.map(e => e.event_id)).size
};

// write outputs before assertion (helps fixture recalculation)
writeFileSync(path.join(outDir, 'commit_output.json'), JSON.stringify(out, null, 2));
writeFileSync(path.join(outDir, 'events_outbox.ndjson'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
writeFileSync(path.join(outDir, 'events_validation.json'), JSON.stringify({ overall: true, validations }, null, 2));

const expected = readJson(expectedPath);
assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M20', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: opsResults.length, events: events.length } }, null, 2));
