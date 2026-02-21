import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { StagingEvidenceConformanceService } from '../src/service/stagingEvidenceConformanceService.mjs';
import { verifyStagingEvidenceBundleExportPayload } from '../src/crypto/policyIntegritySigning.mjs';
import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M97';
const SCENARIO_FILE = 'fixtures/release/m97_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m97_expected.json';
const OUTPUT_FILE = 'staging_evidence_conformance_output.json';

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

function sha256HexCanonical(value) {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function normalizeEvidenceItems(items) {
  return (items ?? [])
    .map(item => ({
      artifact_ref: item?.artifact_ref,
      artifact_kind: item?.artifact_kind,
      sha256: item?.sha256,
      ...(item?.captured_at ? { captured_at: item.captured_at } : {})
    }))
    .sort((a, b) => `${a.artifact_ref ?? ''}|${a.artifact_kind ?? ''}|${a.sha256 ?? ''}`.localeCompare(`${b.artifact_ref ?? ''}|${b.artifact_kind ?? ''}|${b.sha256 ?? ''}`));
}

function bundleManifestInput(bundle) {
  return {
    milestone_id: bundle.milestone_id,
    environment: bundle.environment,
    runbook_ref: bundle.runbook_ref,
    collected_at: bundle.collected_at,
    evidence_items: normalizeEvidenceItems(bundle.evidence_items),
    ...(bundle.conformance_ref ? { conformance_ref: bundle.conformance_ref } : {}),
    ...(bundle.release_ref ? { release_ref: bundle.release_ref } : {}),
    ...(bundle.notes ? { notes: bundle.notes } : {})
  };
}

function computeManifestHash(bundle) {
  return sha256HexCanonical(bundleManifestInput(bundle));
}

function computeCheckpointHash(bundle) {
  return sha256HexCanonical({
    checkpoint_after: bundle.checkpoint_after ?? null,
    bundle_id: bundle.bundle_id,
    manifest_hash: bundle.manifest_hash,
    collected_at: bundle.collected_at,
    recorded_at: bundle.recorded_at
  });
}

function bundleCursorKey(row) {
  const recordedAt = typeof row?.recorded_at === 'string' ? row.recorded_at : '';
  const bundleId = typeof row?.bundle_id === 'string' ? row.bundle_id : '';
  return `${recordedAt}|${bundleId}`;
}

function validateManifestIntegrity(bundle) {
  return computeManifestHash(bundle) === bundle?.manifest_hash;
}

function validateCheckpointIntegrity(bundle) {
  return computeCheckpointHash(bundle) === bundle?.checkpoint_hash;
}

function validateCheckpointChain(bundles) {
  const rows = (bundles ?? [])
    .map(row => row)
    .sort((a, b) => bundleCursorKey(a).localeCompare(bundleCursorKey(b)));

  let prevCheckpoint = null;
  for (const row of rows) {
    if ((row?.checkpoint_after ?? null) !== prevCheckpoint) return false;
    if (!validateManifestIntegrity(row)) return false;
    if (!validateCheckpointIntegrity(row)) return false;
    prevCheckpoint = row?.checkpoint_hash ?? null;
  }

  return true;
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
    try {
      assert.deepEqual(rec[field], v);
    } catch {
      throw new Error(`expectation_failed op=${op.op} idempotency_key=${op.idempotency_key ?? 'n/a'} field=${field} expected=${JSON.stringify(v)} actual=${JSON.stringify(rec[field])}`);
    }
  }
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const actors = scenario.actors ?? {};

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();

const service = new StagingEvidenceConformanceService({ store });
const operations = [];
const bundleRefs = new Map();

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  if (op.op === 'staging.evidence_bundle.record') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = service.recordBundle({
      actor,
      auth: op.auth ?? {},
      idempotencyKey: op.idempotency_key,
      request: op.request ?? {}
    });
    validateApiResponse(op.op, response);

    const bundle = response.ok ? (response.body.bundle ?? null) : null;
    if (response.ok && bundle?.bundle_id) {
      bundleRefs.set(bundle.bundle_id, clone(bundle));
    }

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      bundle_id: response.ok ? (bundle?.bundle_id ?? null) : null,
      milestone_id: response.ok ? (bundle?.milestone_id ?? null) : null,
      evidence_count: response.ok ? (bundle?.evidence_count ?? null) : null,
      manifest_hash_valid: response.ok ? validateManifestIntegrity(bundle) : null,
      checkpoint_hash_valid: response.ok ? validateCheckpointIntegrity(bundle) : null,
      checkpoint_after_present: response.ok ? (typeof bundle?.checkpoint_after === 'string' && bundle.checkpoint_after.length > 0) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'staging.evidence_bundle.export') {
    const query = clone(op.query ?? {});

    if (typeof op.checkpoint_after_from_bundle_id === 'string') {
      const ref = bundleRefs.get(op.checkpoint_after_from_bundle_id) ?? null;
      if (!ref) throw new Error(`unknown checkpoint ref bundle_id=${op.checkpoint_after_from_bundle_id}`);
      query.checkpoint_after = ref.checkpoint_hash;
    }

    const response = service.exportBundles({
      actor,
      auth: op.auth ?? {},
      query
    });
    validateApiResponse(op.op, response);

    let signatureValid = null;
    let tamperSignatureValid = null;
    let manifestIntegrityValid = null;
    let checkpointIntegrityValid = null;

    if (response.ok) {
      signatureValid = verifyStagingEvidenceBundleExportPayload(response.body).ok;

      const tampered = clone(response.body);
      tampered.export_hash = tampered.export_hash.replace(/.$/, tampered.export_hash.endsWith('0') ? '1' : '0');
      tamperSignatureValid = verifyStagingEvidenceBundleExportPayload(tampered).ok;

      const bundles = response.body.bundles ?? [];
      manifestIntegrityValid = bundles.every(validateManifestIntegrity);
      checkpointIntegrityValid = bundles.every(validateCheckpointIntegrity);
    }

    const summary = response.ok ? (response.body.summary ?? {}) : {};
    const bundles = response.ok ? (response.body.bundles ?? []) : [];

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      total_bundles: response.ok ? (summary.total_bundles ?? null) : null,
      returned_bundles: response.ok ? (summary.returned_bundles ?? null) : null,
      total_evidence_items: response.ok ? (summary.total_evidence_items ?? null) : null,
      returned_evidence_items: response.ok ? (summary.returned_evidence_items ?? null) : null,
      total_filtered: response.ok ? (response.body.total_filtered ?? null) : null,
      bundles_count: response.ok ? bundles.length : null,
      first_bundle_id: response.ok && bundles.length > 0 ? (bundles[0].bundle_id ?? null) : null,
      last_bundle_id: response.ok && bundles.length > 0 ? (bundles[bundles.length - 1].bundle_id ?? null) : null,
      next_cursor_present: response.ok ? (typeof response.body.next_cursor === 'string' && response.body.next_cursor.length > 0) : null,
      signature_valid: response.ok ? signatureValid : null,
      tamper_signature_valid: response.ok ? tamperSignatureValid : null,
      attestation_present: response.ok ? (response.body.attestation && typeof response.body.attestation === 'object') : null,
      checkpoint_present: response.ok ? (response.body.checkpoint && typeof response.body.checkpoint === 'object') : null,
      manifest_integrity_valid: response.ok ? manifestIntegrityValid : null,
      checkpoint_integrity_valid: response.ok ? checkpointIntegrityValid : null,
      integration_mode: response.ok ? (response.body.integration_mode ?? null) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

store.save();

const finalBundles = clone(store.state.staging_evidence_bundles ?? []);
const final = {
  staging_evidence_bundles: finalBundles,
  staging_evidence_bundle_counter: clone(store.state.staging_evidence_bundle_counter ?? 0),
  checkpoint_chain_valid: validateCheckpointChain(finalBundles)
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
