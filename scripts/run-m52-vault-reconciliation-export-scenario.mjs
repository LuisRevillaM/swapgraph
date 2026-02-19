import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { CycleProposalsCommitService } from '../src/service/cycleProposalsCommitService.mjs';
import { SettlementWriteApiService } from '../src/service/settlementWriteApiService.mjs';
import { SettlementReadService } from '../src/read/settlementReadService.mjs';
import { VaultLifecycleService } from '../src/vault/vaultLifecycleService.mjs';
import { PolicyIntegritySigningService } from '../src/service/policyIntegritySigningService.mjs';
import {
  verifySettlementVaultReconciliationExportPayload,
  verifySettlementVaultReconciliationExportPayloadWithPublicKeyPem
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
  console.error('AUTHZ_ENFORCE must be 1 for M52 scenario');
  process.exit(2);
}

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

const scenario = readJson(path.join(root, 'fixtures/vault/m52_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/vault/m52_expected.json'));

const actors = scenario.actors ?? {};

const matchingInput = readJson(path.join(root, 'fixtures/matching/m5_input.json'));
const matchingOut = readJson(path.join(root, 'fixtures/matching/m5_expected.json'));

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();

for (const it of matchingInput.intents ?? []) {
  const intent = { ...it, status: it.status ?? 'active' };
  const v = validateAgainstSchemaFile('SwapIntent.schema.json', intent);
  if (!v.ok) throw new Error(`seed intent invalid: ${JSON.stringify(v.errors)}`);
  store.state.intents[intent.id] = intent;
}

store.state.proposals ||= {};
store.state.tenancy ||= {};
store.state.tenancy.proposals ||= {};

for (const proposal of matchingOut.proposals ?? []) {
  const v = validateAgainstSchemaFile('CycleProposal.schema.json', proposal);
  if (!v.ok) throw new Error(`seed proposal invalid: ${JSON.stringify(v.errors)}`);
  store.state.proposals[proposal.id] = proposal;
  store.state.tenancy.proposals[proposal.id] = { partner_id: actors.partner.id };
}

const p2 = (matchingOut.proposals ?? []).find(p => p.participants?.length === 2);
const p3 = (matchingOut.proposals ?? []).find(p => p.participants?.length === 3);
if (!p2 || !p3) throw new Error('expected both 2-participant and 3-participant proposals');

const proposalByRef = { p2, p3 };

const commitSvc = new CycleProposalsCommitService({ store });
const settlementWrite = new SettlementWriteApiService({ store });
const settlementRead = new SettlementReadService({ store });
const vaultSvc = new VaultLifecycleService({ store });
const policyIntegrityKeysSvc = new PolicyIntegritySigningService();

const publicKeysById = new Map();
const exportRefs = {};

function cycleIdForOp(op) {
  if (!op.proposal_ref) return op.cycle_id ?? null;
  return proposalByRef?.[op.proposal_ref]?.id ?? null;
}

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

