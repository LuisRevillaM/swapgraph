import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { VaultCustodyPublicationService } from '../src/vault/custodyPublicationService.mjs';
import { verifyCustodyInclusionProof } from '../src/custody/proofOfCustody.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

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

function flipHexTail(hex) {
  const s = String(hex ?? '');
  if (!s) return s;
  const tail = s.slice(-1);
  const repl = tail === '0' ? '1' : '0';
  return `${s.slice(0, -1)}${repl}`;
}

const schemasDir = path.join(root, 'docs/spec/schemas');
const actorRefSchema = readJson(path.join(schemasDir, 'ActorRef.schema.json'));
const assetRefSchema = readJson(path.join(schemasDir, 'AssetRef.schema.json'));
const custodyHoldingSchema = readJson(path.join(schemasDir, 'CustodyHolding.schema.json'));
const custodySnapshotSchema = readJson(path.join(schemasDir, 'CustodySnapshot.schema.json'));
const custodyInclusionProofSchema = readJson(path.join(schemasDir, 'CustodyInclusionProof.schema.json'));

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(actorRefSchema);
ajv.addSchema(assetRefSchema);
ajv.addSchema(custodyHoldingSchema);
ajv.addSchema(custodySnapshotSchema);
ajv.addSchema(custodyInclusionProofSchema);

const validateSnapshot = ajv.getSchema(custodySnapshotSchema.$id) ?? ajv.compile(custodySnapshotSchema);
const validateProof = ajv.getSchema(custodyInclusionProofSchema.$id) ?? ajv.compile(custodyInclusionProofSchema);

const scenario = readJson(path.join(root, 'fixtures/vault/m48_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/vault/m48_expected.json'));

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();
store.save();

const svc = new VaultCustodyPublicationService({ store });
const actors = scenario.actors ?? {};

