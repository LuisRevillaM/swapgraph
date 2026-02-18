import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { VaultLifecycleService } from '../src/vault/vaultLifecycleService.mjs';
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

if (process.env.AUTHZ_ENFORCE !== '1') {
  console.error('AUTHZ_ENFORCE must be 1 for M49 scenario');
  process.exit(2);
}

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
const vaultHoldingSchema = readJson(path.join(schemasDir, 'VaultHolding.schema.json'));
const custodyHoldingSchema = readJson(path.join(schemasDir, 'CustodyHolding.schema.json'));
const custodySnapshotSchema = readJson(path.join(schemasDir, 'CustodySnapshot.schema.json'));
const custodyInclusionProofSchema = readJson(path.join(schemasDir, 'CustodyInclusionProof.schema.json'));

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(actorRefSchema);
ajv.addSchema(assetRefSchema);
ajv.addSchema(vaultHoldingSchema);
ajv.addSchema(custodyHoldingSchema);
ajv.addSchema(custodySnapshotSchema);
ajv.addSchema(custodyInclusionProofSchema);

const validateVaultHolding = ajv.getSchema(vaultHoldingSchema.$id) ?? ajv.compile(vaultHoldingSchema);
const validateCustodySnapshot = ajv.getSchema(custodySnapshotSchema.$id) ?? ajv.compile(custodySnapshotSchema);
const validateCustodyProof = ajv.getSchema(custodyInclusionProofSchema.$id) ?? ajv.compile(custodyInclusionProofSchema);

const scenario = readJson(path.join(root, 'fixtures/vault/m49_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/vault/m49_expected.json'));

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();
store.save();

const vaultSvc = new VaultLifecycleService({ store });
const custodySvc = new VaultCustodyPublicationService({ store });

