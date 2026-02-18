import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { DelegationsService } from '../src/service/delegationsService.mjs';
import { SwapIntentsService } from '../src/service/swapIntentsService.mjs';
import { PolicyAuditReadService } from '../src/read/policyAuditReadService.mjs';
import { parseAuthHeaders } from '../src/core/authHeaders.mjs';
import { buildConsentProofBinding } from '../src/core/tradingPolicyBoundaries.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const root = process.cwd();
const outDir = process.env.OUT_DIR;
if (!outDir) {
  console.error('Missing OUT_DIR env');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

if (process.env.AUTHZ_ENFORCE !== '1') {
  console.error('AUTHZ_ENFORCE must be 1 for M40 scenario');
  process.exit(2);
}
if (process.env.POLICY_CONSENT_TIER_ENFORCE !== '1') {
  console.error('POLICY_CONSENT_TIER_ENFORCE must be 1 for M40 scenario');
  process.exit(2);
}
if (process.env.POLICY_CONSENT_PROOF_BIND_ENFORCE !== '1') {
  console.error('POLICY_CONSENT_PROOF_BIND_ENFORCE must be 1 for M40 scenario');
  process.exit(2);
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

const apiManifest = readJson(path.join(root, 'docs/spec/api/manifest.v1.json'));
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(e => [e.operation_id, e]));

const schemasDir = path.join(root, 'docs/spec/schemas');
const schemaFiles = readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const sf of schemaFiles) ajv.addSchema(readJson(path.join(schemasDir, sf)));

function validateAgainstSchemaFile(schemaFile, payload) {
  const schema = readJson(path.join(schemasDir, schemaFile));
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  const ok = validate(payload);
  return { ok, errors: validate.errors ?? [] };
}

function endpointFor(operationId) {
  const ep = endpointsByOp.get(operationId);
  if (!ep) throw new Error(`missing endpoint for operation_id=${operationId}`);
  return ep;
}

function validateResponseOrError({ endpoint, opName, response }) {
  if (response.ok) {
    const vr = validateAgainstSchemaFile(endpoint.response_schema, response.body);
    if (!vr.ok) throw new Error(`response invalid for op=${opName}: ${JSON.stringify(vr.errors)}`);
  } else {
    const ve = validateAgainstSchemaFile('ErrorResponse.schema.json', response.body);
    if (!ve.ok) throw new Error(`error response invalid for op=${opName}: ${JSON.stringify(ve.errors)}`);
  }
}

function withConsentProofBinding({ userConsent, subjectActor, intent, delegationId }) {
  if (!userConsent || typeof userConsent !== 'object') return userConsent;

  const out = JSON.parse(JSON.stringify(userConsent));
  const mode = out.consent_proof_mode;
  delete out.consent_proof_mode;

  if (!mode) return out;

  if (mode === 'bound' || mode === 'mismatch') {
    const boundIntent = mode === 'bound' ? intent : { ...intent, id: `${intent.id}_other` };
    out.consent_proof = buildConsentProofBinding({
      consentId: out.consent_id,
      subjectActor,
      delegationId,
      intent: boundIntent
    });
    return out;
  }

  return out;
}

const scenario = readJson(path.join(root, 'fixtures/delegation/m40_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/delegation/m40_expected.json'));

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();
store.save();

const delegationsSvc = new DelegationsService({ store });
const intentsSvc = new SwapIntentsService({ store });
const policyAuditSvc = new PolicyAuditReadService({ store });

const actors = scenario.actors ?? {};
const tokenRefs = {};
const operations = [];

