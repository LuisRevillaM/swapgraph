import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { PartnerCommercialService } from '../src/service/partnerCommercialService.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M82';
const SCENARIO_FILE = 'fixtures/commercial/m82_scenario.json';
const EXPECTED_FILE = 'fixtures/commercial/m82_expected.json';
const OUTPUT_FILE = 'risk_tier_policy_engine_output.json';

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

const service = new PartnerCommercialService({ store });
const operations = [];

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  if (op.op === 'partnerProgram.risk_tier_policy.upsert') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = service.upsertRiskTierPolicy({
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
      version: response.ok ? (response.body.policy?.version ?? null) : null,
      tier: response.ok ? (response.body.policy?.tier ?? null) : null,
      escalation_mode: response.ok ? (response.body.policy?.escalation_mode ?? null) : null,
      max_write_ops_per_hour: response.ok ? (response.body.policy?.max_write_ops_per_hour ?? null) : null,
      blocked_operations_count: response.ok ? (response.body.policy?.blocked_operations?.length ?? 0) : null,
      manual_review_operations_count: response.ok ? (response.body.policy?.manual_review_operations?.length ?? 0) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'partnerProgram.risk_tier_policy.get') {
    const query = clone(op.query ?? {});
    const response = service.getRiskTierPolicy({ actor, auth: op.auth ?? {}, query });
    validateApiResponse(op.op, response);

    const usageCounts = response.ok ? (response.body.usage_counts ?? {}) : {};
    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      version: response.ok ? (response.body.policy?.version ?? null) : null,
      tier: response.ok ? (response.body.policy?.tier ?? null) : null,
      escalation_mode: response.ok ? (response.body.policy?.escalation_mode ?? null) : null,
      max_write_ops_per_hour: response.ok ? (response.body.policy?.max_write_ops_per_hour ?? null) : null,
      usage_hour_bucket: response.ok ? (response.body.usage_hour_bucket ?? null) : null,
      usage_count_commercial_usage_record: response.ok ? (usageCounts['partnerProgram.commercial_usage.record'] ?? 0) : null,
      usage_count_oauth_client_register: response.ok ? (usageCounts['auth.oauth_client.register'] ?? 0) : null,
      usage_count_webhook_dead_letter_replay: response.ok ? (usageCounts['partnerProgram.webhook_dead_letter.replay'] ?? 0) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'partnerProgram.commercial_usage.record') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = service.recordCommercialUsage({
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
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'auth.oauth_client.register') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = service.registerOauthClient({
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
      client_id: response.ok ? (response.body.client?.client_id ?? null) : null,
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
  risk_tier_policy: clone(store.state.partner_program_risk_tier_policy ?? {}),
  risk_tier_usage_counters: clone(store.state.partner_program_risk_tier_usage_counters ?? {}),
  usage_ledger: clone(store.state.partner_program_commercial_usage_ledger ?? []),
  oauth_clients: clone(store.state.oauth_clients ?? {})
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
