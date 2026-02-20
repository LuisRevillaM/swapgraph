import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { CrossAdapterDisputeLinkageService } from '../src/service/crossAdapterDisputeLinkageService.mjs';
import { verifyDisputeCompensationLinkageExportPayload } from '../src/crypto/policyIntegritySigning.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M95';
const SCENARIO_FILE = 'fixtures/compensation/m95_scenario.json';
const EXPECTED_FILE = 'fixtures/compensation/m95_expected.json';
const OUTPUT_FILE = 'dispute_compensation_linkage_output.json';

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

function seedData(store, scenario) {
  store.state.partner_program_disputes = clone(scenario.seed_disputes ?? []);
  store.state.cross_adapter_compensation_cases ||= {};
  store.state.cross_adapter_compensation_ledger ||= [];
  store.state.cross_adapter_dispute_linkages ||= [];
  store.state.cross_adapter_dispute_linkage_counter ||= 0;

  for (const row of scenario.seed_cases ?? []) {
    store.state.cross_adapter_compensation_cases[row.case_id] = clone(row);
  }

  store.state.cross_adapter_compensation_ledger = clone(scenario.seed_ledger_entries ?? []);
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const actors = scenario.actors ?? {};

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();
seedData(store, scenario);

const service = new CrossAdapterDisputeLinkageService({ store });
const operations = [];

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  if (op.op === 'compensation.dispute_linkage.record') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = service.recordLinkage({
      actor,
      auth: op.auth ?? {},
      idempotencyKey: op.idempotency_key,
      request: op.request ?? {}
    });
    validateApiResponse(op.op, response);

    const linkage = response.ok ? response.body.linkage : null;
    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      linkage_id: response.ok ? (linkage?.linkage_id ?? null) : null,
      status: response.ok ? (linkage?.status ?? null) : null,
      ledger_entry_id: response.ok ? (linkage?.ledger_entry_id ?? null) : null,
      closed_at_present: response.ok ? (typeof linkage?.closed_at === 'string' && linkage.closed_at.length > 0) : null,
      history_length: response.ok ? (Array.isArray(linkage?.history) ? linkage.history.length : null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'compensation.dispute_linkage.update') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = service.updateLinkage({
      actor,
      auth: op.auth ?? {},
      idempotencyKey: op.idempotency_key,
      request: op.request ?? {}
    });
    validateApiResponse(op.op, response);

    const linkage = response.ok ? response.body.linkage : null;
    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      linkage_id: response.ok ? (linkage?.linkage_id ?? null) : null,
      status: response.ok ? (linkage?.status ?? null) : null,
      ledger_entry_id: response.ok ? (linkage?.ledger_entry_id ?? null) : null,
      closed_at_present: response.ok ? (typeof linkage?.closed_at === 'string' && linkage.closed_at.length > 0) : null,
      history_length: response.ok ? (Array.isArray(linkage?.history) ? linkage.history.length : null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'compensation.dispute_linkage.export') {
    const response = service.exportLinkages({
      actor,
      auth: op.auth ?? {},
      query: clone(op.query ?? {})
    });
    validateApiResponse(op.op, response);

    let signatureValid = null;
    let tamperSignatureValid = null;

    if (response.ok) {
      signatureValid = verifyDisputeCompensationLinkageExportPayload(response.body).ok;
      const tampered = clone(response.body);
      tampered.export_hash = tampered.export_hash.replace(/.$/, tampered.export_hash.endsWith('0') ? '1' : '0');
      tamperSignatureValid = verifyDisputeCompensationLinkageExportPayload(tampered).ok;
    }

    const summary = response.ok ? (response.body.summary ?? {}) : {};
    const linkages = response.ok ? (response.body.linkages ?? []) : [];

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      total_linkages: response.ok ? (summary.total_linkages ?? null) : null,
      returned_linkages: response.ok ? (summary.returned_linkages ?? null) : null,
      linked_to_ledger_count: response.ok ? (summary.linked_to_ledger_count ?? null) : null,
      closed_count: response.ok ? (summary.closed_count ?? null) : null,
      total_filtered: response.ok ? (response.body.total_filtered ?? null) : null,
      linkages_count: response.ok ? linkages.length : null,
      first_linkage_id: response.ok && linkages.length > 0 ? (linkages[0].linkage_id ?? null) : null,
      last_linkage_id: response.ok && linkages.length > 0 ? (linkages[linkages.length - 1].linkage_id ?? null) : null,
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
  cross_adapter_dispute_linkages: clone(store.state.cross_adapter_dispute_linkages ?? []),
  cross_adapter_dispute_linkage_counter: clone(store.state.cross_adapter_dispute_linkage_counter ?? 0)
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
