import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { Tier2AdapterCapabilityService } from '../src/service/tier2AdapterCapabilityService.mjs';
import { CrossAdapterCycleService } from '../src/service/crossAdapterCycleService.mjs';
import { signReceipt } from '../src/crypto/receiptSigning.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M90';
const SCENARIO_FILE = 'fixtures/adapters/m90_scenario.json';
const EXPECTED_FILE = 'fixtures/adapters/m90_expected.json';
const OUTPUT_FILE = 'cross_adapter_cycle_semantics_receipts_output.json';

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

function seedSettlementReceipts(store, seeds) {
  for (const seed of seeds ?? []) {
    const cycleId = seed?.cycle_id;
    if (typeof cycleId !== 'string' || !cycleId.trim()) throw new Error('seed settlement receipt missing cycle_id');

    const receipt = seed?.receipt ?? {};
    const unsigned = {
      id: receipt.id,
      cycle_id: cycleId,
      final_state: receipt.final_state,
      intent_ids: Array.isArray(receipt.intent_ids) ? receipt.intent_ids : [],
      asset_ids: Array.isArray(receipt.asset_ids) ? receipt.asset_ids : [],
      created_at: receipt.created_at,
      ...(receipt.transparency && typeof receipt.transparency === 'object' ? { transparency: receipt.transparency } : {})
    };

    const signed = {
      ...unsigned,
      signature: signReceipt(unsigned)
    };

    if (seed.tamper_signature === true) {
      signed.final_state = signed.final_state === 'completed' ? 'failed' : 'completed';
    }

    store.state.receipts[cycleId] = signed;
  }
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const actors = scenario.actors ?? {};

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();
seedSettlementReceipts(store, scenario.seed_settlement_receipts ?? []);

const tier2Service = new Tier2AdapterCapabilityService({ store });
const crossService = new CrossAdapterCycleService({ store });
const operations = [];

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  if (op.op === 'adapter.tier2.capability.upsert') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = tier2Service.upsertCapability({
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
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'adapter.tier2.preflight') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = tier2Service.preflightCapability({
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
      ready: response.ok ? (response.body.preflight?.ready === true) : null,
      preflight_reason_code: response.ok ? (response.body.preflight?.reason_code ?? null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'adapter.cross_cycle.semantics.record') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = crossService.recordCycleSemantics({
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
      semantics_version: response.ok ? (response.body.semantics?.version ?? null) : null,
      preflight_id: response.ok ? (response.body.semantics?.preflight_id ?? null) : null,
      execution_model: response.ok ? (response.body.semantics?.execution_model ?? null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'adapter.cross_cycle.receipt.record') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = crossService.recordCrossCycleReceipt({
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
      cross_receipt_id: response.ok ? (response.body.cross_receipt?.cross_receipt_id ?? null) : null,
      semantics_version: response.ok ? (response.body.cross_receipt?.semantics_version ?? null) : null,
      settlement_receipt_id: response.ok ? (response.body.cross_receipt?.settlement_receipt_id ?? null) : null,
      discrepancy_code: response.ok ? (response.body.cross_receipt?.discrepancy_code ?? null) : null,
      compensation_required: response.ok ? (response.body.cross_receipt?.compensation_required === true) : null,
      signature_key_id: response.ok ? (response.body.cross_receipt?.signature?.key_id ?? null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'adapter.cross_cycle.receipt.get') {
    const response = crossService.getCrossCycleReceipt({
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
      has_semantics: response.ok ? (response.body.semantics !== null) : null,
      has_cross_receipt: response.ok ? (response.body.cross_receipt !== null) : null,
      semantics_version: response.ok ? (response.body.semantics?.version ?? null) : null,
      discrepancy_code: response.ok ? (response.body.cross_receipt?.discrepancy_code ?? null) : null,
      signature_valid: response.ok ? (response.body.signature_valid === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

store.save();

const final = {
  tier2_adapter_preflight_history: clone(store.state.tier2_adapter_preflight_history ?? []),
  cross_adapter_cycle_semantics: clone(store.state.cross_adapter_cycle_semantics ?? {}),
  cross_adapter_cycle_receipts: clone(store.state.cross_adapter_cycle_receipts ?? {}),
  settlement_receipts: clone(store.state.receipts ?? {})
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