const actors = scenario.actors ?? {};
const snapshotRefs = {};
const proofRefs = {};
const operations = [];

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  if (op.op.startsWith('vault.')) {
    let replayed = null;
    let response;

    if (op.op === 'vault.deposit') {
      const r = vaultSvc.deposit({
        actor,
        auth: op.auth ?? {},
        idempotencyKey: op.idempotency_key,
        requestBody: op.request,
        nowIso: op.now_iso
      });
      replayed = r.replayed;
      response = r.result;
    } else if (op.op === 'vault.reserve') {
      const r = vaultSvc.reserve({
        actor,
        auth: op.auth ?? {},
        idempotencyKey: op.idempotency_key,
        requestBody: op.request,
        nowIso: op.now_iso
      });
      replayed = r.replayed;
      response = r.result;
    } else if (op.op === 'vault.release') {
      const r = vaultSvc.release({
        actor,
        auth: op.auth ?? {},
        idempotencyKey: op.idempotency_key,
        requestBody: op.request,
        nowIso: op.now_iso
      });
      replayed = r.replayed;
      response = r.result;
    } else if (op.op === 'vault.withdraw') {
      const r = vaultSvc.withdraw({
        actor,
        auth: op.auth ?? {},
        idempotencyKey: op.idempotency_key,
        requestBody: op.request,
        nowIso: op.now_iso
      });
      replayed = r.replayed;
      response = r.result;
    } else if (op.op === 'vault.get') {
      response = vaultSvc.get({
        actor,
        auth: op.auth ?? {},
        holdingId: op.holding_id
      });
    } else if (op.op === 'vault.list') {
      response = vaultSvc.list({
        actor,
        auth: op.auth ?? {},
        query: op.query ?? {}
      });
    } else {
      throw new Error(`unsupported vault op: ${op.op}`);
    }

    if (response?.ok && response.body?.holding) {
      if (!validateVaultHolding(response.body.holding)) {
        throw new Error(`vault holding schema invalid for op=${op.op}: ${JSON.stringify(validateVaultHolding.errors ?? [])}`);
      }
    }

    if (response?.ok && Array.isArray(response.body?.holdings)) {
      for (const holding of response.body.holdings) {
        if (!validateVaultHolding(holding)) {
          throw new Error(`vault list holding schema invalid for op=${op.op}: ${JSON.stringify(validateVaultHolding.errors ?? [])}`);
        }
      }
    }

    const record = {
      op: op.op,
      actor,
      ok: !!response?.ok,
      replayed,
      error_code: response?.ok ? null : (response?.body?.error?.code ?? null),
      reason_code: response?.ok ? null : (response?.body?.error?.details?.reason_code ?? null),
      holding_id: response?.body?.holding?.holding_id ?? op?.holding_id ?? op?.request?.holding_id ?? op?.request?.holding?.holding_id ?? null,
      status: response?.ok ? (response?.body?.holding?.status ?? null) : null,
      reservation_id: response?.ok ? (response?.body?.holding?.reservation_id ?? null) : null,
      list_count: response?.ok && Array.isArray(response?.body?.holdings) ? response.body.holdings.length : null,
      list_statuses: response?.ok && Array.isArray(response?.body?.holdings) ? response.body.holdings.map(h => h.status) : null
    };

    operations.push(record);

    if (typeof op.expect_ok === 'boolean') assert.equal(record.ok, op.expect_ok);
    if (typeof op.expect_replayed === 'boolean') assert.equal(record.replayed, op.expect_replayed);
    if (op.expect_error_code) assert.equal(record.error_code, op.expect_error_code);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_reason_code')) assert.equal(record.reason_code, op.expect_reason_code ?? null);
    if (op.expect_status) assert.equal(record.status, op.expect_status);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_reservation_id')) assert.equal(record.reservation_id, op.expect_reservation_id);
    if (typeof op.expect_list_count === 'number') assert.equal(record.list_count, op.expect_list_count);
    if (Array.isArray(op.expect_list_statuses)) assert.deepEqual(record.list_statuses, op.expect_list_statuses);
    continue;
  }

  if (op.op.startsWith('custody.')) {
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

    let replayed = null;
    let response;

    if (op.op === 'custody.publish') {
      const r = custodySvc.publishSnapshot({
        actor,
        auth: op.auth ?? {},
        idempotencyKey: op.idempotency_key,
        requestBody: op.request,
        nowIso: op.now_iso
      });
      replayed = r.replayed;
      response = r.result;

      if (response.ok) {
        const snapshotId = response.body.snapshot?.snapshot_id;
        const snapshot = snapshotId ? store.state.vault_custody_snapshots?.[snapshotId] : null;
        if (!snapshot) throw new Error(`published custody snapshot missing in state: ${snapshotId}`);
        if (!validateCustodySnapshot(snapshot)) {
          throw new Error(`custody snapshot schema invalid for op=${op.op}: ${JSON.stringify(validateCustodySnapshot.errors ?? [])}`);
        }
        if (op.save_snapshot_ref) snapshotRefs[op.save_snapshot_ref] = clone(snapshot);
      }

      const record = {
        op: op.op,
        actor,
        ok: response.ok,
        replayed,
        error_code: response.ok ? null : response.body.error.code,
        reason_code: response.ok ? null : (response.body.error?.details?.reason_code ?? null),
        snapshot_id: response.ok ? response.body.snapshot?.snapshot_id ?? null : op.request?.snapshot_id ?? null,
        leaf_count: response.ok ? response.body.snapshot?.leaf_count ?? null : null,
        root_hash: response.ok ? response.body.snapshot?.root_hash ?? null : null
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
      response = custodySvc.listSnapshots({ actor, auth: op.auth ?? {}, query: op.query ?? {} });

      const record = {
        op: op.op,
        actor,
        ok: response.ok,
        replayed,
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
      continue;
    }

    if (op.op === 'custody.get') {
      response = custodySvc.getSnapshot({ actor, auth: op.auth ?? {}, snapshotId: op.snapshot_id });

      if (response.ok && !validateCustodySnapshot(response.body.snapshot)) {
        throw new Error(`custody.get snapshot schema invalid: ${JSON.stringify(validateCustodySnapshot.errors ?? [])}`);
      }

      const record = {
        op: op.op,
        actor,
        ok: response.ok,
        replayed,
        error_code: response.ok ? null : response.body.error.code,
        reason_code: response.ok ? null : (response.body.error?.details?.reason_code ?? null),
        snapshot_id: response.ok ? response.body.snapshot?.snapshot_id ?? null : op.snapshot_id,
        leaf_count: response.ok ? response.body.snapshot?.leaf_count ?? null : null,
        root_hash: response.ok ? response.body.snapshot?.root_hash ?? null : null
      };

      operations.push(record);

      if (typeof op.expect_ok === 'boolean') assert.equal(record.ok, op.expect_ok);
      if (op.expect_error_code) assert.equal(record.error_code, op.expect_error_code);
      if (Object.prototype.hasOwnProperty.call(op, 'expect_reason_code')) assert.equal(record.reason_code, op.expect_reason_code ?? null);
      if (typeof op.expect_leaf_count === 'number') assert.equal(record.leaf_count, op.expect_leaf_count);
      continue;
    }

    if (op.op === 'custody.proof') {
      response = custodySvc.getInclusionProof({
        actor,
        auth: op.auth ?? {},
        snapshotId: op.snapshot_id,
        holdingId: op.holding_id
      });

      let verifyOk = null;
      let verifyError = null;

      if (response.ok) {
        if (!validateCustodyProof(response.body.proof)) {
          throw new Error(`custody proof schema invalid: ${JSON.stringify(validateCustodyProof.errors ?? [])}`);
        }

        const snapshot = store.state.vault_custody_snapshots?.[response.body.snapshot_id] ?? null;
        if (!snapshot) throw new Error(`snapshot missing for proof verification: ${response.body.snapshot_id}`);

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
        replayed,
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

    throw new Error(`unsupported custody op: ${op.op}`);
  }

  throw new Error(`unsupported op namespace: ${op.op}`);
}

store.save();

const finalVaultHoldings = Object.values(store.state.vault_holdings ?? {})
  .sort((a, b) => String(a.holding_id).localeCompare(String(b.holding_id)))
  .map(h => ({
    holding_id: h.holding_id,
    owner_actor: h.owner_actor,
    status: h.status,
    reservation_id: h.reservation_id ?? null,
    withdrawn_at: h.withdrawn_at ?? null
  }));

const finalSnapshots = (store.state.vault_custody_snapshot_order ?? []).map(snapshotId => {
  const snapshot = store.state.vault_custody_snapshots?.[snapshotId] ?? null;
  return {
    snapshot_id: snapshotId,
    leaf_count: snapshot?.leaf_count ?? null,
    root_hash: snapshot?.root_hash ?? null,
    holding_ids: (snapshot?.holdings ?? []).map(entry => entry?.holding?.holding_id ?? null)
  };
});

const out = canonicalize({
  operations,
  final: {
    vault_holding_ids: finalVaultHoldings.map(h => h.holding_id),
    vault_holdings: finalVaultHoldings,
    vault_event_count: (store.state.vault_events ?? []).length,
    vault_event_types: (store.state.vault_events ?? []).map(e => e.event_type),
    custody_snapshot_ids: finalSnapshots.map(s => s.snapshot_id),
    custody_snapshots: finalSnapshots
  }
});

writeFileSync(path.join(outDir, 'vault_auth_surface_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M49', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length, vault_holdings: finalVaultHoldings.length, custody_snapshots: finalSnapshots.length } }, null, 2));
