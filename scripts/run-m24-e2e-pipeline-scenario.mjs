import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { ingestWebhookEvents } from '../src/delivery/proposalIngestService.mjs';
import { CycleProposalsReadService } from '../src/read/cycleProposalsReadService.mjs';
import { CycleProposalsCommitService } from '../src/service/cycleProposalsCommitService.mjs';
import { SettlementStartService } from '../src/service/settlementStartService.mjs';
import { SettlementActionsService } from '../src/service/settlementActionsService.mjs';
import { SettlementReadService } from '../src/read/settlementReadService.mjs';
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

// ---- Load API manifest for response schema mapping ----
const apiManifest = readJson(path.join(root, 'docs/spec/api/manifest.v1.json'));
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(e => [e.operation_id, e]));

// ---- Load schemas into AJV ----
const schemasDir = path.join(root, 'docs/spec/schemas');
const schemaFiles = readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const sf of schemaFiles) {
  ajv.addSchema(readJson(path.join(schemasDir, sf)));
}

function validateAgainstSchemaFile(schemaFile, payload) {
  const schema = readJson(path.join(schemasDir, schemaFile));
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  const ok = validate(payload);
  return { ok, errors: validate.errors ?? [] };
}

// ---- Load scenario + expected ----
const scenario = readJson(path.join(root, 'fixtures/pipeline/m24_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/pipeline/m24_expected.json'));

const delivery = readJson(path.join(root, scenario.delivery_fixture));

// Validate delivery fixture against schemas.
{
  const vPoll = validateAgainstSchemaFile('CycleProposalListResponse.schema.json', delivery.polling_response);
  if (!vPoll.ok) throw new Error(`delivery polling_response invalid: ${JSON.stringify(vPoll.errors)}`);

  const eventsManifest = readJson(path.join(root, 'docs/spec/events/manifest.v1.json'));
  const typeToSchemaFile = new Map((eventsManifest.event_types ?? []).map(e => [e.type, e.payload_schema]));

  for (const evt of delivery.webhook_events ?? []) {
    const env = validateAgainstSchemaFile(eventsManifest.event_envelope_schema, evt);
    if (!env.ok) throw new Error(`event envelope invalid for event_id=${evt.event_id}: ${JSON.stringify(env.errors)}`);

    const payloadSchema = typeToSchemaFile.get(evt.type);
    if (!payloadSchema) throw new Error(`unknown event type in fixture: ${evt.type}`);

    const payload = validateAgainstSchemaFile(payloadSchema, evt.payload);
    if (!payload.ok) throw new Error(`event payload invalid for type=${evt.type} event_id=${evt.event_id}: ${JSON.stringify(payload.errors)}`);
  }
}

const actors = scenario.actors;

// Identify proposal ids for p2/p3 refs.
const deliveredProposals = delivery.polling_response?.proposals ?? [];
const p3 = deliveredProposals.find(p => (p.participants ?? []).length === 3);
const p2 = deliveredProposals.find(p => (p.participants ?? []).length === 2);
if (!p2 || !p3) throw new Error('expected both a 2-cycle and 3-cycle proposal in delivery fixture');
const proposalByRef = { p2, p3 };

// ---- Seed store (intents + proposals via delivery ingestion) ----
const storeFile = path.join(outDir, 'store.json');
const store = new JsonStateStore({ filePath: storeFile });
store.load();

// Seed intents.
const matchingInput = readJson(path.join(root, 'fixtures/matching/m5_input.json'));
for (const it of matchingInput.intents) {
  const intent = { ...it, status: it.status ?? 'active' };
  const v = validateAgainstSchemaFile('SwapIntent.schema.json', intent);
  if (!v.ok) throw new Error(`seed intent invalid: ${JSON.stringify(v.errors)}`);
  store.state.intents[intent.id] = intent;
}

const proposalsRead = new CycleProposalsReadService({ store });
const commitsApi = new CycleProposalsCommitService({ store });
const settlementStart = new SettlementStartService({ store });
const settlementActions = new SettlementActionsService({ store });
const settlementRead = new SettlementReadService({ store });

let seenEventIds = new Set();

const operations = [];