for (const op of scenario.operations ?? []) {
  if (op.op === 'delegations.create') {
    const endpoint = endpointFor('delegations.create');
    const actor = actors?.[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

    const vreq = validateAgainstSchemaFile(endpoint.request_schema, op.request);
    if (!vreq.ok) throw new Error(`request invalid for op=${op.op}: ${JSON.stringify(vreq.errors)}`);

    const r = delegationsSvc.create({
      actor,
      auth: op.auth ?? {},
      idempotencyKey: op.idempotency_key,
      requestBody: op.request,
      occurredAt: op.occurred_at
    });

    const response = r.result;
    validateResponseOrError({ endpoint, opName: op.op, response });

    if (response.ok) tokenRefs[op.save_token_ref ?? 'created'] = response.body.delegation_token;

    const rec = {
      op: op.op,
      actor,
      ok: response.ok,
      replayed: r.replayed,
      error_code: response.ok ? null : response.body.error.code,
      delegation_id: op.request?.delegation?.delegation_id ?? null
    };
    operations.push(rec);

    if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
    continue;
  }

  if (op.op === 'authHeaders.parse') {
    const token = tokenRefs[op.token_ref];
    if (!token) throw new Error(`missing token_ref: ${op.token_ref}`);

    const parsed = parseAuthHeaders({ headers: { Authorization: `Bearer ${token}` } });

    const rec = {
      op: op.op,
      ok: parsed.ok,
      error_code: parsed.ok ? null : parsed.error.code,
      actor: parsed.ok ? parsed.actor : null
    };
    operations.push(rec);

    if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
    if (rec.ok && op.expect_actor) assert.deepEqual(rec.actor, op.expect_actor);
    if (!rec.ok && op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
    continue;
  }

  if (op.op === 'swapIntents.create.via_token' || op.op === 'policyAudit.list.via_token') {
    const token = tokenRefs[op.token_ref];
    if (!token) throw new Error(`missing token_ref: ${op.token_ref}`);

    const headers = { Authorization: `Bearer ${token}` };
    if (op.auth?.now_iso) headers['X-Now-Iso'] = op.auth.now_iso;
    const parsed = parseAuthHeaders({ headers });

    if (!parsed.ok) {
      const rec = { op: op.op, parse_ok: false, ok: false, error_code: parsed.error.code };
      operations.push(rec);
      if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
      if (op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
      continue;
    }

    if (op.op === 'swapIntents.create.via_token') {
      const endpoint = endpointFor('swapIntents.create');
      const vreq = validateAgainstSchemaFile(endpoint.request_schema, op.request);
      if (!vreq.ok) throw new Error(`request invalid for op=${op.op}: ${JSON.stringify(vreq.errors)}`);

      const auth = { ...(parsed.auth ?? {}) };
      if (op.auth?.user_consent) {
        auth.user_consent = withConsentProofBinding({
          userConsent: op.auth.user_consent,
          subjectActor: parsed.auth?.delegation?.subject_actor,
          intent: op.request?.intent,
          delegationId: parsed.auth?.delegation?.delegation_id
        });
      }

      const r = intentsSvc.create({
        actor: parsed.actor,
        auth,
        idempotencyKey: op.idempotency_key,
        requestBody: op.request
      });

      const response = r.result;
      validateResponseOrError({ endpoint, opName: op.op, response });

      const rec = {
        op: op.op,
        parse_ok: true,
        ok: response.ok,
        replayed: r.replayed,
        error_code: response.ok ? null : response.body.error.code,
        reason_code: response.ok ? null : response.body.error?.details?.reason_code ?? null,
        intent_id: op.request?.intent?.id ?? null
      };
      operations.push(rec);

      if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
      if (!rec.ok && op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
      if (!rec.ok && op.expect_reason_code) assert.equal(rec.reason_code, op.expect_reason_code);
      continue;
    }

    if (op.op === 'policyAudit.list.via_token') {
      const endpoint = endpointFor('policyAudit.delegated_writes.list');
      const response = policyAuditSvc.list({ actor: parsed.actor, auth: parsed.auth, query: op.query ?? {} });
      validateResponseOrError({ endpoint, opName: op.op, response });

      const rec = {
        op: op.op,
        parse_ok: true,
        ok: response.ok,
        error_code: response.ok ? null : response.body.error.code,
        entries_count: response.ok ? (response.body.entries ?? []).length : null,
        next_cursor: response.ok ? (response.body.next_cursor ?? null) : null,
        total_filtered: response.ok ? (response.body.total_filtered ?? null) : null,
        reason_codes: response.ok ? (response.body.entries ?? []).map(e => e.reason_code) : null
      };
      operations.push(rec);

      if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
      if (!rec.ok && op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
      continue;
    }
  }

  if (op.op === 'policyAudit.list') {
    const endpoint = endpointFor('policyAudit.delegated_writes.list');
    const actor = actors?.[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

    const response = policyAuditSvc.list({ actor, auth: op.auth ?? {}, query: op.query ?? {} });
    validateResponseOrError({ endpoint, opName: op.op, response });

    const rec = {
      op: op.op,
      actor,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      entries_count: response.ok ? (response.body.entries ?? []).length : null,
      next_cursor: response.ok ? (response.body.next_cursor ?? null) : null,
      total_filtered: response.ok ? (response.body.total_filtered ?? null) : null,
      reason_codes: response.ok ? (response.body.entries ?? []).map(e => e.reason_code) : null
    };
    operations.push(rec);

    if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
    if (!rec.ok && op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
    if (typeof op.expect_entries_count === 'number') assert.equal(rec.entries_count, op.expect_entries_count);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_next_cursor')) assert.equal(rec.next_cursor, op.expect_next_cursor);
    if (typeof op.expect_total_filtered === 'number') assert.equal(rec.total_filtered, op.expect_total_filtered);
    if (Array.isArray(op.expect_reason_codes)) assert.deepEqual(rec.reason_codes, op.expect_reason_codes);
    continue;
  }

  throw new Error(`unsupported op in scenario: ${op.op}`);
}

store.save();

const finalAudit = (store.state.policy_audit ?? []).map(a => ({
  audit_id: a.audit_id,
  operation_id: a.operation_id,
  decision: a.decision,
  reason_code: a.reason_code,
  intent_id: a.intent_id ?? null,
  consent_id: a.details?.consent_id ?? null,
  required_tier: a.details?.required_tier ?? null,
  consent_tier: a.details?.consent_tier ?? null
}));

const out = canonicalize({
  operations,
  final: {
    policy_audit_count: finalAudit.length,
    policy_audit: finalAudit
  }
});

writeFileSync(path.join(outDir, 'consent_proof_binding_audit_pagination_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M40', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length, policy_audit: finalAudit.length } }, null, 2));
