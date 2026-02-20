import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { Tier2AdapterCapabilityService } from '../src/service/tier2AdapterCapabilityService.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M89';
const SCENARIO_FILE = 'fixtures/adapters/m89_scenario.json';
const EXPECTED_FILE = 'fixtures/adapters/m89_expected.json';
const OUTPUT_FILE = 'tier2_adapter_capability_output.json';

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
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(e => [e.operation_id, e]));

function endpointFor(operationId) {
  const ep = endpointsByOp.get(operationId);
  if (!ep) throw new Error(`missing endpoint for operation_id=${operationId}`);
  return ep;
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
    assert.deepEqual(rec[field], v);
  }
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const actors = scenario.actors ?? {};

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();

const service = new Tier2AdapterCapabilityService({ store });
const operations = [];

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  if (op.op === 'adapter.tier2.capability.upsert') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = service.upsertCapability({
      actor,
      auth: op.auth ?? {},
      idempotencyKey: op.idempotency_key,
      request: op.request ?? {}
    });
    validateApiResponse(op.op, response);

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      version: response.ok ? (response.body.capability?.version ?? null) : null,
      source_ecosystem: response.ok ? (response.body.capability?.source_ecosystem ?? null) : null,
      target_ecosystem: response.ok ? (response.body.capability?.target_ecosystem ?? null) : null,
      max_route_hops: response.ok ? (response.body.capability?.max_route_hops ?? null) : null,
      dry_run_only: response.ok ? (response.body.capability?.dry_run_only === true) : null,
      transfer_primitives_count: response.ok ? (response.body.capability?.transfer_primitives?.length ?? 0) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'adapter.tier2.capability.get') {
    const query = clone(op.query ?? {});
    const response = service.getCapability({ actor, auth: op.auth ?? {}, query });
    validateApiResponse(op.op, response);

    const summary = response.ok ? (response.body.preflight_summary ?? {}) : {};

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      capability_version: response.ok ? (response.body.capability?.version ?? null) : null,
      capability_source_ecosystem: response.ok ? (response.body.capability?.source_ecosystem ?? null) : null,
      capability_target_ecosystem: response.ok ? (response.body.capability?.target_ecosystem ?? null) : null,
      capability_max_route_hops: response.ok ? (response.body.capability?.max_route_hops ?? null) : null,
      capability_dry_run_only: response.ok ? (response.body.capability?.dry_run_only === true) : false,
      preflight_total_preflight_requests: response.ok ? (summary.total_preflight_requests ?? null) : null,
      preflight_ready_count: response.ok ? (summary.ready_count ?? null) : null,
      preflight_blocked_count: response.ok ? (summary.blocked_count ?? null) : null,
      integration_mode: response.ok ? (response.body.integration_mode ?? null) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'adapter.tier2.preflight') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = service.preflightCapability({
      actor,
      auth: op.auth ?? {},
      idempotencyKey: op.idempotency_key,
      request: op.request ?? {}
    });
    validateApiResponse(op.op, response);

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      preflight_id: response.ok ? (response.body.preflight?.preflight_id ?? null) : null,
      contract_version: response.ok ? (response.body.preflight?.contract_version ?? null) : null,
      ready: response.ok ? (response.body.preflight?.ready === true) : null,
      preflight_reason_code: response.ok ? (response.body.preflight?.reason_code ?? null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

store.save();

const final = {
  tier2_adapter_capabilities: clone(store.state.tier2_adapter_capabilities ?? {}),
  tier2_adapter_preflight_history: clone(store.state.tier2_adapter_preflight_history ?? [])
};

const out = canonicalize({ operations, final });
writeFileSync(path.join(outDir, OUTPUT_FILE), JSON.stringify(out, null, 2));

const outHash = createHash('sha256').update(JSON.stringify(out), 'utf8').digest('hex');
if (typeof expected?.expected_sha256 === 'string' && expected.expected_sha256.trim()) {
  assert.equal(outHash, expected.expected_sha256.trim());
} else {
  assert.deepEqual(out, expected);
}

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: MILESTONE, status: 'pass' }, null, 2));
console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
