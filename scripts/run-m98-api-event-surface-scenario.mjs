import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { PlatformInventoryDisputeFacadeService } from '../src/service/platformInventoryDisputeFacadeService.mjs';
import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M98';
const SCENARIO_FILE = 'fixtures/release/m98_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m98_expected.json';
const OUTPUT_FILE = 'api_event_surface_output.json';

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

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function sha256HexCanonical(value) {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function reasonCodeFromError(body) {
  return body?.error?.details?.reason_code ?? null;
}

function parseIsoMs(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

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

const apiManifest = readJson(path.join(root, 'docs/spec/api/manifest.v1.json'));
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(ep => [ep.operation_id, ep]));

const eventsManifest = readJson(path.join(root, 'docs/spec/events/manifest.v1.json'));
const eventPayloadByType = new Map((eventsManifest.event_types ?? []).map(et => [et.type, et.payload_schema]));

function endpointFor(opId) {
  const endpoint = endpointsByOp.get(opId);
  if (!endpoint) throw new Error(`missing endpoint for operation_id=${opId}`);
  return endpoint;
}

function validateApiRequest(opId, requestPayload) {
  const endpoint = endpointFor(opId);
  if (!endpoint.request_schema) return;
  const v = validateAgainstSchemaFile(endpoint.request_schema, requestPayload);
  if (!v.ok) throw new Error(`request invalid for op=${opId}: ${JSON.stringify(v.errors)}`);
}

function validateApiResponse(opId, response) {
  const endpoint = endpointFor(opId);
  if (response.ok) {
    const v = validateAgainstSchemaFile(endpoint.response_schema, response.body);
    if (!v.ok) throw new Error(`response invalid for op=${opId}: ${JSON.stringify(v.errors)}`);
    return;
  }
  const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', response.body);
  if (!verr.ok) throw new Error(`error response invalid for op=${opId}: ${JSON.stringify(verr.errors)}`);
}

function applyExpectations(op, rec) {
  for (const [k, v] of Object.entries(op)) {
    if (!k.startsWith('expect_')) continue;
    const field = k.slice('expect_'.length);
    assert.deepEqual(rec[field], v, `expectation_failed op=${op.op} field=${field}`);
  }
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const actors = scenario.actors ?? {};

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });

const service = new PlatformInventoryDisputeFacadeService({ store });

const operations = [];
let lastCreatedDisputeId = null;

