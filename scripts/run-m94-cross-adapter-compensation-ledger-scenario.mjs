import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { CrossAdapterCompensationLedgerService } from '../src/service/crossAdapterCompensationLedgerService.mjs';
import { verifyCrossAdapterCompensationLedgerExportPayload } from '../src/crypto/policyIntegritySigning.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M94';
const SCENARIO_FILE = 'fixtures/compensation/m94_scenario.json';
const EXPECTED_FILE = 'fixtures/compensation/m94_expected.json';
const OUTPUT_FILE = 'cross_adapter_compensation_ledger_output.json';

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

function seedCases(store, cases) {
  store.state.cross_adapter_compensation_cases ||= {};
  for (const row of cases ?? []) {
    store.state.cross_adapter_compensation_cases[row.case_id] = clone(row);
  }
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const actors = scenario.actors ?? {};

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();
seedCases(store, scenario.seed_cases ?? []);

const service = new CrossAdapterCompensationLedgerService({ store });
const operations = [];

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  if (op.op === 'compensation.cross_adapter.ledger.record') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = service.recordLedgerEntry({
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
      entry_id: response.ok ? (response.body.entry?.entry_id ?? null) : null,
      case_id: response.ok ? (response.body.entry?.case_id ?? null) : null,
      case_status: response.ok ? (response.body.case?.status ?? null) : null,
      entry_type: response.ok ? (response.body.entry?.entry_type ?? null) : null,
      amount_usd_micros: response.ok ? (response.body.entry?.amount_usd_micros ?? null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'compensation.cross_adapter.ledger.export') {
    const response = service.exportLedger({
      actor,
      auth: op.auth ?? {},
      query: clone(op.query ?? {})
    });
    validateApiResponse(op.op, response);

    let signatureValid = null;
    let tamperSignatureValid = null;

    if (response.ok) {
      signatureValid = verifyCrossAdapterCompensationLedgerExportPayload(response.body).ok;
      const tampered = clone(response.body);
      tampered.export_hash = tampered.export_hash.replace(/.$/, tampered.export_hash.endsWith('0') ? '1' : '0');
      tamperSignatureValid = verifyCrossAdapterCompensationLedgerExportPayload(tampered).ok;
    }

    const summary = response.ok ? (response.body.summary ?? {}) : {};
    const entries = response.ok ? (response.body.entries ?? []) : [];

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      total_entries: response.ok ? (summary.total_entries ?? null) : null,
      returned_entries: response.ok ? (summary.returned_entries ?? null) : null,
      total_amount_usd_micros: response.ok ? (summary.total_amount_usd_micros ?? null) : null,
      returned_amount_usd_micros: response.ok ? (summary.returned_amount_usd_micros ?? null) : null,
      total_filtered: response.ok ? (response.body.total_filtered ?? null) : null,
      entries_count: response.ok ? entries.length : null,
      first_entry_id: response.ok && entries.length > 0 ? (entries[0].entry_id ?? null) : null,
      last_entry_id: response.ok && entries.length > 0 ? (entries[entries.length - 1].entry_id ?? null) : null,
      next_cursor_present: response.ok ? (typeof response.body.next_cursor === 'string' && response.body.next_cursor.length > 0) : null,
      signature_valid: response.ok ? signatureValid : null,
      tamper_signature_valid: response.ok ? tamperSignatureValid : null,
      attestation_present: response.ok ? (response.body.attestation && typeof response.body.attestation === 'object') : null,
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
  cross_adapter_compensation_ledger: clone(store.state.cross_adapter_compensation_ledger ?? []),
  cross_adapter_compensation_ledger_counter: clone(store.state.cross_adapter_compensation_ledger_counter ?? 0)
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
