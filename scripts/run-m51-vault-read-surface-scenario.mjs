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
import { canonicalize } from '../src/util/canonicalJson.mjs';

const root = process.cwd();
const outDir = process.env.OUT_DIR;
if (!outDir) {
  console.error('Missing OUT_DIR env');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

if (process.env.AUTHZ_ENFORCE !== '1') {
  console.error('AUTHZ_ENFORCE must be 1 for M51 scenario');
  process.exit(2);
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
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

const scenario = readJson(path.join(root, 'fixtures/vault/m51_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/vault/m51_expected.json'));

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

function cycleIdForOp(op) {
  if (!op.proposal_ref) return op.cycle_id ?? null;
  return proposalByRef?.[op.proposal_ref]?.id ?? null;
}

function validateApiRequest(opId, requestPayload) {
  const endpoint = endpointsByOp.get(opId);
  if (!endpoint) throw new Error(`missing endpoint mapping for op=${opId}`);
  if (!endpoint.request_schema) return;
  const v = validateAgainstSchemaFile(endpoint.request_schema, requestPayload);
  if (!v.ok) throw new Error(`request invalid for op=${opId}: ${JSON.stringify(v.errors)}`);
}

function validateApiResponse(opId, response) {
  const endpoint = endpointsByOp.get(opId);
  if (!endpoint) throw new Error(`missing endpoint mapping for op=${opId}`);

  if (response.ok) {
    if (!endpoint.response_schema) return;
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
    } else if (op.op === 'vault.release') {
      validateApiRequest(op.op, op.request ?? {});
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
      validateApiRequest(op.op, op.request ?? {});
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

    validateApiResponse(op.op, response);

    operations.push({
      op: op.op,
      cycle_id: cycleId,
      actor,
      ok: response.ok,
      replayed,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      holding_id: response.ok ? (response.body.holding?.holding_id ?? op.holding_id ?? null) : (op.holding_id ?? op.request?.holding_id ?? op.request?.holding?.holding_id ?? null),
      holding_status: response.ok ? (response.body.holding?.status ?? null) : null,
      reservation_id: response.ok ? (response.body.holding?.reservation_id ?? null) : null,
      settlement_cycle_id: response.ok ? (response.body.holding?.settlement_cycle_id ?? null) : null,
      withdrawn_at: response.ok ? (response.body.holding?.withdrawn_at ?? null) : null
    });

    continue;
  }

  if (op.op.startsWith('settlement.')) {
    const requestBody = op.request_body ?? {};
    validateApiRequest(op.op, requestBody);

    let response;

    if (op.op === 'settlement.start') {
      response = settlementWrite.start({
        actor,
        auth: op.auth ?? {},
        cycleId,
        requestBody,
        occurredAt: op.occurred_at
      });
    } else if (op.op === 'settlement.deposit_confirmed') {
      response = settlementWrite.depositConfirmed({
        actor,
        auth: op.auth ?? {},
        cycleId,
        requestBody,
        occurredAt: op.occurred_at
      });
    } else if (op.op === 'settlement.begin_execution') {
      response = settlementWrite.beginExecution({
        actor,
        auth: op.auth ?? {},
        cycleId,
        requestBody,
        occurredAt: op.occurred_at
      });
    } else if (op.op === 'settlement.complete') {
      response = settlementWrite.complete({
        actor,
        auth: op.auth ?? {},
        cycleId,
        requestBody,
        occurredAt: op.occurred_at
      });
    } else if (op.op === 'settlement.expire_deposit_window') {
      response = settlementWrite.expireDepositWindow({
        actor,
        auth: op.auth ?? {},
        cycleId,
        requestBody
      });
    } else if (op.op === 'settlement.status') {
      response = settlementRead.status({
        actor,
        auth: op.auth ?? {},
        cycleId
      });
    } else if (op.op === 'settlement.instructions') {
      response = settlementRead.instructions({
        actor,
        auth: op.auth ?? {},
        cycleId
      });
    } else {
      throw new Error(`unsupported settlement op: ${op.op}`);
    }

    validateApiResponse(op.op, response);

    const timeline = response.ok ? (response.body.timeline ?? null) : null;
    const vaultReconciliation = response.ok ? (response.body.vault_reconciliation ?? null) : null;
    const stateTransitions = response.ok ? (response.body.state_transitions ?? null) : null;

    operations.push({
      op: op.op,
      cycle_id: cycleId,
      actor,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code,
      reason_code: response.ok ? null : (response.body.error.details?.reason_code ?? null),
      correlation_id: response.ok ? (response.body.correlation_id ?? null) : null,
      timeline_state: timeline?.state ?? null,
      instructions_count: response.ok && Array.isArray(response.body.instructions) ? response.body.instructions.length : null,
      instruction_actor_ids: response.ok && Array.isArray(response.body.instructions)
        ? response.body.instructions.map(instr => `${instr.actor?.type}:${instr.actor?.id}`)
        : null,
      has_vault_reconciliation: !!vaultReconciliation,
      reconciliation_mode: vaultReconciliation?.summary?.mode ?? null,
      reconciliation_total: vaultReconciliation?.summary?.total ?? null,
      reconciliation_withdrawn: vaultReconciliation?.summary?.withdrawn ?? null,
      reconciliation_available: vaultReconciliation?.summary?.available ?? null,
      reconciliation_reserved: vaultReconciliation?.summary?.reserved ?? null,
      reconciliation_not_found: vaultReconciliation?.summary?.not_found ?? null,
      reconciliation_entries: vaultReconciliation
        ? vaultReconciliation.entries.map(entry => ({
            intent_id: entry.intent_id,
            holding_id: entry.holding_id,
            leg_status: entry.leg_status,
            holding_status: entry.holding_status,
            settlement_cycle_id: entry.settlement_cycle_id
          }))
        : null,
      state_transition_edges: Array.isArray(stateTransitions)
        ? stateTransitions.map(transition => `${transition.from_state}->${transition.to_state}:${transition.reason_code ?? ''}`)
        : null,
      participant_visible_deposit_ref_count: timeline
        ? (timeline.legs ?? []).filter(leg => Object.prototype.hasOwnProperty.call(leg, 'deposit_ref')).length
        : null,
      no_op: response.ok ? (response.body.no_op === true) : false,
      details_reason: response.ok ? (response.body.details?.reason ?? null) : null,
      receipt_id: response.ok ? (response.body.receipt?.id ?? null) : null,
      receipt_final_state: response.ok ? (response.body.receipt?.final_state ?? null) : null
    });

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

writeFileSync(path.join(outDir, 'vault_read_surface_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M51', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
