import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { CommitService } from '../src/commit/commitService.mjs';
import { SettlementService } from '../src/settlement/settlementService.mjs';
import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
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

function errorResponse(code, message, details = {}) {
  return { error: { code, message, details } };
}

// ---- Load API manifest for response schema mapping ----
const apiManifest = readJson(path.join(root, 'docs/spec/api/manifest.v1.json'));
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(e => [e.operation_id, e]));

// ---- Load schemas into AJV ----
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

function buildDepositInstructions(timeline) {
  const pending = (timeline.legs ?? [])
    .filter(l => l.status === 'pending')
    .map(l => ({
      actor: l.from_actor,
      kind: 'deposit',
      intent_id: l.intent_id,
      deposit_deadline_at: l.deposit_deadline_at
    }));

  // deterministic ordering
  pending.sort((a, b) => {
    const ak = `${a.actor.type}:${a.actor.id}`;
    const bk = `${b.actor.type}:${b.actor.id}`;
    return ak.localeCompare(bk);
  });

  return pending;
}

function settlementInstructionsGet({ store, cycleId }) {
  const timeline = store.state.timelines[cycleId];
  if (!timeline) return { ok: false, body: errorResponse('NOT_FOUND', 'settlement timeline not found', { cycle_id: cycleId }) };
  const instructions = buildDepositInstructions(timeline);
  const correlation_id = `corr_${cycleId}`;
  return { ok: true, body: { correlation_id, timeline, instructions } };
}

function settlementStatusGet({ store, cycleId }) {
  const timeline = store.state.timelines[cycleId];
  if (!timeline) return { ok: false, body: errorResponse('NOT_FOUND', 'settlement timeline not found', { cycle_id: cycleId }) };
  const correlation_id = `corr_${cycleId}`;
  return { ok: true, body: { correlation_id, timeline } };
}

function receiptGet({ store, cycleId }) {
  const receipt = store.state.receipts[cycleId];
  if (!receipt) return { ok: false, body: errorResponse('NOT_FOUND', 'receipt not found', { cycle_id: cycleId }) };
  const correlation_id = `corr_${cycleId}`;
  return { ok: true, body: { correlation_id, receipt } };
}

// ---- Seed store intents from matching fixture input ----
const matchingInput = readJson(path.join(root, 'fixtures/matching/m5_input.json'));

const storeFile = path.join(outDir, 'store.json');
const store = new JsonStateStore({ filePath: storeFile });
store.load();

for (const it of matchingInput.intents) {
  const intent = { ...it, status: it.status ?? 'active' };
  const v = validateAgainstSchemaFile('SwapIntent.schema.json', intent);
  if (!v.ok) throw new Error(`seed intent invalid: ${JSON.stringify(v.errors)}`);
  store.state.intents[intent.id] = intent;
}

// Proposals come from matching fixture output
const matchingOut = readJson(path.join(root, 'fixtures/matching/m5_expected.json'));
const proposals = matchingOut.proposals;
const p3 = proposals.find(p => p.participants.length === 3);
const p2 = proposals.find(p => p.participants.length === 2);
if (!p3 || !p2) throw new Error('expected both p3 and p2 proposals');
const proposalByRef = { p3, p2 };

// Scenario
const scenarioPath = path.join(root, 'fixtures/settlement/m13_scenario.json');
const expectedPath = path.join(root, 'fixtures/settlement/m13_expected.json');
const scenario = readJson(scenarioPath);

const commitSvc = new CommitService({ store });
const settlementSvc = new SettlementService({ store });

const operations = [];

