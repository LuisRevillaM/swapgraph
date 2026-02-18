import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { DelegationsService } from '../src/service/delegationsService.mjs';
import { SwapIntentsService } from '../src/service/swapIntentsService.mjs';
import { PolicyAuditReadService } from '../src/read/policyAuditReadService.mjs';
import { PolicyIntegritySigningService } from '../src/service/policyIntegritySigningService.mjs';
import { parseAuthHeaders } from '../src/core/authHeaders.mjs';
import {
  verifyPolicyAuditExportPayload,
  verifyPolicyAuditExportPayloadWithPublicKeyPem
} from '../src/crypto/policyIntegritySigning.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const root = process.cwd();
const outDir = process.env.OUT_DIR;
if (!outDir) {
  console.error('Missing OUT_DIR env');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

if (process.env.AUTHZ_ENFORCE !== '1') {
  console.error('AUTHZ_ENFORCE must be 1 for M45 scenario');
  process.exit(2);
}
if (process.env.POLICY_AUDIT_EXPORT_CHECKPOINT_ENFORCE !== '1') {
  console.error('POLICY_AUDIT_EXPORT_CHECKPOINT_ENFORCE must be 1 for M45 scenario');
  process.exit(2);
}
if (!process.env.POLICY_AUDIT_EXPORT_CHECKPOINT_RETENTION_DAYS) {
  console.error('POLICY_AUDIT_EXPORT_CHECKPOINT_RETENTION_DAYS must be set for M45 scenario');
  process.exit(2);
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function endpointFor(endpointsByOp, operationId) {
  const ep = endpointsByOp.get(operationId);
  if (!ep) throw new Error(`missing endpoint for operation_id=${operationId}`);
  return ep;
}

function validateResponseOrError({ validateAgainstSchemaFile, endpoint, opName, response }) {
  if (response.ok) {
    const vr = validateAgainstSchemaFile(endpoint.response_schema, response.body);
    if (!vr.ok) throw new Error(`response invalid for op=${opName}: ${JSON.stringify(vr.errors)}`);
  } else {
    const ve = validateAgainstSchemaFile('ErrorResponse.schema.json', response.body);
    if (!ve.ok) throw new Error(`error response invalid for op=${opName}: ${JSON.stringify(ve.errors)}`);
  }
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

const scenario = readJson(path.join(root, 'fixtures/delegation/m45_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/delegation/m45_expected.json'));

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();
store.save();

const delegationsSvc = new DelegationsService({ store });
const intentsSvc = new SwapIntentsService({ store });
const policyAuditSvc = new PolicyAuditReadService({ store });
const policyIntegrityKeysSvc = new PolicyIntegritySigningService();

const actors = scenario.actors ?? {};
const tokenRefs = {};
const exportRefs = {};
const policyIntegrityPubKeysById = new Map();
const operations = [];

for (const op of scenario.operations ?? []) {
  if (op.op === 'delegations.create') {
    const endpoint = endpointFor(endpointsByOp, 'delegations.create');
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
    validateResponseOrError({ validateAgainstSchemaFile, endpoint, opName: op.op, response });

    if (response.ok && op.save_token_ref) tokenRefs[op.save_token_ref] = response.body.delegation_token;

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

  if (op.op === 'keys.policy_integrity_signing.get') {
    const endpoint = endpointFor(endpointsByOp, 'keys.policy_integrity_signing.get');
    const response = policyIntegrityKeysSvc.getSigningKeys();
    validateResponseOrError({ validateAgainstSchemaFile, endpoint, opName: op.op, response });

    const keyStatuses = {};
    for (const key of response.body.keys ?? []) {
      keyStatuses[key.key_id] = key.status;
      policyIntegrityPubKeysById.set(key.key_id, key.public_key_pem);
    }

    const rec = {
      op: op.op,
      ok: response.ok,
      active_key_id: response.body.active_key_id,
      keys_count: (response.body.keys ?? []).length,
      key_statuses: keyStatuses
    };

    operations.push(rec);

    if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
    if (op.expect_active_key_id) assert.equal(rec.active_key_id, op.expect_active_key_id);
    if (typeof op.expect_keys_count === 'number') assert.equal(rec.keys_count, op.expect_keys_count);
    if (op.expect_key_statuses) assert.deepEqual(rec.key_statuses, op.expect_key_statuses);
    continue;
  }

  if (op.op === 'swapIntents.create.via_token') {
    const token = tokenRefs[op.token_ref];
    if (!token) throw new Error(`missing token_ref: ${op.token_ref}`);

    const endpoint = endpointFor(endpointsByOp, 'swapIntents.create');
    const vreq = validateAgainstSchemaFile(endpoint.request_schema, op.request);
    if (!vreq.ok) throw new Error(`request invalid for op=${op.op}: ${JSON.stringify(vreq.errors)}`);

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

    const r = intentsSvc.create({
      actor: parsed.actor,
      auth: parsed.auth,
      idempotencyKey: op.idempotency_key,
      requestBody: op.request
    });

    const response = r.result;
    validateResponseOrError({ validateAgainstSchemaFile, endpoint, opName: op.op, response });

    const rec = {
      op: op.op,
      parse_ok: true,
      ok: response.ok,
      replayed: r.replayed,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error?.details?.reason_code ?? null),
      intent_id: op.request?.intent?.id ?? null
    };

    operations.push(rec);

    if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
    if (!rec.ok && op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
    if (!rec.ok && op.expect_reason_code) assert.equal(rec.reason_code, op.expect_reason_code);
    continue;
  }

  if (op.op === 'policyAudit.export') {
    const endpoint = endpointFor(endpointsByOp, 'policyAudit.delegated_writes.export');
    const actor = actors?.[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

    const query = clone(op.query ?? {});

    if (op.attestation_after_ref) {
      const prior = exportRefs[op.attestation_after_ref];
      if (!prior) throw new Error(`missing attestation_after_ref export: ${op.attestation_after_ref}`);
      query.attestation_after = prior?.attestation?.chain_hash ?? null;
    }

    if (op.checkpoint_after_ref) {
      const prior = exportRefs[op.checkpoint_after_ref];
      if (!prior) throw new Error(`missing checkpoint_after_ref export: ${op.checkpoint_after_ref}`);
      query.checkpoint_after = prior?.checkpoint?.checkpoint_hash ?? null;
    }

    const response = policyAuditSvc.exportDelegatedWrites({ actor, auth: op.auth ?? {}, query });
    validateResponseOrError({ validateAgainstSchemaFile, endpoint, opName: op.op, response });

    if (response.ok && op.save_export_ref) exportRefs[op.save_export_ref] = clone(response.body);

    let verifyOk = null;
    let verifyPublicOk = null;
    let verifyError = null;
    let verifyPublicError = null;
    let attestationChainOk = null;
    let checkpointChainOk = null;

    if (response.ok) {
      const verified = verifyPolicyAuditExportPayload(response.body);
      verifyOk = verified.ok;
      verifyError = verified.ok ? null : verified.error;

      const keyId = response.body.signature?.key_id ?? null;
      const publicKeyPem = keyId ? policyIntegrityPubKeysById.get(keyId) : null;

      if (publicKeyPem) {
        const verifiedPublic = verifyPolicyAuditExportPayloadWithPublicKeyPem({
          payload: response.body,
          publicKeyPem,
          keyId,
          alg: response.body.signature?.alg ?? null
        });
        verifyPublicOk = verifiedPublic.ok;
        verifyPublicError = verifiedPublic.ok ? null : verifiedPublic.error;
      } else {
        verifyPublicOk = false;
        verifyPublicError = 'missing_public_key';
      }

      if (op.attestation_after_ref) {
        const prior = exportRefs[op.attestation_after_ref];
        const expectedAfter = prior?.attestation?.chain_hash ?? null;
        const providedAfter = response.body.attestation?.attestation_after ?? null;
        attestationChainOk = expectedAfter === providedAfter;
      }

      if (op.checkpoint_after_ref) {
        const prior = exportRefs[op.checkpoint_after_ref];
        const expectedAfter = prior?.checkpoint?.checkpoint_hash ?? null;
        const providedAfter = response.body.checkpoint?.checkpoint_after ?? null;
        checkpointChainOk = expectedAfter === providedAfter;
      }
    }

    const rec = {
      op: op.op,
      actor,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error?.details?.reason_code ?? null),
      entries_count: response.ok ? (response.body.entries ?? []).length : null,
      next_cursor: response.ok ? (response.body.next_cursor ?? null) : null,
      total_filtered: response.ok ? (response.body.total_filtered ?? null) : null,
      export_hash: response.ok ? (response.body.export_hash ?? null) : null,
      signature_key_id: response.ok ? (response.body.signature?.key_id ?? null) : null,
      attestation_after: response.ok ? (response.body.attestation?.attestation_after ?? null) : null,
      attestation_chain_hash: response.ok ? (response.body.attestation?.chain_hash ?? null) : null,
      checkpoint_after: response.ok ? (response.body.checkpoint?.checkpoint_after ?? null) : null,
      checkpoint_hash: response.ok ? (response.body.checkpoint?.checkpoint_hash ?? null) : null,
      verify_ok: verifyOk,
      verify_error: verifyError,
      verify_public_ok: verifyPublicOk,
      verify_public_error: verifyPublicError,
      attestation_chain_ok: attestationChainOk,
      checkpoint_chain_ok: checkpointChainOk,
      reason_codes: response.ok ? (response.body.entries ?? []).map(e => e.reason_code) : null
    };

    operations.push(rec);

    if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
    if (!rec.ok && op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
    if (!rec.ok && op.expect_reason_code) assert.equal(rec.reason_code, op.expect_reason_code);
    if (typeof op.expect_entries_count === 'number') assert.equal(rec.entries_count, op.expect_entries_count);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_next_cursor')) assert.equal(rec.next_cursor, op.expect_next_cursor);
    if (typeof op.expect_total_filtered === 'number') assert.equal(rec.total_filtered, op.expect_total_filtered);
    if (typeof op.expect_verify_ok === 'boolean') assert.equal(rec.verify_ok, op.expect_verify_ok);
    if (typeof op.expect_verify_public_ok === 'boolean') assert.equal(rec.verify_public_ok, op.expect_verify_public_ok);
    if (typeof op.expect_attestation_chain_ok === 'boolean') assert.equal(rec.attestation_chain_ok, op.expect_attestation_chain_ok);
    if (typeof op.expect_checkpoint_chain_ok === 'boolean') assert.equal(rec.checkpoint_chain_ok, op.expect_checkpoint_chain_ok);
    if (Array.isArray(op.expect_reason_codes)) assert.deepEqual(rec.reason_codes, op.expect_reason_codes);
    continue;
  }

  if (op.op === 'policyAudit.export.verify_tampered_checkpoint') {
    const source = exportRefs[op.export_ref];
    if (!source) throw new Error(`missing export_ref: ${op.export_ref}`);

    const tampered = clone(source);
    const h = String(tampered?.checkpoint?.checkpoint_hash ?? '');
    const suffix = h.endsWith('0') ? '1' : '0';
    tampered.checkpoint.checkpoint_hash = `${h.slice(0, Math.max(0, h.length - 1))}${suffix}`;

    const verified = verifyPolicyAuditExportPayload(tampered);

    const rec = {
      op: op.op,
      export_ref: op.export_ref,
      verify_ok: verified.ok,
      verify_error: verified.ok ? null : verified.error
    };

    operations.push(rec);

    if (typeof op.expect_verify_ok === 'boolean') assert.equal(rec.verify_ok, op.expect_verify_ok);
    if (op.expect_verify_error) assert.equal(rec.verify_error, op.expect_verify_error);
    continue;
  }

  throw new Error(`unsupported op in scenario: ${op.op}`);
}

store.save();

const checkpoints = store.state.policy_audit_export_checkpoints ?? {};
const checkpointKeys = Object.keys(checkpoints).sort();
const checkpointRecords = checkpointKeys.map(key => ({
  checkpoint_hash: key,
  checkpoint_after: checkpoints[key]?.checkpoint_after ?? null,
  next_cursor: checkpoints[key]?.next_cursor ?? null,
  attestation_chain_hash: checkpoints[key]?.attestation_chain_hash ?? null,
  exported_at: checkpoints[key]?.exported_at ?? null
}));

const oldCheckpointHash = exportRefs.export_old_page_1?.checkpoint?.checkpoint_hash ?? null;
const oldContinuationCheckpointHash = exportRefs.export_old_page_2?.checkpoint?.checkpoint_hash ?? null;
const freshCheckpointHash = exportRefs.export_fresh_page_1?.checkpoint?.checkpoint_hash ?? null;
const freshContinuationCheckpointHash = exportRefs.export_fresh_page_2?.checkpoint?.checkpoint_hash ?? null;

const out = canonicalize({
  operations,
  final: {
    policy_audit_count: (store.state.policy_audit ?? []).length,
    policy_audit_reason_codes: (store.state.policy_audit ?? []).map(a => a.reason_code),
    checkpoint_keys: checkpointKeys,
    checkpoint_records: checkpointRecords,
    old_checkpoint_hash: oldCheckpointHash,
    old_continuation_checkpoint_hash: oldContinuationCheckpointHash,
    fresh_checkpoint_hash: freshCheckpointHash,
    fresh_continuation_checkpoint_hash: freshContinuationCheckpointHash,
    has_old_checkpoint: oldCheckpointHash ? checkpointKeys.includes(oldCheckpointHash) : false,
    has_old_continuation_checkpoint: oldContinuationCheckpointHash ? checkpointKeys.includes(oldContinuationCheckpointHash) : false,
    has_fresh_checkpoint: freshCheckpointHash ? checkpointKeys.includes(freshCheckpointHash) : false,
    has_fresh_continuation_checkpoint: freshContinuationCheckpointHash ? checkpointKeys.includes(freshContinuationCheckpointHash) : false
  }
});

writeFileSync(path.join(outDir, 'export_checkpoint_retention_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M45', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length, checkpoints: checkpointKeys.length } }, null, 2));
