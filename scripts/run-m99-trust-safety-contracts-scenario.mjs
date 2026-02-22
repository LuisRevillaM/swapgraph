import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { PolicyIntegritySigningService } from '../src/service/policyIntegritySigningService.mjs';
import { TrustSafetyService } from '../src/service/trustSafetyService.mjs';
import {
  verifyPolicyAuditExportPayload,
  verifyPolicyAuditExportPayloadWithPublicKeyPem
} from '../src/crypto/policyIntegritySigning.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M99';
const SCENARIO_FILE = 'fixtures/release/m99_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m99_expected.json';
const OUTPUT_FILE = 'trust_safety_contracts_output.json';

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
    assert.deepEqual(rec[field], v, `expectation_failed op=${op.op} field=${field}`);
  }
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const actors = scenario.actors ?? {};

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();

const trustSafetyService = new TrustSafetyService({ store });
const keysService = new PolicyIntegritySigningService();

const operations = [];
const signalRefs = new Map();
const decisionRefs = new Map();
const exportRefs = new Map();
const publicKeysById = new Map();

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  if (op.op === 'keys.policy_integrity_signing.get') {
    const response = keysService.getSigningKeys();
    validateApiResponse(op.op, response);

    for (const key of response.body?.keys ?? []) {
      if (typeof key?.key_id === 'string' && typeof key?.public_key_pem === 'string') {
        publicKeysById.set(key.key_id, key.public_key_pem);
      }
    }

    const rec = {
      op: op.op,
      ok: response.ok,
      keys_count: response.ok ? (response.body.keys?.length ?? 0) : null,
      active_key_id: response.ok ? (response.body.active_key_id ?? null) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'trustSafety.signal.record') {
    const request = clone(op.request ?? {});

    if (!op.skip_request_validation) validateApiRequest(op.op, request);

    const out = trustSafetyService.recordSignal({
      actor,
      auth: op.auth ?? {},
      idempotencyKey: op.idempotency_key,
      request
    });

    const response = out.result;
    validateApiResponse(op.op, response);

    if (response.ok && typeof op.save_signal_ref === 'string') {
      signalRefs.set(op.save_signal_ref, response.body.signal?.signal_id ?? null);
    }

    const rec = {
      op: op.op,
      ok: response.ok,
      replayed: out.replayed,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      signal_id: response.ok ? (response.body.signal?.signal_id ?? null) : null,
      category: response.ok ? (response.body.signal?.category ?? null) : null,
      subject_actor_id: response.ok ? (response.body.signal?.subject_actor_id ?? null) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'trustSafety.decision.record') {
    const request = clone(op.request ?? {});

    if (Array.isArray(op.contributing_signal_refs)) {
      const ids = op.contributing_signal_refs.map(ref => {
        const id = signalRefs.get(ref) ?? null;
        if (!id) throw new Error(`missing signal ref: ${ref}`);
        return id;
      });
      request.decision ||= {};
      request.decision.contributing_signal_ids = ids;
    }

    if (!op.skip_request_validation) validateApiRequest(op.op, request);

    const out = trustSafetyService.recordDecision({
      actor,
      auth: op.auth ?? {},
      idempotencyKey: op.idempotency_key,
      request
    });

    const response = out.result;
    validateApiResponse(op.op, response);

    if (response.ok && typeof op.save_decision_ref === 'string') {
      decisionRefs.set(op.save_decision_ref, response.body.decision?.decision_id ?? null);
    }

    const rec = {
      op: op.op,
      ok: response.ok,
      replayed: out.replayed,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      decision_id: response.ok ? (response.body.decision?.decision_id ?? null) : null,
      decision: response.ok ? (response.body.decision?.decision ?? null) : null,
      subject_actor_id: response.ok ? (response.body.decision?.subject_actor_id ?? null) : null,
      reason_codes_count: response.ok ? (response.body.decision?.reason_codes?.length ?? 0) : null,
      contributing_signal_ids_count: response.ok ? (response.body.decision?.contributing_signal_ids?.length ?? 0) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'trustSafety.decision.get') {
    const decisionId = typeof op.decision_id_ref === 'string'
      ? (decisionRefs.get(op.decision_id_ref) ?? null)
      : (op.decision_id ?? null);

    if (typeof op.decision_id_ref === 'string' && !decisionId) {
      throw new Error(`missing decision ref: ${op.decision_id_ref}`);
    }

    const response = trustSafetyService.getDecision({
      actor,
      auth: op.auth ?? {},
      decisionId
    });

    validateApiResponse(op.op, response);

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      decision_id: response.ok ? (response.body.decision?.decision_id ?? null) : decisionId,
      decision: response.ok ? (response.body.decision?.decision ?? null) : null,
      subject_actor_id: response.ok ? (response.body.decision?.subject_actor_id ?? null) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'trustSafety.decision.export') {
    const query = clone(op.query ?? {});

    if (typeof op.cursor_from_export_ref === 'string') {
      const prior = exportRefs.get(op.cursor_from_export_ref) ?? null;
      const cursor = prior?.next_cursor ?? null;
      if (!cursor) throw new Error(`missing next_cursor in export_ref=${op.cursor_from_export_ref}`);
      query.cursor_after = cursor;
    }

    if (typeof op.attestation_from_export_ref === 'string') {
      const prior = exportRefs.get(op.attestation_from_export_ref) ?? null;
      const attestation = prior?.attestation?.chain_hash ?? null;
      if (!attestation) throw new Error(`missing attestation chain_hash in export_ref=${op.attestation_from_export_ref}`);
      query.attestation_after = attestation;
    }

    if (typeof op.checkpoint_from_export_ref === 'string') {
      const prior = exportRefs.get(op.checkpoint_from_export_ref) ?? null;
      const checkpointHash = prior?.checkpoint?.checkpoint_hash ?? null;
      if (!checkpointHash) throw new Error(`missing checkpoint hash in export_ref=${op.checkpoint_from_export_ref}`);
      query.checkpoint_after = checkpointHash;
    }

    const response = trustSafetyService.exportDecisions({
      actor,
      auth: op.auth ?? {},
      query
    });

    validateApiResponse(op.op, response);

    if (response.ok && typeof op.save_export_ref === 'string') {
      exportRefs.set(op.save_export_ref, clone(response.body));
    }

    const entries = response.ok ? (response.body.entries ?? []) : [];
    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      entries_count: response.ok ? entries.length : null,
      total_filtered: response.ok ? (response.body.total_filtered ?? null) : null,
      next_cursor_present: response.ok ? (typeof response.body.next_cursor === 'string' && response.body.next_cursor.length > 0) : null,
      attestation_present: response.ok ? (response.body.attestation && typeof response.body.attestation === 'object') : null,
      checkpoint_present: response.ok ? (response.body.checkpoint && typeof response.body.checkpoint === 'object') : null,
      signature_key_id: response.ok ? (response.body.signature?.key_id ?? null) : null,
      first_decision_id: response.ok && entries.length > 0 ? (entries[0].decision_id ?? null) : null,
      last_decision_id: response.ok && entries.length > 0 ? (entries[entries.length - 1].decision_id ?? null) : null,
      subject_redacted: response.ok && entries.length > 0 ? (entries[0].subject_redacted === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'trustSafety.decision.export.verify') {
    const payload = exportRefs.get(op.export_ref) ?? null;
    if (!payload) throw new Error(`missing export ref: ${op.export_ref}`);

    const verifyResult = verifyPolicyAuditExportPayload(payload);
    const keyId = payload.signature?.key_id;
    const publicKeyPem = keyId ? (publicKeysById.get(keyId) ?? null) : null;
    const verifyPublicResult = publicKeyPem
      ? verifyPolicyAuditExportPayloadWithPublicKeyPem({ payload, publicKeyPem, keyId, alg: payload.signature?.alg })
      : { ok: false, error: 'missing_public_key' };

    const rec = {
      op: op.op,
      verify_ok: verifyResult.ok,
      verify_error: verifyResult.ok ? null : verifyResult.error,
      verify_public_ok: verifyPublicResult.ok,
      verify_public_error: verifyPublicResult.ok ? null : verifyPublicResult.error
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'trustSafety.decision.export.verify_tampered') {
    const payload = exportRefs.get(op.export_ref) ?? null;
    if (!payload) throw new Error(`missing export ref: ${op.export_ref}`);

    const tampered = clone(payload);
    const h = String(tampered.export_hash ?? '');
    tampered.export_hash = `${h.slice(0, -1)}${h.endsWith('0') ? '1' : '0'}`;

    const verifyResult = verifyPolicyAuditExportPayload(tampered);

    const rec = {
      op: op.op,
      verify_ok: verifyResult.ok,
      verify_error: verifyResult.ok ? null : verifyResult.error
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

store.save();

const final = {
  trust_safety_signals_count: Object.keys(store.state.trust_safety_signals ?? {}).length,
  trust_safety_decisions_count: Object.keys(store.state.trust_safety_decisions ?? {}).length,
  trust_safety_export_checkpoints_count: Object.keys(store.state.trust_safety_export_checkpoints ?? {}).length,
  trust_safety_decision_ids: Object.keys(store.state.trust_safety_decisions ?? {}).sort()
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
