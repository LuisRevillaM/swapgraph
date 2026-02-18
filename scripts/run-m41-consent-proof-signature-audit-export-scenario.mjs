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
import { buildConsentProofBinding } from '../src/core/tradingPolicyBoundaries.mjs';
import {
  mintSignedConsentProof,
  decodeSignedConsentProofString,
  encodeSignedConsentProofString,
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
  console.error('AUTHZ_ENFORCE must be 1 for M41 scenario');
  process.exit(2);
}
if (process.env.POLICY_CONSENT_TIER_ENFORCE !== '1') {
  console.error('POLICY_CONSENT_TIER_ENFORCE must be 1 for M41 scenario');
  process.exit(2);
}
if (process.env.POLICY_CONSENT_PROOF_BIND_ENFORCE !== '1') {
  console.error('POLICY_CONSENT_PROOF_BIND_ENFORCE must be 1 for M41 scenario');
  process.exit(2);
}
if (process.env.POLICY_CONSENT_PROOF_SIG_ENFORCE !== '1') {
  console.error('POLICY_CONSENT_PROOF_SIG_ENFORCE must be 1 for M41 scenario');
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

function tamperSignedConsentProof(tokenString) {
  const decoded = decodeSignedConsentProofString(tokenString);
  if (!decoded.ok) throw new Error(`cannot tamper undecodable signed consent proof: ${decoded.error}`);

  const proof = clone(decoded.proof);
  const sig = proof?.signature?.sig;
  if (!sig || typeof sig !== 'string') throw new Error('cannot tamper signed consent proof without signature.sig');

  const first = sig[0];
  const flipped = first === 'A' ? 'B' : 'A';
  proof.signature.sig = flipped + sig.slice(1);

  return encodeSignedConsentProofString(proof);
}

function withConsentProofSignature({ userConsent, subjectActor, intent, delegationId }) {
  if (!userConsent || typeof userConsent !== 'object') return userConsent;

  const out = clone(userConsent);
  const mode = out.consent_proof_mode;
  const proofIssuedAt = out.consent_proof_issued_at;
  const proofExpiresAt = out.consent_proof_expires_at;
  const proofNonce = out.consent_proof_nonce;
  const proofKeyId = out.consent_proof_key_id;

  delete out.consent_proof_mode;
  delete out.consent_proof_issued_at;
  delete out.consent_proof_expires_at;
  delete out.consent_proof_nonce;
  delete out.consent_proof_key_id;

  if (!mode) return out;

  const binding = buildConsentProofBinding({
    consentId: out.consent_id,
    subjectActor,
    delegationId,
    intent
  });

  if (mode === 'plain_bound') {
    out.consent_proof = binding;
    return out;
  }

  if (mode === 'signed_bound' || mode === 'signed_mismatch' || mode === 'signed_expired' || mode === 'signed_bad_signature') {
    const signingIntent = mode === 'signed_mismatch'
      ? { ...intent, id: `${intent.id}_other` }
      : intent;

    const signedBinding = buildConsentProofBinding({
      consentId: out.consent_id,
      subjectActor,
      delegationId,
      intent: signingIntent
    });

    let proofToken = mintSignedConsentProof({
      binding: signedBinding,
      issuedAt: proofIssuedAt,
      expiresAt: proofExpiresAt,
      nonce: proofNonce,
      keyId: proofKeyId
    });

    if (mode === 'signed_bad_signature') {
      proofToken = tamperSignedConsentProof(proofToken);
    }

    out.consent_proof = proofToken;
    return out;
  }

  if (mode === 'signed_raw' && typeof out.consent_proof === 'string' && out.consent_proof.trim()) {
    return out;
  }

  out.consent_proof = binding;
  return out;
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

const scenario = readJson(path.join(root, 'fixtures/delegation/m41_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/delegation/m41_expected.json'));

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
    if (!rec.ok && op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
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
    if (op.expect_actor && rec.ok) assert.deepEqual(rec.actor, op.expect_actor);
    if (!rec.ok && op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
    continue;
  }

  if (op.op === 'swapIntents.create.via_token' || op.op === 'policyAudit.export.via_token') {
    const token = tokenRefs[op.token_ref];
    if (!token) throw new Error(`missing token_ref: ${op.token_ref}`);

    const headers = { Authorization: `Bearer ${token}` };
    if (op.auth?.now_iso) headers['X-Now-Iso'] = op.auth.now_iso;

    const parsed = parseAuthHeaders({ headers });

    if (!parsed.ok) {
      const rec = {
        op: op.op,
        parse_ok: false,
        ok: false,
        error_code: parsed.error.code
      };
      operations.push(rec);

      if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
      if (op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
      continue;
    }

    if (op.op === 'swapIntents.create.via_token') {
      const endpoint = endpointFor(endpointsByOp, 'swapIntents.create');
      const vreq = validateAgainstSchemaFile(endpoint.request_schema, op.request);
      if (!vreq.ok) throw new Error(`request invalid for op=${op.op}: ${JSON.stringify(vreq.errors)}`);

      const auth = { ...(parsed.auth ?? {}) };
      if (op.auth?.user_consent) {
        auth.user_consent = withConsentProofSignature({
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

    if (op.op === 'policyAudit.export.via_token') {
      const endpoint = endpointFor(endpointsByOp, 'policyAudit.delegated_writes.export');
      const response = policyAuditSvc.exportDelegatedWrites({ actor: parsed.actor, auth: parsed.auth, query: op.query ?? {} });
      validateResponseOrError({ validateAgainstSchemaFile, endpoint, opName: op.op, response });

      const rec = {
        op: op.op,
        parse_ok: true,
        ok: response.ok,
        error_code: response.ok ? null : response.body.error.code,
        entries_count: response.ok ? (response.body.entries ?? []).length : null,
        total_filtered: response.ok ? (response.body.total_filtered ?? null) : null
      };
      operations.push(rec);

      if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
      if (!rec.ok && op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
      continue;
    }
  }

  if (op.op === 'policyAudit.list') {
    const endpoint = endpointFor(endpointsByOp, 'policyAudit.delegated_writes.list');
    const actor = actors?.[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

    const response = policyAuditSvc.list({ actor, auth: op.auth ?? {}, query: op.query ?? {} });
    validateResponseOrError({ validateAgainstSchemaFile, endpoint, opName: op.op, response });

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

  if (op.op === 'policyAudit.export') {
    const endpoint = endpointFor(endpointsByOp, 'policyAudit.delegated_writes.export');
    const actor = actors?.[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

    const response = policyAuditSvc.exportDelegatedWrites({ actor, auth: op.auth ?? {}, query: op.query ?? {} });
    validateResponseOrError({ validateAgainstSchemaFile, endpoint, opName: op.op, response });

    if (response.ok && op.save_export_ref) exportRefs[op.save_export_ref] = clone(response.body);

    let verifyOk = null;
    let verifyPublicOk = null;
    let verifyError = null;
    let verifyPublicError = null;

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
    }

    const rec = {
      op: op.op,
      actor,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      entries_count: response.ok ? (response.body.entries ?? []).length : null,
      total_filtered: response.ok ? (response.body.total_filtered ?? null) : null,
      export_hash: response.ok ? (response.body.export_hash ?? null) : null,
      signature_key_id: response.ok ? (response.body.signature?.key_id ?? null) : null,
      verify_ok: verifyOk,
      verify_error: verifyError,
      verify_public_ok: verifyPublicOk,
      verify_public_error: verifyPublicError,
      reason_codes: response.ok ? (response.body.entries ?? []).map(e => e.reason_code) : null
    };

    operations.push(rec);

    if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
    if (!rec.ok && op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
    if (typeof op.expect_entries_count === 'number') assert.equal(rec.entries_count, op.expect_entries_count);
    if (typeof op.expect_total_filtered === 'number') assert.equal(rec.total_filtered, op.expect_total_filtered);
    if (typeof op.expect_verify_ok === 'boolean') assert.equal(rec.verify_ok, op.expect_verify_ok);
    if (typeof op.expect_verify_public_ok === 'boolean') assert.equal(rec.verify_public_ok, op.expect_verify_public_ok);
    if (Array.isArray(op.expect_reason_codes)) assert.deepEqual(rec.reason_codes, op.expect_reason_codes);
    continue;
  }

  if (op.op === 'policyAudit.export.verify_tampered') {
    const source = exportRefs[op.export_ref];
    if (!source) throw new Error(`missing export_ref: ${op.export_ref}`);

    const tampered = clone(source);
    const h = String(tampered.export_hash ?? '');
    const suffix = h.endsWith('0') ? '1' : '0';
    tampered.export_hash = `${h.slice(0, Math.max(0, h.length - 1))}${suffix}`;

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

const finalAudit = (store.state.policy_audit ?? []).map(a => ({
  audit_id: a.audit_id,
  operation_id: a.operation_id,
  decision: a.decision,
  reason_code: a.reason_code,
  intent_id: a.intent_id ?? null,
  consent_id: a.details?.consent_id ?? null,
  required_tier: a.details?.required_tier ?? null,
  consent_tier: a.details?.consent_tier ?? null,
  consent_proof_key_id: a.details?.consent_proof_key_id ?? null
}));

const out = canonicalize({
  operations,
  final: {
    policy_audit_count: finalAudit.length,
    policy_audit: finalAudit
  }
});

writeFileSync(path.join(outDir, 'consent_proof_signature_audit_export_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M41', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length, policy_audit: finalAudit.length } }, null, 2));
