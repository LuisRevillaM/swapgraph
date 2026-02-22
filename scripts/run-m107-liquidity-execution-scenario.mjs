import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { LiquidityExecutionService } from '../src/service/liquidityExecutionService.mjs';
import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M107';
const SCENARIO_FILE = 'fixtures/release/m107_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m107_expected.json';
const OUTPUT_FILE = 'liquidity_execution_output.json';

const root = process.cwd();
const outDir = process.env.OUT_DIR;
if (!outDir) {
  console.error('Missing OUT_DIR env');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256HexCanonical(value) {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function reasonCodeFromError(body) {
  return body?.error?.details?.reason_code ?? null;
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
  for (const [key, value] of Object.entries(op)) {
    if (!key.startsWith('expect_')) continue;
    const field = key.slice('expect_'.length);
    assert.deepEqual(rec[field], value, `expectation_failed op=${op.op} field=${field}`);
  }
}

function resolveRefs(value, refs) {
  if (Array.isArray(value)) return value.map(x => resolveRefs(x, refs));
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key.endsWith('_ref')) {
      const resolved = refs.get(inner);
      if (resolved === undefined) throw new Error(`missing ref value for ${key} -> ${inner}`);
      out[key.slice(0, -4)] = resolved;
      continue;
    }
    out[key] = resolveRefs(inner, refs);
  }
  return out;
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const actors = scenario.actors ?? {};

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();
for (const [key, value] of Object.entries(scenario.seed_state ?? {})) {
  store.state[key] = clone(value);
}

store.state.idempotency ||= {};
store.state.liquidity_execution_modes ||= {};
store.state.liquidity_execution_requests ||= {};
store.state.liquidity_execution_request_counter ||= 0;
store.state.liquidity_execution_export_checkpoints ||= {};

const service = new LiquidityExecutionService({ store });

const operations = [];
const refs = new Map();

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);
  const auth = op.auth ?? {};
  const providerId = op.provider_id_ref ? refs.get(op.provider_id_ref) : op.provider_id;
  const requestId = op.request_id_ref ? refs.get(op.request_id_ref) : op.request_id;

  let response;
  let replayed = null;

  if (op.op === 'liquidityExecution.mode.upsert') {
    const request = resolveRefs(clone(op.request ?? {}), refs);
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.upsertMode({ actor, auth, providerId, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'liquidityExecution.mode.get') {
    response = service.getMode({ actor, auth, providerId });
  } else if (op.op === 'liquidityExecution.request.record') {
    const request = resolveRefs(clone(op.request ?? {}), refs);
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.recordRequest({ actor, auth, providerId, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'liquidityExecution.request.approve') {
    const request = resolveRefs(clone(op.request ?? {}), refs);
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.approveRequest({
      actor,
      auth,
      providerId,
      requestId,
      idempotencyKey: op.idempotency_key,
      request
    });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'liquidityExecution.request.reject') {
    const request = resolveRefs(clone(op.request ?? {}), refs);
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.rejectRequest({
      actor,
      auth,
      providerId,
      requestId,
      idempotencyKey: op.idempotency_key,
      request
    });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'liquidityExecution.export') {
    const query = resolveRefs(clone(op.query ?? {}), refs);
    response = service.exportRequests({ actor, auth, providerId, query });
  } else {
    throw new Error(`unsupported op: ${op.op}`);
  }

  validateApiResponse(op.op, response);

  const rec = {
    op: op.op,
    ok: response.ok,
    replayed,
    error_code: response.ok ? null : response.body.error.code,
    reason_code: response.ok ? null : reasonCodeFromError(response.body)
  };

  if ((op.op === 'liquidityExecution.mode.upsert' || op.op === 'liquidityExecution.mode.get') && response.ok) {
    rec.provider_id = response.body.provider_id ?? null;
    rec.mode = response.body.execution_mode?.mode ?? null;
    rec.restricted_adapter_context = response.body.execution_mode?.restricted_adapter_context ?? null;
    rec.override_policy_present = !!response.body.execution_mode?.override_policy;
  }

  if ((op.op === 'liquidityExecution.request.record'
    || op.op === 'liquidityExecution.request.approve'
    || op.op === 'liquidityExecution.request.reject') && response.ok) {
    rec.provider_id = response.body.provider_id ?? null;
    rec.request_id = response.body.execution_request?.request_id ?? null;
    rec.status = response.body.execution_request?.status ?? null;
    rec.decision = response.body.execution_request?.decision ?? null;
    rec.risk_class = response.body.execution_request?.risk_class ?? null;
    rec.action_type = response.body.execution_request?.action_type ?? null;
    rec.operator_actor_id = response.body.execution_request?.operator_actor?.id ?? null;
    rec.decided_at = response.body.execution_request?.decided_at ?? null;

    if (typeof op.save_request_ref === 'string') refs.set(op.save_request_ref, rec.request_id);
  }

  if (op.op === 'liquidityExecution.export' && response.ok) {
    const exported = response.body.export ?? {};
    const entries = Array.isArray(exported.entries) ? exported.entries : [];
    rec.provider_id = response.body.provider_id ?? null;
    rec.total_filtered = exported.total_filtered ?? null;
    rec.entries_count = entries.length;
    rec.next_cursor = exported.next_cursor ?? null;
    rec.attestation_chain_hash = exported.attestation?.chain_hash ?? null;
    rec.checkpoint_hash = exported.checkpoint?.checkpoint_hash ?? null;
    rec.first_request_id = entries[0]?.request_id ?? null;

    if (typeof op.save_cursor_ref === 'string' && rec.next_cursor) refs.set(op.save_cursor_ref, rec.next_cursor);
    if (typeof op.save_attestation_ref === 'string' && rec.attestation_chain_hash) refs.set(op.save_attestation_ref, rec.attestation_chain_hash);
    if (typeof op.save_checkpoint_ref === 'string' && rec.checkpoint_hash) refs.set(op.save_checkpoint_ref, rec.checkpoint_hash);
  }

  operations.push(rec);
  applyExpectations(op, rec);
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

const final = {
  liquidity_execution_modes_count: Object.keys(store.state.liquidity_execution_modes ?? {}).length,
  liquidity_execution_requests_count: Object.keys(store.state.liquidity_execution_requests ?? {}).length,
  liquidity_execution_export_checkpoints_count: Object.keys(store.state.liquidity_execution_export_checkpoints ?? {}).length,
  idempotency_keys_count: Object.keys(store.state.idempotency ?? {}).length
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
