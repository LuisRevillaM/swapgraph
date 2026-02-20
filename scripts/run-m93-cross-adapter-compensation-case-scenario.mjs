import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { CrossAdapterCompensationService } from '../src/service/crossAdapterCompensationService.mjs';
import { signReceipt } from '../src/crypto/receiptSigning.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M93';
const SCENARIO_FILE = 'fixtures/compensation/m93_scenario.json';
const EXPECTED_FILE = 'fixtures/compensation/m93_expected.json';
const OUTPUT_FILE = 'cross_adapter_compensation_case_output.json';

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

function seedCrossReceipts(store, seeds) {
  store.state.cross_adapter_cycle_receipts ||= {};

  for (const seed of seeds ?? []) {
    const cycleId = seed?.cycle_id;
    if (typeof cycleId !== 'string' || !cycleId.trim()) throw new Error('seed cross receipt missing cycle_id');

    const unsigned = clone(seed?.receipt ?? {});
    const signed = {
      ...unsigned,
      signature: signReceipt(unsigned)
    };

    if (seed.tamper_signature === true) {
      signed.target_leg_status = signed.target_leg_status === 'completed' ? 'failed' : 'completed';
    }

    store.state.cross_adapter_cycle_receipts[cycleId] = signed;
  }
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const actors = scenario.actors ?? {};

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();
seedCrossReceipts(store, scenario.seed_cross_receipts ?? []);

const service = new CrossAdapterCompensationService({ store });
const operations = [];

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  if (op.op === 'compensation.cross_adapter.case.create') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = service.createCase({
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
      case_id: response.ok ? (response.body.case?.case_id ?? null) : null,
      status: response.ok ? (response.body.case?.status ?? null) : null,
      decision_reason_code: response.ok ? (response.body.case?.decision_reason_code ?? null) : null,
      approved_amount_usd_micros: response.ok ? (response.body.case?.approved_amount_usd_micros ?? null) : null,
      resolution_reference: response.ok ? (response.body.case?.resolution_reference ?? null) : null,
      history_length: response.ok ? (response.body.case?.history?.length ?? null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'compensation.cross_adapter.case.update') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = service.updateCase({
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
      case_id: response.ok ? (response.body.case?.case_id ?? null) : null,
      status: response.ok ? (response.body.case?.status ?? null) : null,
      decision_reason_code: response.ok ? (response.body.case?.decision_reason_code ?? null) : null,
      approved_amount_usd_micros: response.ok ? (response.body.case?.approved_amount_usd_micros ?? null) : null,
      resolution_reference: response.ok ? (response.body.case?.resolution_reference ?? null) : null,
      history_length: response.ok ? (response.body.case?.history?.length ?? null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'compensation.cross_adapter.case.get') {
    const response = service.getCase({
      actor,
      auth: op.auth ?? {},
      query: clone(op.query ?? {})
    });
    validateApiResponse(op.op, response);

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      has_case: response.ok ? (response.body.case !== null) : null,
      case_id: response.ok ? (response.body.case?.case_id ?? null) : null,
      status: response.ok ? (response.body.case?.status ?? null) : null,
      decision_reason_code: response.ok ? (response.body.case?.decision_reason_code ?? null) : null,
      approved_amount_usd_micros: response.ok ? (response.body.case?.approved_amount_usd_micros ?? null) : null,
      resolution_reference: response.ok ? (response.body.case?.resolution_reference ?? null) : null,
      integration_mode: response.ok ? (response.body.integration_mode ?? null) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

store.save();

const final = {
  cross_adapter_compensation_cases: clone(store.state.cross_adapter_compensation_cases ?? {}),
  cross_adapter_compensation_case_counter: clone(store.state.cross_adapter_compensation_case_counter ?? 0),
  cross_adapter_cycle_receipts: clone(store.state.cross_adapter_cycle_receipts ?? {})
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
