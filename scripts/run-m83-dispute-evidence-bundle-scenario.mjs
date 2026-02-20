import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { PartnerCommercialService } from '../src/service/partnerCommercialService.mjs';
import { PolicyIntegritySigningService } from '../src/service/policyIntegritySigningService.mjs';
import {
  verifyPartnerProgramDisputeEvidenceBundleExportPayload,
  verifyPartnerProgramDisputeEvidenceBundleExportPayloadWithPublicKeyPem
} from '../src/crypto/policyIntegritySigning.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M83';
const SCENARIO_FILE = 'fixtures/commercial/m83_scenario.json';
const EXPECTED_FILE = 'fixtures/commercial/m83_expected.json';
const OUTPUT_FILE = 'dispute_evidence_bundle_output.json';

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
const policyIntegrityKeysSvc = new PolicyIntegritySigningService();

const publicKeysById = new Map();
const disputeRefs = {};
const exportRefs = {};
const operations = [];

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  if (op.op === 'keys.policy_integrity_signing.get') {
    const response = policyIntegrityKeysSvc.getSigningKeys();
    validateApiResponse(op.op, response);

    for (const key of response.body?.keys ?? []) {
      if (key?.key_id && key?.public_key_pem) {
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

  if (op.op === 'partnerProgram.dispute.create') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = service.createDispute({
      actor,
      auth: op.auth ?? {},
      idempotencyKey: op.idempotency_key,
      request: op.request ?? {}
    });
    validateApiResponse(op.op, response);

    if (response.ok && op.save_dispute_ref) {
      disputeRefs[op.save_dispute_ref] = response.body.dispute?.dispute_id ?? null;
    }

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      dispute_id: response.ok ? (response.body.dispute?.dispute_id ?? null) : null,
      status: response.ok ? (response.body.dispute?.status ?? null) : null,
      evidence_items_count: response.ok ? (response.body.dispute?.evidence_items?.length ?? 0) : null,
      summary_total_disputes: response.ok ? (response.body.summary?.total_disputes ?? null) : null,
      summary_open_disputes: response.ok ? (response.body.summary?.open_disputes ?? null) : null,
      summary_resolved_disputes: response.ok ? (response.body.summary?.resolved_disputes ?? null) : null,
      summary_total_evidence_items: response.ok ? (response.body.summary?.total_evidence_items ?? null) : null,
      summary_returned_count: response.ok ? (response.body.summary?.returned_count ?? null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'partnerProgram.dispute.resolve') {
    const request = clone(op.request ?? {});
    let disputeId = request.dispute_id ?? null;

    if (op.dispute_ref) {
      disputeId = disputeRefs[op.dispute_ref];
      if (!disputeId) throw new Error(`missing dispute_ref: ${op.dispute_ref}`);
      request.dispute_id = disputeId;
    }

    if (!op.skip_request_validation) validateApiRequest(op.op, request);

    const response = service.resolveDispute({
      actor,
      auth: op.auth ?? {},
      idempotencyKey: op.idempotency_key,
      disputeId,
      request
    });
    validateApiResponse(op.op, response);

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      dispute_id: response.ok ? (response.body.dispute?.dispute_id ?? null) : null,
      status: response.ok ? (response.body.dispute?.status ?? null) : null,
      resolution_code: response.ok ? (response.body.dispute?.resolution?.code ?? null) : null,
      summary_total_disputes: response.ok ? (response.body.summary?.total_disputes ?? null) : null,
      summary_open_disputes: response.ok ? (response.body.summary?.open_disputes ?? null) : null,
      summary_resolved_disputes: response.ok ? (response.body.summary?.resolved_disputes ?? null) : null,
      summary_total_evidence_items: response.ok ? (response.body.summary?.total_evidence_items ?? null) : null,
      summary_returned_count: response.ok ? (response.body.summary?.returned_count ?? null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'partnerProgram.dispute.evidence_bundle.export') {
    const query = clone(op.query ?? {});

    if (op.cursor_from_export_ref) {
      const prior = exportRefs[op.cursor_from_export_ref];
      const cursor = prior?.next_cursor ?? null;
      if (!cursor) throw new Error(`missing next_cursor in export_ref: ${op.cursor_from_export_ref}`);
      query.cursor_after = cursor;
    }

    const response = service.exportDisputeEvidenceBundles({ actor, auth: op.auth ?? {}, query });
    validateApiResponse(op.op, response);

    if (response.ok && op.save_export_ref) exportRefs[op.save_export_ref] = response.body;

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      bundles_count: response.ok ? (response.body.bundles?.length ?? 0) : null,
      summary_total_disputes: response.ok ? (response.body.summary?.total_disputes ?? null) : null,
      summary_open_disputes: response.ok ? (response.body.summary?.open_disputes ?? null) : null,
      summary_resolved_disputes: response.ok ? (response.body.summary?.resolved_disputes ?? null) : null,
      summary_total_evidence_items: response.ok ? (response.body.summary?.total_evidence_items ?? null) : null,
      summary_returned_count: response.ok ? (response.body.summary?.returned_count ?? null) : null,
      next_cursor: response.ok ? (response.body.next_cursor ?? null) : null,
      export_hash: response.ok ? (response.body.export_hash ?? null) : null,
      signature_key_id: response.ok ? (response.body.signature?.key_id ?? null) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'partnerProgram.dispute.evidence_bundle.export.verify') {
    const payload = exportRefs[op.export_ref];
    if (!payload) throw new Error(`missing export_ref: ${op.export_ref}`);

    const verified = verifyPartnerProgramDisputeEvidenceBundleExportPayload(payload);
    const keyId = payload.signature?.key_id;
    const publicKeyPem = keyId ? publicKeysById.get(keyId) : null;
    const verifiedPublic = publicKeyPem
      ? verifyPartnerProgramDisputeEvidenceBundleExportPayloadWithPublicKeyPem({ payload, publicKeyPem, keyId, alg: payload.signature?.alg })
      : { ok: false, error: 'missing_public_key' };

    const rec = {
      op: op.op,
      verify_ok: verified.ok,
      verify_error: verified.ok ? null : verified.error,
      verify_public_ok: verifiedPublic.ok,
      verify_public_error: verifiedPublic.ok ? null : verifiedPublic.error
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'partnerProgram.dispute.evidence_bundle.export.verify_tampered') {
    const payload = exportRefs[op.export_ref];
    if (!payload) throw new Error(`missing export_ref: ${op.export_ref}`);

    const tampered = clone(payload);
    const h = String(tampered.export_hash ?? '');
    tampered.export_hash = `${h.slice(0, -1)}${h.endsWith('0') ? '1' : '0'}`;

    const verified = verifyPartnerProgramDisputeEvidenceBundleExportPayload(tampered);
    const rec = {
      op: op.op,
      verify_ok: verified.ok,
      verify_error: verified.ok ? null : verified.error
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

store.save();

const final = {
  disputes: clone(store.state.partner_program_disputes ?? []),
  risk_tier_policy: clone(store.state.partner_program_risk_tier_policy ?? {}),
  risk_tier_usage_counters: clone(store.state.partner_program_risk_tier_usage_counters ?? {})
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
