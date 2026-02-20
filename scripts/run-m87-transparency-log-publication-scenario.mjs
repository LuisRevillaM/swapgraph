import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { TransparencyLogService } from '../src/service/transparencyLogService.mjs';
import {
  verifyTransparencyLogPublicationExportPayload,
  verifyTransparencyLogPublicationExportPayloadWithPublicKeyPem
} from '../src/crypto/policyIntegritySigning.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M87';
const SCENARIO_FILE = 'fixtures/transparency/m87_scenario.json';
const EXPECTED_FILE = 'fixtures/transparency/m87_expected.json';
const OUTPUT_FILE = 'transparency_log_publication_output.json';

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

const keysExample = readJson(path.join(root, 'docs/spec/examples/api/keys.policy_integrity_signing.get.response.json'));
const activeKey = (keysExample.keys ?? []).find(x => x?.status === 'active') ?? null;
if (!activeKey?.public_key_pem) {
  throw new Error('missing active policy integrity signing public key example');
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const actors = scenario.actors ?? {};

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();

const service = new TransparencyLogService({ store });
const exportRefs = {};
const operations = [];

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  if (op.op === 'transparencyLog.publication.record') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = service.recordPublication({
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
      publication_id: response.ok ? (response.body.publication?.publication_id ?? null) : null,
      publication_index: response.ok ? (response.body.publication?.publication_index ?? null) : null,
      source_type: response.ok ? (response.body.publication?.source_type ?? null) : null,
      previous_root_hash: response.ok ? (response.body.publication?.previous_root_hash ?? null) : null,
      chain_hash: response.ok ? (response.body.publication?.chain_hash ?? null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'transparencyLog.publication.export') {
    const query = clone(op.query ?? {});

    if (op.cursor_after_ref) {
      const ref = exportRefs[op.cursor_after_ref];
      if (!ref?.next_cursor) throw new Error(`missing cursor ref: ${op.cursor_after_ref}`);
      query.cursor_after = ref.next_cursor;
    }

    if (op.attestation_after_ref) {
      const ref = exportRefs[op.attestation_after_ref];
      if (!ref?.attestation_chain_hash) throw new Error(`missing attestation ref: ${op.attestation_after_ref}`);
      query.attestation_after = ref.attestation_chain_hash;
    }

    if (op.checkpoint_after_ref) {
      const ref = exportRefs[op.checkpoint_after_ref];
      if (!ref?.checkpoint_hash) throw new Error(`missing checkpoint ref: ${op.checkpoint_after_ref}`);
      query.checkpoint_after = ref.checkpoint_hash;
    }

    const response = service.exportPublications({ actor, auth: op.auth ?? {}, query });
    validateApiResponse(op.op, response);

    if (response.ok && op.save_export_ref) {
      exportRefs[op.save_export_ref] = {
        payload: clone(response.body),
        next_cursor: response.body.next_cursor ?? null,
        attestation_chain_hash: response.body.attestation?.chain_hash ?? null,
        checkpoint_hash: response.body.checkpoint?.checkpoint_hash ?? null
      };
    }

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      summary_total_publications: response.ok ? (response.body.summary?.total_publications ?? null) : null,
      summary_returned_count: response.ok ? (response.body.summary?.returned_count ?? null) : null,
      total_filtered: response.ok ? (response.body.total_filtered ?? null) : null,
      next_cursor: response.ok ? (response.body.next_cursor ?? null) : null,
      first_publication_id: response.ok ? (response.body.publications?.[0]?.publication_id ?? null) : null,
      has_attestation: response.ok ? (response.body.attestation ? true : false) : null,
      has_checkpoint: response.ok ? (response.body.checkpoint ? true : false) : null,
      has_signature: response.ok ? (response.body.signature ? true : false) : null,
      attestation_after: response.ok ? (response.body.attestation?.attestation_after ?? null) : null,
      checkpoint_after: response.ok ? (response.body.checkpoint?.checkpoint_after ?? null) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'transparencyLog.publication.export.verify') {
    const ref = exportRefs[op.export_ref];
    if (!ref?.payload) throw new Error(`missing export_ref payload: ${op.export_ref}`);

    const verifyA = verifyTransparencyLogPublicationExportPayload(ref.payload);
    const verifyB = verifyTransparencyLogPublicationExportPayloadWithPublicKeyPem({
      payload: ref.payload,
      publicKeyPem: activeKey.public_key_pem,
      keyId: activeKey.key_id,
      alg: activeKey.alg
    });

    const rec = {
      op: op.op,
      verify_ok: verifyA.ok === true && verifyB.ok === true,
      verify_error: verifyA.ok ? (verifyB.ok ? null : verifyB.error) : verifyA.error
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'transparencyLog.publication.export.verify_tampered') {
    const ref = exportRefs[op.export_ref];
    if (!ref?.payload) throw new Error(`missing export_ref payload: ${op.export_ref}`);

    const tampered = clone(ref.payload);
    if (op.tamper === 'export_hash') {
      tampered.export_hash = 'f'.repeat(64);
    } else if (op.tamper === 'publication_root_hash' && Array.isArray(tampered.publications) && tampered.publications.length > 0) {
      tampered.publications[0].root_hash = '0'.repeat(64);
    } else {
      tampered.export_hash = 'f'.repeat(64);
    }

    const verifyA = verifyTransparencyLogPublicationExportPayload(tampered);
    const verifyB = verifyTransparencyLogPublicationExportPayloadWithPublicKeyPem({
      payload: tampered,
      publicKeyPem: activeKey.public_key_pem,
      keyId: activeKey.key_id,
      alg: activeKey.alg
    });

    const rec = {
      op: op.op,
      verify_ok: verifyA.ok === true && verifyB.ok === true,
      verify_error: verifyA.ok ? (verifyB.ok ? null : verifyB.error) : verifyA.error
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

store.save();

const final = {
  transparency_log_publications: clone(store.state.transparency_log_publications ?? []),
  transparency_log_export_checkpoints: clone(store.state.transparency_log_export_checkpoints ?? {}),
  transparency_log_publication_counter: store.state.transparency_log_publication_counter ?? 0,
  transparency_log_entry_counter: store.state.transparency_log_entry_counter ?? 0
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
