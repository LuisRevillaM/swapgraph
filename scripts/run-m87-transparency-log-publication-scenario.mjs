import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { TransparencyLogPublicationService } from '../src/service/transparencyLogPublicationService.mjs';
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

function setByPath(obj, dottedPath, value) {
  const parts = String(dottedPath ?? '').split('.').filter(Boolean);
  if (parts.length === 0) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const k = parts[i];
    const idx = Number.parseInt(k, 10);
    if (Number.isFinite(idx) && String(idx) === k) {
      cur = cur[idx];
    } else {
      cur = cur[k];
    }
    if (cur === undefined || cur === null) {
      throw new Error(`invalid tamper path segment: ${k}`);
    }
  }
  const last = parts[parts.length - 1];
  const lastIdx = Number.parseInt(last, 10);
  if (Number.isFinite(lastIdx) && String(lastIdx) === last) {
    cur[lastIdx] = value;
  } else {
    cur[last] = value;
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

const keySetExample = readJson(path.join(root, 'docs/spec/examples/api/keys.policy_integrity_signing.get.response.json'));
const activeKeyId = keySetExample.active_key_id;
const activeKey = (keySetExample.keys ?? []).find(k => k.key_id === activeKeyId);
if (!activeKey?.public_key_pem) throw new Error('missing active policy integrity signing public key');

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();

const service = new TransparencyLogPublicationService({ store });
const exportRefs = {};
const operations = [];

for (const op of scenario.operations ?? []) {
  if (op.op === 'transparencyLog.publication.export.verify_tampered') {
    const exportPayload = exportRefs?.[op.export_ref];
    if (!exportPayload) throw new Error(`missing export_ref for tamper verify: ${op.export_ref}`);

    const tampered = clone(exportPayload);
    if (op.tamper?.path) {
      setByPath(tampered, op.tamper.path, op.tamper.value);
    }

    const verified = service.verifyPublicationExportPayload({ payload: tampered });
    const rec = {
      op: op.op,
      verify_ok: verified.ok === true,
      verify_error: verified.ok ? null : (verified.error ?? null)
    };
    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  if (op.op === 'transparencyLog.publication.append') {
    validateApiRequest(op.op, op.request ?? {});

    const response = service.appendPublicationEntries({
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
      entries_appended: response.ok ? (response.body.publication?.entries_appended ?? null) : null,
      first_entry_id: response.ok ? (response.body.publication?.first_entry_id ?? null) : null,
      last_entry_id: response.ok ? (response.body.publication?.last_entry_id ?? null) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'transparencyLog.publication.export') {
    const query = clone(op.query ?? {});

    if (query.cursor_after_ref) {
      const ref = exportRefs?.[query.cursor_after_ref];
      if (!ref) throw new Error(`missing cursor_after_ref: ${query.cursor_after_ref}`);
      query.cursor_after = ref.next_cursor ?? null;
      delete query.cursor_after_ref;
    }

    if (query.attestation_after_ref) {
      const ref = exportRefs?.[query.attestation_after_ref];
      if (!ref) throw new Error(`missing attestation_after_ref: ${query.attestation_after_ref}`);
      query.attestation_after = ref.attestation?.chain_hash ?? null;
      delete query.attestation_after_ref;
    }

    if (query.checkpoint_after_ref) {
      const ref = exportRefs?.[query.checkpoint_after_ref];
      if (!ref) throw new Error(`missing checkpoint_after_ref: ${query.checkpoint_after_ref}`);
      query.checkpoint_after = ref.checkpoint?.checkpoint_hash ?? null;
      delete query.checkpoint_after_ref;
    }

    const response = service.exportPublicationLog({
      actor,
      auth: op.auth ?? {},
      query
    });

    validateApiResponse(op.op, response);

    if (response.ok && op.save_export_ref) {
      exportRefs[op.save_export_ref] = clone(response.body);
    }

    let verify = { ok: null, error: null };
    let verifyWithPublicKey = { ok: null, error: null };

    if (response.ok) {
      verify = service.verifyPublicationExportPayload({ payload: response.body });
      verifyWithPublicKey = service.verifyPublicationExportPayloadWithPublicKeyPem({
        payload: response.body,
        publicKeyPem: activeKey.public_key_pem,
        keyId: activeKeyId,
        alg: activeKey.alg
      });
    }

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      entries_count: response.ok ? ((response.body.entries ?? []).length) : null,
      total_filtered: response.ok ? (response.body.total_filtered ?? null) : null,
      next_cursor: response.ok ? (response.body.next_cursor ?? null) : null,
      has_attestation: response.ok ? Boolean(response.body.attestation) : null,
      has_checkpoint: response.ok ? Boolean(response.body.checkpoint) : null,
      attestation_chain_hash: response.ok ? (response.body.attestation?.chain_hash ?? null) : null,
      checkpoint_hash: response.ok ? (response.body.checkpoint?.checkpoint_hash ?? null) : null,
      verify_ok: response.ok ? (verify.ok === true) : null,
      verify_error: response.ok ? (verify.ok ? null : (verify.error ?? null)) : null,
      verify_public_key_ok: response.ok ? (verifyWithPublicKey.ok === true) : null,
      verify_public_key_error: response.ok ? (verifyWithPublicKey.ok ? null : (verifyWithPublicKey.error ?? null)) : null
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
  transparency_log_export_checkpoints: clone(store.state.transparency_log_export_checkpoints ?? {})
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