for (const op of scenario.operations) {
  if (op.op === 'cycleProposals.accept') {
    const proposal = proposalByRef[op.proposal_ref];
    const req = { proposal_id: proposal.id };
    const r = commitSvc.accept({ actor: op.actor, idempotencyKey: op.idempotency_key, proposal, requestBody: req, occurredAt: op.occurred_at });
    const res = r.result;
    operations.push({
      op: op.op,
      cycle_id: proposal.id,
      ok: res.ok,
      replayed: r.replayed,
      error_code: res.ok ? null : res.body.error.code,
      commit_phase: res.ok ? res.body.commit.phase : null
    });
    continue;
  }

  if (op.op === 'settlement.start') {
    const proposal = proposalByRef[op.proposal_ref];
    const depositDeadlineAt = scenario.cycles?.[op.proposal_ref]?.deposit_deadline_at;
    const r = settlementSvc.start({ actor: op.actor, proposal, occurredAt: op.occurred_at, depositDeadlineAt });
    if (!r.ok) throw new Error(`settlement.start failed: ${JSON.stringify(r)}`);
    operations.push({ op: op.op, cycle_id: proposal.id, ok: true, replayed: r.replayed, timeline_state: r.timeline.state });
    continue;
  }

  if (op.op === 'settlement.deposit_confirmed') {
    const proposal = proposalByRef[op.proposal_ref];
    const r = settlementSvc.confirmDeposit({ actor: op.actor, cycleId: proposal.id, depositRef: op.deposit_ref, occurredAt: op.occurred_at });
    if (!r.ok) throw new Error(`confirmDeposit failed: ${JSON.stringify(r)}`);
    operations.push({ op: op.op, cycle_id: proposal.id, ok: true, replayed: r.replayed ?? false, timeline_state: r.timeline.state });
    continue;
  }

  if (op.op === 'settlement.begin_execution') {
    const proposal = proposalByRef[op.proposal_ref];
    const r = settlementSvc.beginExecution({ actor: op.actor, cycleId: proposal.id, occurredAt: op.occurred_at });
    if (!r.ok) throw new Error(`beginExecution failed: ${JSON.stringify(r)}`);
    operations.push({ op: op.op, cycle_id: proposal.id, ok: true, timeline_state: r.timeline.state });
    continue;
  }

  if (op.op === 'settlement.complete') {
    const proposal = proposalByRef[op.proposal_ref];
    const r = settlementSvc.complete({ actor: op.actor, cycleId: proposal.id, occurredAt: op.occurred_at });
    if (!r.ok) throw new Error(`complete failed: ${JSON.stringify(r)}`);
    operations.push({ op: op.op, cycle_id: proposal.id, ok: true, timeline_state: r.timeline.state, receipt_id: r.receipt.id, final_state: r.receipt.final_state });
    continue;
  }

  if (op.op === 'settlement.expire_deposit_window') {
    const proposal = proposalByRef[op.proposal_ref];
    const r = settlementSvc.expireDepositWindow({ actor: op.actor, cycleId: proposal.id, nowIso: op.now_iso });
    if (!r.ok) throw new Error(`expireDepositWindow failed: ${JSON.stringify(r)}`);
    const timeline = store.state.timelines[proposal.id];
    const receipt = store.state.receipts[proposal.id];
    operations.push({ op: op.op, cycle_id: proposal.id, ok: true, timeline_state: timeline.state, receipt_id: receipt.id, final_state: receipt.final_state });
    continue;
  }

  if (op.op === 'settlement.instructions' || op.op === 'settlement.status' || op.op === 'receipts.get') {
    const proposal = proposalByRef[op.proposal_ref];
    const cycleId = proposal.id;

    let res;
    if (op.op === 'settlement.instructions') res = settlementInstructionsGet({ store, cycleId });
    if (op.op === 'settlement.status') res = settlementStatusGet({ store, cycleId });
    if (op.op === 'receipts.get') res = receiptGet({ store, cycleId });

    const endpoint = endpointsByOp.get(op.op);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

    if (res.ok) {
      const v = validateAgainstSchemaFile(endpoint.response_schema, res.body);
      if (!v.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(v.errors)}`);
    } else {
      const v = validateAgainstSchemaFile('ErrorResponse.schema.json', res.body);
      if (!v.ok) throw new Error(`error response invalid for op=${op.op}: ${JSON.stringify(v.errors)}`);
    }

    const bodySnapshot = res.ok ? JSON.parse(JSON.stringify(res.body)) : res.body;
    operations.push({ op: op.op, cycle_id: cycleId, ok: res.ok, error_code: res.ok ? null : res.body.error.code, body: bodySnapshot });
    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

store.save();

// reload store to prove persistence
const store2 = new JsonStateStore({ filePath: storeFile });
store2.load();

const out = canonicalize({
  operations,
  final: {
    timelines: store2.state.timelines,
    receipts: store2.state.receipts
  }
});

// Write outputs before asserting (so failures still leave artifacts)
writeFileSync(path.join(outDir, 'settlement_read_output.json'), JSON.stringify(out, null, 2));

const expected = readJson(expectedPath);
assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M13', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
