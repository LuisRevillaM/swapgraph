import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { InclusionProofLinkageService } from '../src/service/inclusionProofLinkageService.mjs';
import {
  verifyInclusionProofLinkageExportPayload,
  verifyInclusionProofLinkageExportPayloadWithPublicKeyPem
} from '../src/crypto/policyIntegritySigning.mjs';
import { signReceipt } from '../src/crypto/receiptSigning.mjs';
import { buildCustodySnapshot } from '../src/custody/proofOfCustody.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M88';
const SCENARIO_FILE = 'fixtures/inclusion/m88_scenario.json';
const EXPECTED_FILE = 'fixtures/inclusion/m88_expected.json';
const OUTPUT_FILE = 'inclusion_proof_linkage_output.json';

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

function seedReceipts({ store, receipts }) {
  store.state.receipts ||= {};
  for (const seed of receipts ?? []) {
    const unsigned = {
      id: seed.receipt_id,
      cycle_id: seed.cycle_id,
      final_state: seed.final_state ?? 'completed',
      completed_at: seed.completed_at ?? '2026-02-20T10:00:00.000Z',
      transparency: {
        reason_code: seed.reason_code ?? null
      }
    };

    const signature = signReceipt(unsigned);
    if (seed.tamper_signature === true) {
      signature.sig = `${signature.sig.slice(2)}aa`;
    }

    store.state.receipts[seed.cycle_id] = {
      ...unsigned,
      signature
    };
  }
}

function seedCustodySnapshots({ store, snapshots }) {
  store.state.vault_custody_snapshots ||= {};
  store.state.vault_custody_snapshot_order ||= [];

  for (const seed of snapshots ?? []) {
    const snapshot = buildCustodySnapshot({
      snapshotId: seed.snapshot_id,
      recordedAt: seed.recorded_at,
      holdings: seed.holdings ?? []
    });

    store.state.vault_custody_snapshots[seed.snapshot_id] = snapshot;
    if (!store.state.vault_custody_snapshot_order.includes(seed.snapshot_id)) {
      store.state.vault_custody_snapshot_order.push(seed.snapshot_id);
    }
  }
}

