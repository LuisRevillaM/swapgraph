import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { ingestPollingResponse, ingestWebhookEvents } from '../src/delivery/proposalIngestService.mjs';
import { CycleProposalsReadService } from '../src/read/cycleProposalsReadService.mjs';
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

// ---- Load scenario + expected ----
const scenarioPath = path.join(root, 'fixtures/delivery/m19_scenario.json');
const expectedPath = path.join(root, 'fixtures/delivery/m19_expected.json');
const scenario = readJson(scenarioPath);
const expected = readJson(expectedPath);

const delivery = readJson(path.join(root, scenario.delivery_fixture));

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

// ---- Validate delivery fixture payloads (schemas-first) ----
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

const actorsByRef = {
  actor_partner: scenario.actor_partner,
  actor_partner_other: scenario.actor_partner_other,
  actor_user_u1: scenario.actor_user_u1,
  actor_user_u5: scenario.actor_user_u5,
  actor_user_outsider: scenario.actor_user_outsider,
  actor_agent: scenario.actor_agent
};

// Identify proposal ids for p2/p3 refs.
const proposals = delivery.polling_response?.proposals ?? [];
const p3 = proposals.find(p => (p.participants ?? []).length === 3);
const p2 = proposals.find(p => (p.participants ?? []).length === 2);
if (!p2 || !p3) throw new Error('expected both a 2-cycle and 3-cycle proposal in delivery fixture');
const proposalByRef = { p2, p3 };

function storeSnapshot(store) {
  const ids = Object.keys(store.state.proposals ?? {}).slice().sort();
  const scopes = {};
  for (const id of ids) {
    scopes[id] = store.state.tenancy?.proposals?.[id]?.partner_id ?? null;
  }
  return { proposal_ids: ids, proposals_count: ids.length, proposal_partner_ids: scopes };
}

// Create independent stores for polling vs webhook ingestion.
const storePolling = new JsonStateStore({ filePath: path.join(outDir, 'store_polling.json') });
storePolling.load();

const storeWebhook = new JsonStateStore({ filePath: path.join(outDir, 'store_webhook.json') });
storeWebhook.load();

let seenEventIds = new Set();
let webhookSnapshotRound1 = null;

const readSvc = new CycleProposalsReadService({ store: storeWebhook });

const operations = [];

for (const op of scenario.operations ?? []) {
  if (op.op === 'delivery.ingest_polling') {
    const actor = actorsByRef[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

    const r = ingestPollingResponse({ store: storePolling, actor, pollingResponse: delivery.polling_response });
    if (!r.ok) throw new Error(`ingest_polling failed: ${JSON.stringify(r)}`);

    storePolling.save();

    const snap = storeSnapshot(storePolling);
    operations.push({
      op: op.op,
      actor,
      ok: true,
      ...r.stats,
      store: { kind: 'polling', ...snap }
    });
    continue;
  }

  if (op.op === 'delivery.ingest_webhooks') {
    const actor = actorsByRef[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

    const r = ingestWebhookEvents({ store: storeWebhook, events: delivery.webhook_events, seenEventIds });
    if (!r.ok) throw new Error(`ingest_webhooks failed: ${JSON.stringify(r)}`);
    seenEventIds = r.seenEventIds;

    storeWebhook.save();

    const snap = storeSnapshot(storeWebhook);
    if (op.label === 'round1') webhookSnapshotRound1 = snap;

    operations.push({
      op: op.op,
      label: op.label ?? null,
      actor,
      ok: true,
      ...r.stats,
      store: { kind: 'webhook', ...snap }
    });
    continue;
  }

  if (op.op === 'cycleProposals.list') {
    const actor = actorsByRef[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

    const r = readSvc.list({ actor });

    const endpoint = endpointsByOp.get(op.op);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

    if (r.ok) {
      const v = validateAgainstSchemaFile(endpoint.response_schema, r.body);
      if (!v.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(v.errors)}`);

      const ids = (r.body.proposals ?? []).map(p => p.id).slice().sort();
      operations.push({
        op: op.op,
        actor,
        ok: true,
        error_code: null,
        proposal_ids: ids,
        proposals_count: ids.length
      });
      continue;
    }

    const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', r.body);
    if (!verr.ok) throw new Error(`error response invalid for op=${op.op}: ${JSON.stringify(verr.errors)}`);

    operations.push({
      op: op.op,
      actor,
      ok: false,
      error_code: r.body.error.code,
      proposal_ids: null,
      proposals_count: null
    });
    continue;
  }

  if (op.op === 'cycleProposals.get') {
    const actor = actorsByRef[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

    const proposalId = op.proposal_id ?? proposalByRef[op.proposal_ref]?.id;
    if (!proposalId) throw new Error(`missing proposal_id (proposal_ref=${op.proposal_ref ?? 'null'})`);

    const r = readSvc.get({ actor, proposalId });

    const endpoint = endpointsByOp.get(op.op);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

    if (r.ok) {
      const v = validateAgainstSchemaFile(endpoint.response_schema, r.body);
      if (!v.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(v.errors)}`);

      operations.push({
        op: op.op,
        actor,
        ok: true,
        error_code: null,
        proposal_id: proposalId,
        returned_proposal_id: r.body.proposal?.id ?? null
      });
      continue;
    }

    const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', r.body);
    if (!verr.ok) throw new Error(`error response invalid for op=${op.op}: ${JSON.stringify(verr.errors)}`);

    operations.push({
      op: op.op,
      actor,
      ok: false,
      error_code: r.body.error.code,
      proposal_id: proposalId,
      returned_proposal_id: null
    });
    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

// Cross-check: polling vs webhook ingestion produce the same proposal sets + scoping.
const finalPolling = storeSnapshot(storePolling);
const finalWebhook = storeSnapshot(storeWebhook);

const checks = {
  polling_equals_webhook: {
    proposal_ids_equal: JSON.stringify(finalPolling.proposal_ids) === JSON.stringify(finalWebhook.proposal_ids),
    proposal_partner_ids_equal: JSON.stringify(finalPolling.proposal_partner_ids) === JSON.stringify(finalWebhook.proposal_partner_ids)
  },
  webhook_replay_idempotent: webhookSnapshotRound1 ? JSON.stringify(webhookSnapshotRound1) === JSON.stringify(finalWebhook) : false
};

if (!checks.polling_equals_webhook.proposal_ids_equal) throw new Error('polling vs webhook proposal_ids mismatch');
if (!checks.polling_equals_webhook.proposal_partner_ids_equal) throw new Error('polling vs webhook proposal partner_id scoping mismatch');
if (!checks.webhook_replay_idempotent) throw new Error('webhook replay changed store state');

const out = canonicalize({
  operations,
  final: {
    polling: finalPolling,
    webhook: finalWebhook
  },
  checks
});

// write outputs before assertion
writeFileSync(path.join(outDir, 'delivery_persistence_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M19', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