const operations = [];

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  const cycleId = cycleIdForOp(op);

  if (op.op === 'keys.policy_integrity_signing.get') {
    const response = policyIntegrityKeysSvc.getSigningKeys();
    validateApiResponse(op.op, response);

    const keyStatuses = {};
    for (const key of response.body.keys ?? []) {
      keyStatuses[key.key_id] = key.status;
      publicKeysById.set(key.key_id, key.public_key_pem);
    }

    const record = {
      op: op.op,
      ok: response.ok,
      active_key_id: response.body.active_key_id,
      keys_count: (response.body.keys ?? []).length,
      key_statuses: keyStatuses
    };
    operations.push(record);

    if (typeof op.expect_ok === 'boolean') assert.equal(record.ok, op.expect_ok);
    if (typeof op.expect_keys_count === 'number') assert.equal(record.keys_count, op.expect_keys_count);
    continue;
  }

  if (op.op === 'cycleProposals.accept') {
    const requestBody = { proposal_id: cycleId };
    validateApiRequest(op.op, requestBody);

    const r = commitSvc.accept({
      actor,
      auth: op.auth ?? {},
      idempotencyKey: op.idempotency_key,
      proposalId: cycleId,
      requestBody,
      occurredAt: op.occurred_at
    });

    const response = r.result;
    validateApiResponse(op.op, response);

    operations.push({
      op: op.op,
      cycle_id: cycleId,
      actor,
      ok: response.ok,
      replayed: r.replayed,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      commit_phase: response.ok ? response.body.commit.phase : null
    });

    continue;
  }

  if (op.op.startsWith('vault.')) {
    let replayed = null;
    let response;

    if (op.op === 'vault.deposit') {
      validateApiRequest(op.op, op.request ?? {});
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
      validateApiRequest(op.op, op.request ?? {});
      const r = vaultSvc.reserve({
        actor,
        auth: op.auth ?? {},
        idempotencyKey: op.idempotency_key,
        requestBody: op.request,
        nowIso: op.now_iso
      });
      replayed = r.replayed;
      response = r.result;
    } else {
      throw new Error(`unsupported vault op in M52: ${op.op}`);
    }

    validateApiResponse(op.op, response);

    operations.push({
      op: op.op,
      cycle_id: cycleId,
      actor,
      ok: response.ok,
      replayed,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      holding_id: response.ok ? (response.body.holding?.holding_id ?? null) : (op.request?.holding_id ?? op.request?.holding?.holding_id ?? null),
      holding_status: response.ok ? (response.body.holding?.status ?? null) : null,
      reservation_id: response.ok ? (response.body.holding?.reservation_id ?? null) : null,
      settlement_cycle_id: response.ok ? (response.body.holding?.settlement_cycle_id ?? null) : null,
      withdrawn_at: response.ok ? (response.body.holding?.withdrawn_at ?? null) : null
    });

    continue;
  }

  if (op.op.startsWith('settlement.')) {
    if (op.op === 'settlement.vault_reconciliation.export.verify') {
      const payload = exportRefs[op.export_ref];
      if (!payload) throw new Error(`missing export_ref: ${op.export_ref}`);

      const verified = verifySettlementVaultReconciliationExportPayload(payload);

      const keyId = payload.signature?.key_id;
      const publicKeyPem = keyId ? publicKeysById.get(keyId) : null;
      const verifiedPublic = publicKeyPem
        ? verifySettlementVaultReconciliationExportPayloadWithPublicKeyPem({
            payload,
            publicKeyPem,
            keyId,
            alg: payload.signature?.alg
          })
        : { ok: false, error: 'missing_public_key' };

      const record = {
        op: op.op,
        export_ref: op.export_ref,
        verify_ok: verified.ok,
        verify_error: verified.ok ? null : verified.error,
        verify_public_ok: verifiedPublic.ok,
        verify_public_error: verifiedPublic.ok ? null : verifiedPublic.error
      };
      operations.push(record);

      if (typeof op.expect_verify_ok === 'boolean') assert.equal(record.verify_ok, op.expect_verify_ok);
      if (typeof op.expect_verify_public_ok === 'boolean') assert.equal(record.verify_public_ok, op.expect_verify_public_ok);
      continue;
    }

    if (op.op === 'settlement.vault_reconciliation.export.verify_tampered') {
      const payload = exportRefs[op.export_ref];
      if (!payload) throw new Error(`missing export_ref: ${op.export_ref}`);

      const tampered = clone(payload);
      if (op.tamper?.kind === 'reconciliation_summary') {
        const field = op.tamper.field;
        if (!tampered.vault_reconciliation?.summary || typeof field !== 'string') {
          throw new Error('invalid reconciliation_summary tamper config');
        }
        tampered.vault_reconciliation.summary[field] = op.tamper.value;
      } else if (op.tamper?.kind === 'state_transition') {
        if (!Array.isArray(tampered.state_transitions) || tampered.state_transitions.length === 0) {
          throw new Error('state_transitions unavailable for tamper');
        }
        tampered.state_transitions[0].to_state = op.tamper.to_state ?? 'failed';
      } else {
        throw new Error(`unsupported tamper kind: ${op.tamper?.kind}`);
      }

      const verified = verifySettlementVaultReconciliationExportPayload(tampered);

      const record = {
        op: op.op,
        export_ref: op.export_ref,
        tamper_kind: op.tamper?.kind ?? null,
        verify_ok: verified.ok,
        verify_error: verified.ok ? null : verified.error
      };
      operations.push(record);

      if (typeof op.expect_verify_ok === 'boolean') assert.equal(record.verify_ok, op.expect_verify_ok);
      if (op.expect_verify_error) assert.equal(record.verify_error, op.expect_verify_error);
      continue;
    }

    const requestBody = op.request_body ?? {};

    let response;
    if (op.op === 'settlement.start') {
      validateApiRequest(op.op, requestBody);
      response = settlementWrite.start({
        actor,
        auth: op.auth ?? {},
        cycleId,
        requestBody,
        occurredAt: op.occurred_at
      });
    } else if (op.op === 'settlement.begin_execution') {
      validateApiRequest(op.op, requestBody);
      response = settlementWrite.beginExecution({
        actor,
        auth: op.auth ?? {},
        cycleId,
        requestBody,
        occurredAt: op.occurred_at
      });
    } else if (op.op === 'settlement.complete') {
      validateApiRequest(op.op, requestBody);
      response = settlementWrite.complete({
        actor,
        auth: op.auth ?? {},
        cycleId,
        requestBody,
        occurredAt: op.occurred_at
      });
    } else if (op.op === 'settlement.expire_deposit_window') {
      validateApiRequest(op.op, requestBody);
      response = settlementWrite.expireDepositWindow({
        actor,
        auth: op.auth ?? {},
        cycleId,
        requestBody
      });
    } else if (op.op === 'settlement.vault_reconciliation.export') {
      response = settlementRead.vaultReconciliationExport({
        actor,
        auth: op.auth ?? {},
        cycleId,
        query: op.query ?? {}
      });
    } else {
      throw new Error(`unsupported settlement op in M52: ${op.op}`);
    }

    validateApiResponse(op.op, response);

    if (op.op === 'settlement.vault_reconciliation.export' && response.ok && op.save_export_ref) {
      exportRefs[op.save_export_ref] = clone(response.body);
    }

    const vaultReconciliation = response.ok ? response.body.vault_reconciliation : null;
    const transitionsCount = response.ok && Array.isArray(response.body.state_transitions)
      ? response.body.state_transitions.length
      : 0;

    const record = {
      op: op.op,
      cycle_id: cycleId,
      actor,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      correlation_id: response.ok ? (response.body.correlation_id ?? null) : null,
      timeline_state: response.ok ? (response.body.timeline_state ?? response.body.timeline?.state ?? null) : null,
      reconciliation_mode: vaultReconciliation?.summary?.mode ?? null,
      reconciliation_total: vaultReconciliation?.summary?.total ?? null,
      reconciliation_reserved: vaultReconciliation?.summary?.reserved ?? null,
      reconciliation_withdrawn: vaultReconciliation?.summary?.withdrawn ?? null,
      reconciliation_available: vaultReconciliation?.summary?.available ?? null,
      transitions_count: transitionsCount,
      export_hash: response.ok ? (response.body.export_hash ?? null) : null,
      signature_key_id: response.ok ? (response.body.signature?.key_id ?? null) : null,
      no_op: response.ok ? (response.body.no_op === true) : false,
      receipt_id: response.ok ? (response.body.receipt?.id ?? null) : null,
      receipt_final_state: response.ok ? (response.body.receipt?.final_state ?? null) : null
    };

    operations.push(record);

    if (Object.prototype.hasOwnProperty.call(op, 'expect_ok')) assert.equal(record.ok, op.expect_ok);
    if (op.expect_error_code) assert.equal(record.error_code, op.expect_error_code);
    if (op.expect_timeline_state) assert.equal(record.timeline_state, op.expect_timeline_state);
    if (op.expect_reconciliation_mode) assert.equal(record.reconciliation_mode, op.expect_reconciliation_mode);
    if (typeof op.expect_reserved === 'number') assert.equal(record.reconciliation_reserved, op.expect_reserved);
    if (typeof op.expect_withdrawn === 'number') assert.equal(record.reconciliation_withdrawn, op.expect_withdrawn);
    if (typeof op.expect_available === 'number') assert.equal(record.reconciliation_available, op.expect_available);
    if (typeof op.expect_transitions_count === 'number') assert.equal(record.transitions_count, op.expect_transitions_count);
    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

store.save();

const cycleIdP2 = proposalByRef.p2.id;
const cycleIdP3 = proposalByRef.p3.id;

const trackedHoldings = ['hold_a', 'hold_b', 'hold_c', 'hold_d'];
const finalHoldings = {};
for (const holdingId of trackedHoldings) {
  const holding = store.state.vault_holdings?.[holdingId] ?? null;
  finalHoldings[holdingId] = holding
    ? {
        status: holding.status,
        reservation_id: holding.reservation_id ?? null,
        settlement_cycle_id: holding.settlement_cycle_id ?? null,
        withdrawn_at: holding.withdrawn_at ?? null
      }
    : null;
}

const out = canonicalize({
  operations,
  final: {
    cycles: {
      p2: {
        cycle_id: cycleIdP2,
        timeline_state: store.state.timelines?.[cycleIdP2]?.state ?? null,
        receipt_final_state: store.state.receipts?.[cycleIdP2]?.final_state ?? null
      },
      p3: {
        cycle_id: cycleIdP3,
        timeline_state: store.state.timelines?.[cycleIdP3]?.state ?? null,
        receipt_final_state: store.state.receipts?.[cycleIdP3]?.final_state ?? null
      }
    },
    holdings: finalHoldings,
    remaining_intent_reservations: Object.keys(store.state.reservations ?? {}).sort()
  }
});

writeFileSync(path.join(outDir, 'vault_reconciliation_export_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M52', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
