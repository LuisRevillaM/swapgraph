import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { LiquidityProviderService } from '../src/service/liquidityProviderService.mjs';
import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M103';
const SCENARIO_FILE = 'fixtures/release/m103_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m103_expected.json';
const OUTPUT_FILE = 'liquidity_provider_output.json';

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

const eventsManifest = readJson(path.join(root, 'docs/spec/events/manifest.v1.json'));
const eventPayloadByType = new Map((eventsManifest.event_types ?? []).map(et => [et.type, et.payload_schema]));

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const actors = scenario.actors ?? {};

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();
for (const [key, value] of Object.entries(scenario.seed_state ?? {})) {
  store.state[key] = clone(value);
}

store.state.idempotency ||= {};
store.state.liquidity_providers ||= {};
store.state.liquidity_provider_personas ||= {};
store.state.liquidity_provider_counter ||= 0;
store.state.liquidity_provider_persona_counter ||= 0;

const service = new LiquidityProviderService({ store });

const operations = [];
const refs = new Map();

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);
  const auth = op.auth ?? {};
  const providerId = op.provider_id_ref ? refs.get(op.provider_id_ref) : op.provider_id;

  if (op.op === 'liquidityProviders.register') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.register({ actor, auth, idempotencyKey: op.idempotency_key, request });
    const response = out.result;
    validateApiResponse(op.op, response);

    const rec = {
      op: op.op,
      ok: response.ok,
      replayed: out.replayed,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : reasonCodeFromError(response.body),
      provider_id: response.ok ? (response.body.provider?.provider_id ?? null) : null,
      provider_type: response.ok ? (response.body.provider?.provider_type ?? null) : null
    };

    if (response.ok && typeof op.save_provider_ref === 'string') {
      refs.set(op.save_provider_ref, response.body.provider.provider_id);
    }

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'liquidityProviders.get') {
    const response = service.get({ actor, auth, providerId });
    validateApiResponse(op.op, response);
    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : reasonCodeFromError(response.body),
      provider_id: response.ok ? (response.body.provider?.provider_id ?? null) : providerId,
      provider_type: response.ok ? (response.body.provider?.provider_type ?? null) : null
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'liquidityProviders.list') {
    const response = service.list({ actor, auth, query: op.query ?? {} });
    validateApiResponse(op.op, response);
    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : reasonCodeFromError(response.body),
      providers_count: response.ok ? (response.body.providers?.length ?? 0) : null,
      first_provider_id: response.ok ? (response.body.providers?.[0]?.provider_id ?? null) : null
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'liquidityProviders.persona.upsert') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.upsertPersona({
      actor,
      auth,
      providerId,
      idempotencyKey: op.idempotency_key,
      request
    });
    const response = out.result;
    validateApiResponse(op.op, response);
    const rec = {
      op: op.op,
      ok: response.ok,
      replayed: out.replayed,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : reasonCodeFromError(response.body),
      provider_id: response.ok ? (response.body.provider_id ?? null) : providerId,
      persona_id: response.ok ? (response.body.persona?.persona_id ?? null) : null
    };

    if (response.ok && typeof op.save_persona_ref === 'string') {
      refs.set(op.save_persona_ref, response.body.persona.persona_id);
    }

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

const final = {
  liquidity_provider_count: Object.keys(store.state.liquidity_providers ?? {}).length,
  liquidity_provider_persona_count: Object.keys(store.state.liquidity_provider_personas ?? {}).length,
  idempotency_keys_count: Object.keys(store.state.idempotency ?? {}).length,
  event_types_in_manifest: {
    liquidity_provider_registered: eventPayloadByType.has('liquidity_provider.registered'),
    liquidity_provider_persona_upserted: eventPayloadByType.has('liquidity_provider.persona_upserted')
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
