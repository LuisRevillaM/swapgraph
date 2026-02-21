import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { ReliabilityConformanceService } from '../src/service/reliabilityConformanceService.mjs';
import { ReliabilityRemediationPlanningService } from '../src/service/reliabilityRemediationPlanningService.mjs';
import { verifyReliabilityRemediationPlanExportPayload } from '../src/crypto/policyIntegritySigning.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M96';
const SCENARIO_FILE = 'fixtures/reliability/m96_scenario.json';
const EXPECTED_FILE = 'fixtures/reliability/m96_expected.json';
const OUTPUT_FILE = 'reliability_remediation_planning_output.json';

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

const conformanceService = new ReliabilityConformanceService({ store });
const remediationService = new ReliabilityRemediationPlanningService({ store });

const operations = [];

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  if (op.op === 'reliability.slo.record') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = conformanceService.recordSloMetric({
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
      passing: response.ok ? (response.body.metric?.passing === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'reliability.incident_drill.record') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = conformanceService.recordIncidentDrill({
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
      outcome: response.ok ? (response.body.drill?.outcome ?? null) : null,
      within_target: response.ok ? (response.body.drill?.within_target === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'reliability.replay_check.record') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = conformanceService.recordReplayCheck({
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
      reason_code: response.ok ? (response.body.replay_check?.reason_code ?? null) : (response.body.error.details?.reason_code ?? null),
      replay_check_id: response.ok ? (response.body.replay_check?.replay_check_id ?? null) : null,
      passing: response.ok ? (response.body.replay_check?.passing === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'reliability.remediation_plan.suggest') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = remediationService.suggestPlan({
      actor,
      auth: op.auth ?? {},
      idempotencyKey: op.idempotency_key,
      request: op.request ?? {}
    });
    validateApiResponse(op.op, response);

    const plan = response.ok ? (response.body.plan ?? {}) : {};
    const signalSummary = response.ok ? (plan.signal_summary ?? {}) : {};

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      plan_id: response.ok ? (plan.plan_id ?? null) : null,
      status: response.ok ? (plan.status ?? null) : null,
      risk_level: response.ok ? (plan.risk_level ?? null) : null,
      priority_score: response.ok ? (plan.priority_score ?? null) : null,
      slo_total: response.ok ? (signalSummary.slo_total ?? null) : null,
      slo_failing: response.ok ? (signalSummary.slo_failing ?? null) : null,
      drills_total: response.ok ? (signalSummary.drills_total ?? null) : null,
      drills_failing: response.ok ? (signalSummary.drills_failing ?? null) : null,
      replay_checks_total: response.ok ? (signalSummary.replay_checks_total ?? null) : null,
      replay_checks_failing: response.ok ? (signalSummary.replay_checks_failing ?? null) : null,
      signal_count: response.ok ? (signalSummary.signal_count ?? null) : null,
      total_failing: response.ok ? (signalSummary.total_failing ?? null) : null,
      actions_count: response.ok ? (Array.isArray(plan.recommended_actions) ? plan.recommended_actions.length : null) : null,
      action_codes: response.ok ? (Array.isArray(plan.recommended_actions) ? plan.recommended_actions.map(x => x.action_code) : null) : null,
      blockers_count: response.ok ? (Array.isArray(plan.blockers) ? plan.blockers.length : null) : null,
      blocker_reason_codes: response.ok ? (Array.isArray(plan.blockers) ? plan.blockers.map(x => x.reason_code) : null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'reliability.remediation_plan.export') {
    const response = remediationService.exportPlans({
      actor,
      auth: op.auth ?? {},
      query: clone(op.query ?? {})
    });
    validateApiResponse(op.op, response);

    let signatureValid = null;
    let tamperSignatureValid = null;

    if (response.ok) {
      signatureValid = verifyReliabilityRemediationPlanExportPayload(response.body).ok;

      const tampered = clone(response.body);
      tampered.export_hash = tampered.export_hash.replace(/.$/, tampered.export_hash.endsWith('0') ? '1' : '0');
      tamperSignatureValid = verifyReliabilityRemediationPlanExportPayload(tampered).ok;
    }

    const summary = response.ok ? (response.body.summary ?? {}) : {};
    const plans = response.ok ? (response.body.plans ?? []) : [];

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      total_plans: response.ok ? (summary.total_plans ?? null) : null,
      returned_plans: response.ok ? (summary.returned_plans ?? null) : null,
      actionable_plans: response.ok ? (summary.actionable_plans ?? null) : null,
      critical_count: response.ok ? (summary.critical_count ?? null) : null,
      high_count: response.ok ? (summary.high_count ?? null) : null,
      medium_count: response.ok ? (summary.medium_count ?? null) : null,
      low_count: response.ok ? (summary.low_count ?? null) : null,
      total_filtered: response.ok ? (response.body.total_filtered ?? null) : null,
      plans_count: response.ok ? plans.length : null,
      first_plan_id: response.ok && plans.length > 0 ? (plans[0].plan_id ?? null) : null,
      last_plan_id: response.ok && plans.length > 0 ? (plans[plans.length - 1].plan_id ?? null) : null,
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
  reliability_slo_metrics: clone(store.state.reliability_slo_metrics ?? []),
  reliability_incident_drills: clone(store.state.reliability_incident_drills ?? []),
  reliability_replay_checks: clone(store.state.reliability_replay_checks ?? []),
  reliability_remediation_plans: clone(store.state.reliability_remediation_plans ?? []),
  reliability_remediation_plan_counter: clone(store.state.reliability_remediation_plan_counter ?? 0)
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