for (const op of scenario.operations ?? []) {
  if (op.op === 'delivery.ingest_webhooks') {
    const actor = actors[op.actor_ref];
    const r = ingestWebhookEvents({ store, events: delivery.webhook_events, seenEventIds });
    if (!r.ok) throw new Error(`ingest_webhooks failed: ${JSON.stringify(r)}`);
    seenEventIds = r.seenEventIds;

    const proposalIds = Object.keys(store.state.proposals ?? {}).slice().sort();
    operations.push({
      op: op.op,
      label: op.label ?? null,
      actor,
      ok: true,
      ...r.stats,
      proposals_count: proposalIds.length
    });
    continue;
  }

  if (op.op === 'cycleProposals.list') {
    const actor = actors[op.actor_ref];
    const r = proposalsRead.list({ actor });

    const endpoint = endpointsByOp.get(op.op);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

    if (r.ok) {
      const v = validateAgainstSchemaFile(endpoint.response_schema, r.body);
      if (!v.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(v.errors)}`);

      const ids = (r.body.proposals ?? []).map(p => p.id).slice().sort();
      operations.push({ op: op.op, actor, ok: true, error_code: null, proposal_ids: ids, proposals_count: ids.length });
      continue;
    }

    const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', r.body);
    if (!verr.ok) throw new Error(`error response invalid for op=${op.op}: ${JSON.stringify(verr.errors)}`);
    operations.push({ op: op.op, actor, ok: false, error_code: r.body.error.code, proposal_ids: null, proposals_count: null });
    continue;
  }

  if (op.op === 'cycleProposals.accept') {
    const proposalId = proposalByRef[op.proposal_ref]?.id;
    const actor = actors[op.actor_ref];

    const req = { proposal_id: proposalId };
    const r = commitsApi.accept({ actor, idempotencyKey: op.idempotency_key, proposalId, requestBody: req, occurredAt: op.occurred_at });
    const res = r.result;

    if (res.ok) {
      const v = validateAgainstSchemaFile('CommitResponse.schema.json', res.body);
      if (!v.ok) throw new Error(`accept response invalid: ${JSON.stringify(v.errors)}`);
    } else {
      const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', res.body);
      if (!verr.ok) throw new Error(`accept error invalid: ${JSON.stringify(verr.errors)}`);
    }

    operations.push({
      op: op.op,
      cycle_id: proposalId,
      actor,
      ok: res.ok,
      replayed: r.replayed,
      error_code: res.ok ? null : res.body.error.code,
      commit_phase: res.ok ? res.body.commit.phase : null
    });
    continue;
  }

  if (op.op === 'settlement.start') {
    const cycleId = proposalByRef[op.proposal_ref]?.id;
    const actor = actors[op.actor_ref];
    const depositDeadlineAt = scenario.cycles?.[op.proposal_ref]?.deposit_deadline_at;

    const r = settlementStart.start({ actor, cycleId, occurredAt: op.occurred_at, depositDeadlineAt });

    operations.push({
      op: op.op,
      cycle_id: cycleId,
      actor,
      ok: r.ok,
      replayed: r.ok ? (r.replayed ?? false) : false,
      error_code: r.ok ? null : r.error.code,
      timeline_state: r.ok ? r.timeline.state : null
    });
    continue;
  }

  if (op.op === 'settlement.deposit_confirmed') {
    const cycleId = proposalByRef[op.proposal_ref]?.id;
    const actor = actors[op.actor_ref];

    const r = settlementActions.confirmDeposit({ actor, cycleId, depositRef: op.deposit_ref, occurredAt: op.occurred_at });

    operations.push({
      op: op.op,
      cycle_id: cycleId,
      actor,
      ok: r.ok,
      replayed: r.ok ? (r.replayed ?? false) : false,
      error_code: r.ok ? null : r.error.code,
      timeline_state: r.ok ? r.timeline.state : null
    });
    continue;
  }

  if (op.op === 'settlement.begin_execution') {
    const cycleId = proposalByRef[op.proposal_ref]?.id;
    const actor = actors[op.actor_ref];

    const r = settlementActions.beginExecution({ actor, cycleId, occurredAt: op.occurred_at });

    operations.push({
      op: op.op,
      cycle_id: cycleId,
      actor,
      ok: r.ok,
      error_code: r.ok ? null : r.error.code,
      timeline_state: r.ok ? r.timeline.state : null
    });
    continue;
  }

  if (op.op === 'settlement.complete') {
    const cycleId = proposalByRef[op.proposal_ref]?.id;
    const actor = actors[op.actor_ref];

    const r = settlementActions.complete({ actor, cycleId, occurredAt: op.occurred_at });

    operations.push({
      op: op.op,
      cycle_id: cycleId,
      actor,
      ok: r.ok,
      error_code: r.ok ? null : r.error.code,
      timeline_state: r.ok ? r.timeline.state : null,
      receipt_id: r.ok ? r.receipt.id : null
    });
    continue;
  }

  if (op.op === 'settlement.instructions') {
    const cycleId = proposalByRef[op.proposal_ref]?.id;
    const actor = actors[op.actor_ref];

    const r = settlementRead.instructions({ actor, cycleId });

    const endpoint = endpointsByOp.get(op.op);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

    if (r.ok) {
      const v = validateAgainstSchemaFile(endpoint.response_schema, r.body);
      if (!v.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(v.errors)}`);
      operations.push({
        op: op.op,
        cycle_id: cycleId,
        actor,
        ok: true,
        error_code: null,
        correlation_id: r.body.correlation_id,
        timeline_state: r.body.timeline.state,
        instructions_count: (r.body.instructions ?? []).length
      });
      continue;
    }

    const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', r.body);
    if (!verr.ok) throw new Error(`error invalid for op=${op.op}: ${JSON.stringify(verr.errors)}`);
    operations.push({ op: op.op, cycle_id: cycleId, actor, ok: false, error_code: r.body.error.code });
    continue;
  }

  if (op.op === 'settlement.status') {
    const cycleId = proposalByRef[op.proposal_ref]?.id;
    const actor = actors[op.actor_ref];

    const r = settlementRead.status({ actor, cycleId });

    const endpoint = endpointsByOp.get(op.op);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

    if (r.ok) {
      const v = validateAgainstSchemaFile(endpoint.response_schema, r.body);
      if (!v.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(v.errors)}`);
      operations.push({
        op: op.op,
        cycle_id: cycleId,
        actor,
        ok: true,
        error_code: null,
        correlation_id: r.body.correlation_id,
        timeline_state: r.body.timeline.state
      });
      continue;
    }

    const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', r.body);
    if (!verr.ok) throw new Error(`error invalid for op=${op.op}: ${JSON.stringify(verr.errors)}`);
    operations.push({ op: op.op, cycle_id: cycleId, actor, ok: false, error_code: r.body.error.code });
    continue;
  }

  if (op.op === 'receipts.get') {
    const cycleId = proposalByRef[op.proposal_ref]?.id;
    const actor = actors[op.actor_ref];

    const r = settlementRead.receipt({ actor, cycleId });

    const endpoint = endpointsByOp.get(op.op);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

    if (r.ok) {
      const v = validateAgainstSchemaFile(endpoint.response_schema, r.body);
      if (!v.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(v.errors)}`);
      operations.push({
        op: op.op,
        cycle_id: cycleId,
        actor,
        ok: true,
        error_code: null,
        correlation_id: r.body.correlation_id,
        receipt_id: r.body.receipt.id,
        receipt_final_state: r.body.receipt.final_state
      });
      continue;
    }

    const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', r.body);
    if (!verr.ok) throw new Error(`error invalid for op=${op.op}: ${JSON.stringify(verr.errors)}`);
    operations.push({ op: op.op, cycle_id: cycleId, actor, ok: false, error_code: r.body.error.code });
    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

store.save();

const cycleId = proposalByRef.p3.id;
const out = canonicalize({
  operations,
  final: {
    cycle_id: cycleId,
    timeline_state: store.state.timelines?.[cycleId]?.state ?? null,
    receipt_id: store.state.receipts?.[cycleId]?.id ?? null,
    reservations_keys: Object.keys(store.state.reservations ?? {}).slice().sort(),
    events_count: (store.state.events ?? []).length,
    events_unique: new Set((store.state.events ?? []).map(e => e.event_id)).size
  }
});

// write outputs before assertion
writeFileSync(path.join(outDir, 'pipeline_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M24', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