const snapshotRefs = {};
const proofRefs = {};
const operations = [];

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  if (op.op === 'custody.publish') {
    const r = svc.publishSnapshot({
      actor,
      idempotencyKey: op.idempotency_key,
      requestBody: op.request,
      nowIso: op.now_iso
    });

    const response = r.result;
    const summary = response.ok ? response.body.snapshot : null;

    if (summary?.root_hash && !/^[a-f0-9]{64}$/.test(summary.root_hash)) {
      throw new Error(`invalid root hash from custody.publish: ${summary.root_hash}`);
    }

    if (response.ok) {
      const snapshot = store.state.vault_custody_snapshots?.[summary.snapshot_id] ?? null;
      if (!snapshot) throw new Error(`published snapshot missing in state: ${summary.snapshot_id}`);
      if (!validateSnapshot(snapshot)) {
        throw new Error(`published snapshot schema invalid: ${JSON.stringify(validateSnapshot.errors ?? [])}`);
      }
      if (op.save_snapshot_ref) snapshotRefs[op.save_snapshot_ref] = clone(snapshot);
    }

    const record = {
      op: op.op,
      actor,
      replayed: r.replayed,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error?.details?.reason_code ?? null),
      snapshot_id: summary?.snapshot_id ?? op.request?.snapshot_id ?? null,
      leaf_count: summary?.leaf_count ?? null,
      root_hash: summary?.root_hash ?? null
    };

    operations.push(record);

    if (typeof op.expect_ok === 'boolean') assert.equal(record.ok, op.expect_ok);
    if (typeof op.expect_replayed === 'boolean') assert.equal(record.replayed, op.expect_replayed);
    if (op.expect_error_code) assert.equal(record.error_code, op.expect_error_code);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_reason_code')) assert.equal(record.reason_code, op.expect_reason_code ?? null);
    if (typeof op.expect_leaf_count === 'number') assert.equal(record.leaf_count, op.expect_leaf_count);
    continue;
  }

  if (op.op === 'custody.list') {
    const response = svc.listSnapshots({ actor, query: op.query ?? {} });

    const record = {
      op: op.op,
      actor,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error?.details?.reason_code ?? null),
      snapshot_ids: response.ok ? (response.body.snapshots ?? []).map(s => s.snapshot_id) : null,
      leaf_counts: response.ok ? (response.body.snapshots ?? []).map(s => s.leaf_count) : null,
      next_cursor: response.ok ? (response.body.next_cursor ?? null) : null,
      total: response.ok ? response.body.total : null
    };

    operations.push(record);

    if (typeof op.expect_ok === 'boolean') assert.equal(record.ok, op.expect_ok);
    if (op.expect_error_code) assert.equal(record.error_code, op.expect_error_code);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_reason_code')) assert.equal(record.reason_code, op.expect_reason_code ?? null);
    if (Array.isArray(op.expect_snapshot_ids)) assert.deepEqual(record.snapshot_ids, op.expect_snapshot_ids);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_next_cursor')) assert.equal(record.next_cursor, op.expect_next_cursor);
    continue;
  }

  if (op.op === 'custody.get') {
    const response = svc.getSnapshot({ actor, snapshotId: op.snapshot_id });

    if (response.ok && !validateSnapshot(response.body.snapshot)) {
      throw new Error(`custody.get snapshot schema invalid: ${JSON.stringify(validateSnapshot.errors ?? [])}`);
    }

    const record = {
      op: op.op,
      actor,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error?.details?.reason_code ?? null),
      snapshot_id: response.ok ? response.body.snapshot.snapshot_id : op.snapshot_id,
      leaf_count: response.ok ? response.body.snapshot.leaf_count : null,
      root_hash: response.ok ? response.body.snapshot.root_hash : null
    };

    operations.push(record);

    if (typeof op.expect_ok === 'boolean') assert.equal(record.ok, op.expect_ok);
    if (op.expect_error_code) assert.equal(record.error_code, op.expect_error_code);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_reason_code')) assert.equal(record.reason_code, op.expect_reason_code ?? null);
    if (typeof op.expect_leaf_count === 'number') assert.equal(record.leaf_count, op.expect_leaf_count);
    continue;
  }

  if (op.op === 'custody.proof') {
    const response = svc.getInclusionProof({ actor, snapshotId: op.snapshot_id, holdingId: op.holding_id });

    let verifyOk = null;
    let verifyError = null;

    if (response.ok) {
      if (!validateProof(response.body.proof)) {
        throw new Error(`custody.proof schema invalid: ${JSON.stringify(validateProof.errors ?? [])}`);
      }

      const snapshot = store.state.vault_custody_snapshots?.[response.body.snapshot_id] ?? null;
      if (!snapshot) throw new Error(`snapshot missing for proof: ${response.body.snapshot_id}`);

      const verified = verifyCustodyInclusionProof({
        snapshot,
        holding: response.body.holding,
        proof: response.body.proof
      });

      verifyOk = verified.ok;
      verifyError = verified.ok ? null : verified.error;

      if (op.save_proof_ref) {
        proofRefs[op.save_proof_ref] = {
          snapshot: clone(snapshot),
          holding: clone(response.body.holding),
          proof: clone(response.body.proof)
        };
      }
    }

    const record = {
      op: op.op,
      actor,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error?.details?.reason_code ?? null),
      snapshot_id: response.ok ? response.body.snapshot_id : op.snapshot_id,
      holding_id: response.ok ? response.body.holding?.holding_id ?? null : op.holding_id,
      proof_leaf_index: response.ok ? response.body.proof?.leaf_index ?? null : null,
      proof_siblings_count: response.ok ? (response.body.proof?.siblings ?? []).length : null,
      verify_ok: verifyOk,
      verify_error: verifyError
    };

    operations.push(record);

    if (typeof op.expect_ok === 'boolean') assert.equal(record.ok, op.expect_ok);
    if (op.expect_error_code) assert.equal(record.error_code, op.expect_error_code);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_reason_code')) assert.equal(record.reason_code, op.expect_reason_code ?? null);
    if (typeof op.expect_verify_ok === 'boolean') assert.equal(record.verify_ok, op.expect_verify_ok);
    continue;
  }

  if (op.op === 'custody.proof.verify_tampered') {
    const ref = proofRefs[op.proof_ref];
    if (!ref) throw new Error(`missing proof ref: ${op.proof_ref}`);

    const tampered = clone(ref.proof);

    if (op.tamper?.kind === 'sibling_hash') {
      const idx = Number.isInteger(op.tamper?.index) ? op.tamper.index : 0;
      if (!tampered.siblings?.[idx]) throw new Error(`missing sibling index for tamper: ${idx}`);
      tampered.siblings[idx].hash = flipHexTail(tampered.siblings[idx].hash);
    } else if (op.tamper?.kind === 'leaf_hash') {
      tampered.leaf_hash = flipHexTail(tampered.leaf_hash);
    } else {
      throw new Error(`unsupported tamper kind: ${op.tamper?.kind}`);
    }

    const verified = verifyCustodyInclusionProof({
      snapshot: ref.snapshot,
      holding: ref.holding,
      proof: tampered
    });

    const record = {
      op: op.op,
      proof_ref: op.proof_ref,
      tamper_kind: op.tamper?.kind ?? null,
      verify_ok: verified.ok,
      verify_error: verified.ok ? null : verified.error
    };

    operations.push(record);

    if (typeof op.expect_verify_ok === 'boolean') assert.equal(record.verify_ok, op.expect_verify_ok);
    if (op.expect_verify_error) assert.equal(record.verify_error, op.expect_verify_error);
    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

store.save();

const snapshotIds = [...(store.state.vault_custody_snapshot_order ?? [])];
const finalSnapshots = snapshotIds.map(snapshotId => {
  const snapshot = store.state.vault_custody_snapshots?.[snapshotId];
  return {
    snapshot_id: snapshotId,
    recorded_at: snapshot?.recorded_at ?? null,
    leaf_count: snapshot?.leaf_count ?? null,
    root_hash: snapshot?.root_hash ?? null,
    holding_ids: (snapshot?.holdings ?? []).map(e => e?.holding?.holding_id ?? null)
  };
});

const out = canonicalize({
  operations,
  final: {
    snapshot_count: finalSnapshots.length,
    snapshots: finalSnapshots
  }
});

writeFileSync(path.join(outDir, 'vault_custody_publication_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M48', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length, snapshots: finalSnapshots.length } }, null, 2));