for (const op of scenario.operations ?? []) {
  const actor = actors?.[op.actor_ref];
  if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);
  const auth = op.auth ?? {};

  if (op.op === 'platform.connections.upsert') {
    validateApiRequest(op.op, op.request ?? {});
    const out = service.upsertPlatformConnection({
      actor,
      auth,
      idempotencyKey: op.idempotency_key,
      request: op.request ?? {}
    });
    const response = out.result;
    validateApiResponse(op.op, response);

    const rec = {
      op: op.op,
      ok: response.ok,
      replayed: out.replayed,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : reasonCodeFromError(response.body),
      connection_id: response.ok ? (response.body.connection?.connection_id ?? null) : null,
      status: response.ok ? (response.body.connection?.status ?? null) : null
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'platform.connections.list') {
    const response = service.listPlatformConnections({ actor, auth });
    validateApiResponse(op.op, response);
    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : reasonCodeFromError(response.body),
      connections_count: response.ok ? (response.body.connections?.length ?? 0) : null
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'inventory.snapshots.record') {
    validateApiRequest(op.op, op.request ?? {});
    const out = service.recordInventorySnapshot({
      actor,
      auth,
      idempotencyKey: op.idempotency_key,
      request: op.request ?? {}
    });
    const response = out.result;
    validateApiResponse(op.op, response);
    const rec = {
      op: op.op,
      ok: response.ok,
      replayed: out.replayed,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : reasonCodeFromError(response.body),
      snapshot_id: response.ok ? (response.body.snapshot?.snapshot_id ?? null) : null,
      assets_count: response.ok ? (response.body.snapshot?.assets?.length ?? 0) : null
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'inventory.assets.list') {
    const response = service.listInventoryAssets({ actor, auth, query: op.query ?? {} });
    validateApiResponse(op.op, response);
    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : reasonCodeFromError(response.body),
      assets_count: response.ok ? (response.body.assets?.length ?? 0) : null
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'disputes.create') {
    validateApiRequest(op.op, op.request ?? {});
    const out = service.createDisputeFacade({
      actor,
      auth,
      idempotencyKey: op.idempotency_key,
      request: op.request ?? {}
    });
    const response = out.result;
    validateApiResponse(op.op, response);
    const rec = {
      op: op.op,
      ok: response.ok,
      replayed: out.replayed,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : reasonCodeFromError(response.body),
      dispute_id: response.ok ? (response.body.dispute?.dispute_id ?? null) : null,
      dispute_status: response.ok ? (response.body.dispute?.status ?? null) : null
    };
    if (response.ok) lastCreatedDisputeId = rec.dispute_id;
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'disputes.get') {
    const disputeId = op.dispute_id_ref === 'last_created'
      ? lastCreatedDisputeId
      : (op.dispute_id ?? null);
    const response = service.getDisputeFacade({
      actor,
      auth,
      disputeId
    });
    validateApiResponse(op.op, response);
    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : reasonCodeFromError(response.body),
      dispute_id: response.ok ? (response.body.dispute?.dispute_id ?? null) : disputeId,
      dispute_status: response.ok ? (response.body.dispute?.status ?? null) : null
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

const eventChecks = [];
for (const check of scenario.event_payload_checks ?? []) {
  const schemaFile = eventPayloadByType.get(check.type);
  if (!schemaFile) throw new Error(`unknown event type in check: ${check.type}`);
  const v = validateAgainstSchemaFile(schemaFile, check.payload ?? {});
  const rec = {
    type: check.type,
    schema: schemaFile,
    ok: v.ok,
    errors_count: v.errors?.length ?? 0
  };
  if (typeof check.expect_ok === 'boolean') {
    assert.equal(rec.ok, check.expect_ok, `event payload check failed for type=${check.type}`);
  }
  eventChecks.push(rec);
}

store.save();

const userConnections = Object.values(store.state.platform_connections?.['user:u1'] ?? {});
const partnerSnapshots = store.state.inventory_snapshots?.partner_demo ?? [];
const partnerDisputes = (store.state.partner_program_disputes ?? []).filter(x => x?.partner_id === 'partner_demo');
const latestSnapshotCapturedAt = partnerSnapshots.length > 0
  ? partnerSnapshots
      .map(row => row?.captured_at)
      .filter(x => parseIsoMs(x) !== null)
      .sort()
      .slice(-1)[0]
  : null;

const final = {
  platform_connections_user_u1: userConnections.length,
  inventory_snapshots_partner_demo: partnerSnapshots.length,
  disputes_partner_demo: partnerDisputes.length,
  latest_snapshot_captured_at: latestSnapshotCapturedAt ?? null,
  event_types_in_manifest: {
    proposal_cancelled: eventPayloadByType.has('proposal.cancelled'),
    cycle_failed: eventPayloadByType.has('cycle.failed'),
    user_reliability_changed: eventPayloadByType.has('user.reliability_changed')
  }
};

const out = canonicalize({
  operations,
  event_checks: eventChecks,
  final
});

writeFileSync(path.join(outDir, OUTPUT_FILE), JSON.stringify(out, null, 2));

const outHash = sha256HexCanonical(out);
if (typeof expected?.expected_sha256 === 'string' && expected.expected_sha256.trim()) {
  assert.equal(outHash, expected.expected_sha256.trim());
} else {
  assert.deepEqual(out, expected);
}

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: MILESTONE, status: 'pass' }, null, 2));
console.log(JSON.stringify({ ok: true, stats: { operations: operations.length, event_checks: eventChecks.length } }, null, 2));