function seedTransparencyPublications({ store, publications }) {
  store.state.transparency_log_publications ||= [];
  store.state.transparency_log_publication_counter ||= 0;

  for (const seed of publications ?? []) {
    const rec = {
      publication_id: seed.publication_id,
      publication_index: seed.publication_index,
      partner_id: seed.partner_id,
      source_type: seed.source_type,
      source_ref: seed.source_ref,
      root_hash: seed.root_hash,
      previous_root_hash: seed.previous_root_hash ?? null,
      previous_chain_hash: seed.previous_chain_hash ?? null,
      chain_hash: seed.chain_hash,
      entry_count: seed.entry_count,
      artifact_refs: seed.artifact_refs ?? [],
      linked_receipt_ids: seed.linked_receipt_ids ?? [],
      linked_governance_artifact_ids: seed.linked_governance_artifact_ids ?? [],
      ...(seed.notes ? { notes: seed.notes } : {}),
      integration_mode: 'fixture_only',
      published_at: seed.published_at
    };

    store.state.transparency_log_publications.push(rec);
  }

  store.state.transparency_log_publications.sort((a, b) => Number(a.publication_index ?? 0) - Number(b.publication_index ?? 0));
  const maxIndex = store.state.transparency_log_publications.reduce((m, x) => Math.max(m, Number(x.publication_index ?? 0)), 0);
  store.state.transparency_log_publication_counter = maxIndex;
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

seedReceipts({ store, receipts: scenario.seed?.receipts ?? [] });
seedCustodySnapshots({ store, snapshots: scenario.seed?.custody_snapshots ?? [] });
seedTransparencyPublications({ store, publications: scenario.seed?.transparency_publications ?? [] });

const service = new InclusionProofLinkageService({ store });
const exportRefs = {};
const operations = [];

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  if (op.op === 'inclusionProof.linkage.record') {
    if (!op.skip_request_validation) validateApiRequest(op.op, op.request ?? {});

    const response = service.recordLinkage({
      actor,
      auth: op.auth ?? {},
      idempotencyKey: op.idempotency_key,
      request: op.request ?? {}
    });
    validateApiResponse(op.op, response);

    const linkage = response.ok ? response.body.linkage ?? {} : {};

    const rec = {
      op: op.op,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      linkage_id: response.ok ? (linkage.linkage_id ?? null) : null,
      linkage_index: response.ok ? (linkage.linkage_index ?? null) : null,
      cycle_id: response.ok ? (linkage.cycle_id ?? null) : null,
      receipt_id: response.ok ? (linkage.receipt_id ?? null) : null,
      custody_snapshot_id: response.ok ? (linkage.custody_snapshot_id ?? null) : null,
      transparency_publication_id: response.ok ? (linkage.transparency_publication_id ?? null) : null,
      previous_linkage_hash: response.ok ? (linkage.previous_linkage_hash ?? null) : null,
      previous_linkage_hash_present: response.ok ? (typeof linkage.previous_linkage_hash === 'string' && /^[a-f0-9]{64}$/.test(linkage.previous_linkage_hash)) : null,
      linkage_hash_present: response.ok ? (typeof linkage.linkage_hash === 'string' && /^[a-f0-9]{64}$/.test(linkage.linkage_hash)) : null,
      replayed: response.ok ? (response.body.replayed === true) : null
    };

    operations.push(rec);
    applyExpectations(op, rec);
    continue;
  }

  if (op.op === 'inclusionProof.linkage.export') {
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

    const response = service.exportLinkages({ actor, auth: op.auth ?? {}, query });
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
      summary_total_linkages: response.ok ? (response.body.summary?.total_linkages ?? null) : null,
      summary_returned_count: response.ok ? (response.body.summary?.returned_count ?? null) : null,
      summary_linked_receipt_count: response.ok ? (response.body.summary?.linked_receipt_count ?? null) : null,
      total_filtered: response.ok ? (response.body.total_filtered ?? null) : null,
      next_cursor: response.ok ? (response.body.next_cursor ?? null) : null,
      first_linkage_id: response.ok ? (response.body.linkages?.[0]?.linkage_id ?? null) : null,
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

  if (op.op === 'inclusionProof.linkage.export.verify') {
    const ref = exportRefs[op.export_ref];
    if (!ref?.payload) throw new Error(`missing export_ref payload: ${op.export_ref}`);

    const verifyA = verifyInclusionProofLinkageExportPayload(ref.payload);
    const verifyB = verifyInclusionProofLinkageExportPayloadWithPublicKeyPem({
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

  if (op.op === 'inclusionProof.linkage.export.verify_tampered') {
    const ref = exportRefs[op.export_ref];
    if (!ref?.payload) throw new Error(`missing export_ref payload: ${op.export_ref}`);

    const tampered = clone(ref.payload);
    if (op.tamper === 'export_hash') {
      tampered.export_hash = 'f'.repeat(64);
    } else if (op.tamper === 'linkage_hash' && Array.isArray(tampered.linkages) && tampered.linkages.length > 0) {
      tampered.linkages[0].linkage_hash = '0'.repeat(64);
    } else {
      tampered.export_hash = 'f'.repeat(64);
    }

    const verifyA = verifyInclusionProofLinkageExportPayload(tampered);
    const verifyB = verifyInclusionProofLinkageExportPayloadWithPublicKeyPem({
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
  inclusion_proof_linkages: clone(store.state.inclusion_proof_linkages ?? []),
  inclusion_proof_export_checkpoints: clone(store.state.inclusion_proof_export_checkpoints ?? {}),
  inclusion_proof_linkage_counter: store.state.inclusion_proof_linkage_counter ?? 0,
  receipts: clone(store.state.receipts ?? {}),
  vault_custody_snapshots: clone(store.state.vault_custody_snapshots ?? {}),
  transparency_log_publications: clone(store.state.transparency_log_publications ?? [])
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
