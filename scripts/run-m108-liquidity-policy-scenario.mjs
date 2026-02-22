import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { LiquidityAutonomyPolicyService } from '../src/service/liquidityAutonomyPolicyService.mjs';
import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M108';
const SCENARIO_FILE = 'fixtures/release/m108_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m108_expected.json';
const OUTPUT_FILE = 'liquidity_policy_output.json';

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

function applyExpectations(op, rec) {
  for (const [key, value] of Object.entries(op)) {
    if (!key.startsWith('expect_')) continue;
    const field = key.slice('expect_'.length);
    assert.deepEqual(rec[field], value, `expectation_failed op=${op.op} field=${field}`);
  }
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

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const actors = scenario.actors ?? {};

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();
for (const [key, value] of Object.entries(scenario.seed_state ?? {})) {
  store.state[key] = clone(value);
}

store.state.idempotency ||= {};
store.state.liquidity_policies ||= {};
store.state.liquidity_policy_decision_audit ||= [];
store.state.liquidity_policy_decision_audit_counter ||= 0;
store.state.liquidity_policy_export_checkpoints ||= {};
store.state.liquidity_policy_daily_usage ||= {};
store.state.liquidity_policy_counterparty_exposure ||= {};

const service = new LiquidityAutonomyPolicyService({ store });

const operations = [];
const refs = new Map();

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);
  const auth = op.auth ?? {};
  const providerId = op.provider_id_ref ? refs.get(op.provider_id_ref) : op.provider_id;

  let response;
  let replayed = null;

  if (op.op === 'liquidityPolicy.upsert') {
    const request = resolveRefs(clone(op.request ?? {}), refs);
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.upsertPolicy({ actor, auth, providerId, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'liquidityPolicy.get') {
    response = service.getPolicy({ actor, auth, providerId });
  } else if (op.op === 'liquidityPolicy.evaluate') {
    const request = resolveRefs(clone(op.request ?? {}), refs);
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.evaluatePolicy({ actor, auth, providerId, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'liquidityDecision.audit.list') {
    const query = resolveRefs(clone(op.query ?? {}), refs);
    response = service.listDecisionAudit({ actor, auth, providerId, query });
  } else if (op.op === 'liquidityDecision.audit.export') {
    const query = resolveRefs(clone(op.query ?? {}), refs);
    response = service.exportDecisionAudit({ actor, auth, providerId, query });
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

  if ((op.op === 'liquidityPolicy.get' || op.op === 'liquidityPolicy.upsert') && response.ok) {
    rec.provider_id = response.body.provider_id ?? null;
    rec.policy_id = response.body.policy?.policy_id ?? null;
    rec.policy_version = response.body.policy?.version ?? null;
    rec.policy_mode = response.body.policy?.policy_mode ?? null;
    rec.high_volatility_mode = response.body.policy?.high_volatility_mode ?? null;
    rec.max_spread_bps = response.body.policy?.max_spread_bps ?? null;
    rec.policy_constraints_hash = response.body.policy?.policy_ref?.constraints_hash ?? null;

    if (typeof op.save_provider_ref === 'string') refs.set(op.save_provider_ref, rec.provider_id);
    if (typeof op.save_policy_ref === 'string') refs.set(op.save_policy_ref, clone(response.body.policy?.policy_ref ?? null));
  }

  if (op.op === 'liquidityPolicy.evaluate' && response.ok) {
    rec.provider_id = response.body.provider_id ?? null;
    rec.evaluation_id = response.body.evaluation?.evaluation_id ?? null;
    rec.audit_id = response.body.evaluation?.audit_id ?? null;
    rec.verdict = response.body.evaluation?.verdict ?? null;
    rec.reason_codes = clone(response.body.evaluation?.reason_codes ?? []);
    rec.reason_codes_count = rec.reason_codes.length;
    rec.policy_version = response.body.evaluation?.policy_version ?? null;
    rec.effective_max_spread_bps = response.body.evaluation?.effective_max_spread_bps ?? null;

    if (typeof op.save_audit_ref === 'string') refs.set(op.save_audit_ref, rec.audit_id);
  }

  if (op.op === 'liquidityDecision.audit.list' && response.ok) {
    const entries = response.body.entries ?? [];
    rec.provider_id = response.body.provider_id ?? null;
    rec.total_filtered = response.body.total_filtered ?? null;
    rec.entries_count = entries.length;
    rec.next_cursor = response.body.next_cursor ?? null;
    rec.first_audit_id = entries[0]?.audit_id ?? null;
    rec.last_audit_id = entries.at(-1)?.audit_id ?? null;
    rec.first_counterparty_actor_id = entries[0]?.input_summary?.counterparty_actor_id ?? null;

    if (typeof op.save_cursor_ref === 'string' && rec.next_cursor) refs.set(op.save_cursor_ref, rec.next_cursor);
  }

  if (op.op === 'liquidityDecision.audit.export' && response.ok) {
    const exported = response.body.export ?? {};
    const entries = Array.isArray(exported.entries) ? exported.entries : [];
    rec.provider_id = response.body.provider_id ?? null;
    rec.total_filtered = exported.total_filtered ?? null;
    rec.entries_count = entries.length;
    rec.next_cursor = exported.next_cursor ?? null;
    rec.attestation_chain_hash = exported.attestation?.chain_hash ?? null;
    rec.checkpoint_hash = exported.checkpoint?.checkpoint_hash ?? null;
    rec.first_audit_id = entries[0]?.audit_id ?? null;
    rec.first_counterparty_actor_id = entries[0]?.input_summary?.counterparty_actor_id ?? null;

    if (typeof op.save_cursor_ref === 'string' && rec.next_cursor) refs.set(op.save_cursor_ref, rec.next_cursor);
    if (typeof op.save_attestation_ref === 'string' && rec.attestation_chain_hash) refs.set(op.save_attestation_ref, rec.attestation_chain_hash);
    if (typeof op.save_checkpoint_ref === 'string' && rec.checkpoint_hash) refs.set(op.save_checkpoint_ref, rec.checkpoint_hash);
  }

  operations.push(rec);
  applyExpectations(op, rec);
}

store.save();

const liquidityPolicyExportCheckpointsCount = Object.values(store.state.liquidity_policy_export_checkpoints ?? {})
  .reduce((sum, rows) => sum + Object.keys(rows ?? {}).length, 0);

const final = {
  liquidity_policies_count: Object.keys(store.state.liquidity_policies ?? {}).length,
  liquidity_policy_decision_audit_count: Array.isArray(store.state.liquidity_policy_decision_audit) ? store.state.liquidity_policy_decision_audit.length : 0,
  liquidity_policy_export_checkpoints_count: liquidityPolicyExportCheckpointsCount,
  idempotency_keys_count: Object.keys(store.state.idempotency ?? {}).length
};

const out = canonicalize({ operations, final });

writeFileSync(path.join(outDir, OUTPUT_FILE), JSON.stringify(out, null, 2));

const outHash = sha256HexCanonical(out);
if (typeof expected?.expected_sha256 === 'string' && expected.expected_sha256.trim()) {
  assert.equal(outHash, expected.expected_sha256.trim());
} else {
  assert.deepEqual(out, expected);
}

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: MILESTONE, status: 'pass' }, null, 2));
console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
