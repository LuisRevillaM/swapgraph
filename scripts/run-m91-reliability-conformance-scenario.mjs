import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { ReliabilityConformanceService } from '../src/service/reliabilityConformanceService.mjs';
import { verifyPolicyIntegrityPayloadSignature } from '../src/crypto/policyIntegritySigning.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M91';
const SCENARIO_FILE = 'fixtures/reliability/m91_scenario.json';
const EXPECTED_FILE = 'fixtures/reliability/m91_expected.json';
const OUTPUT_FILE = 'reliability_conformance_output.json';

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

const service = new ReliabilityConformanceService({ store });
const operations = [];

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  if (op.op === 'reliability.slo.record') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = service.recordSloMetric({
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
      metric_id: response.ok ? (response.body.metric?.metric_id ?? null) : null,
      service_id: response.ok ? (response.body.metric?.service_id ?? null) : null,
      passing: response.ok ? (response.body.metric?.passing === true) : null,
      breach_reasons: response.ok ? (response.body.metric?.breach_reasons ?? null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'reliability.incident_drill.record') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = service.recordIncidentDrill({
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
      drill_record_id: response.ok ? (response.body.drill?.drill_record_id ?? null) : null,
      drill_type: response.ok ? (response.body.drill?.drill_type ?? null) : null,
      outcome: response.ok ? (response.body.drill?.outcome ?? null) : null,
      within_target: response.ok ? (response.body.drill?.within_target === true) : null,
      recovery_time_minutes: response.ok ? (response.body.drill?.recovery_time_minutes ?? null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'reliability.replay_check.record') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = service.recordReplayCheck({
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
      replay_check_id: response.ok ? (response.body.replay_check?.replay_check_id ?? null) : null,
      scenario_id: response.ok ? (response.body.replay_check?.scenario_id ?? null) : null,
      passing: response.ok ? (response.body.replay_check?.passing === true) : null,
      reason_code_check: response.ok ? (response.body.replay_check?.reason_code ?? null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    if (response.ok) rec.reason_code = rec.reason_code_check;

    delete rec.reason_code_check;

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'reliability.conformance.export') {
    const response = service.exportConformance({
      actor,
      auth: op.auth ?? {},
      query: clone(op.query ?? {})
    });
    validateApiResponse(op.op, response);

    let signatureValid = null;
    let tamperSignatureValid = null;

    if (response.ok) {
      signatureValid = verifyPolicyIntegrityPayloadSignature(response.body).ok;

      const tampered = clone(response.body);
      tampered.export_hash = tampered.export_hash.replace(/.$/, tampered.export_hash.endsWith('0') ? '1' : '0');
      tamperSignatureValid = verifyPolicyIntegrityPayloadSignature(tampered).ok;
    }

    const summary = response.ok ? (response.body.summary ?? {}) : {};

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      slo_total: response.ok ? (summary.slo_total ?? null) : null,
      slo_passing: response.ok ? (summary.slo_passing ?? null) : null,
      slo_failing: response.ok ? (summary.slo_failing ?? null) : null,
      drills_total: response.ok ? (summary.drills_total ?? null) : null,
      drills_passing: response.ok ? (summary.drills_passing ?? null) : null,
      drills_failing: response.ok ? (summary.drills_failing ?? null) : null,
      replay_checks_total: response.ok ? (summary.replay_checks_total ?? null) : null,
      replay_checks_passing: response.ok ? (summary.replay_checks_passing ?? null) : null,
      replay_checks_failing: response.ok ? (summary.replay_checks_failing ?? null) : null,
      overall_passing: response.ok ? (summary.overall_passing === true) : null,
      signature_valid: response.ok ? signatureValid : null,
      tamper_signature_valid: response.ok ? tamperSignatureValid : null,
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
  reliability_slo_metrics: clone(store.state.reliability_slo_metrics ?? []),
  reliability_incident_drills: clone(store.state.reliability_incident_drills ?? []),
  reliability_replay_checks: clone(store.state.reliability_replay_checks ?? [])
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
