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

function actorKey(actor) {
  return `${actor.type}:${actor.id}`;
}

function isPartner(actor) {
  return actor?.type === 'partner';
}

function isUserParticipant({ actor, timeline }) {
  if (actor?.type !== 'user') return false;
  const participants = new Set((timeline.legs ?? []).flatMap(l => [actorKey(l.from_actor), actorKey(l.to_actor)]));
  return participants.has(actorKey(actor));
}

function authorizeRead({ actor, timeline }) {
  if (isPartner(actor)) return { ok: true };
  if (actor?.type === 'agent') return { ok: false, code: 'FORBIDDEN', message: 'agent access requires delegation (not implemented)', details: { actor } };
  if (isUserParticipant({ actor, timeline })) return { ok: true };
  return { ok: false, code: 'FORBIDDEN', message: 'actor cannot access this cycle', details: { actor } };
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

  pending.sort((a, b) => {
    const ak = `${a.actor.type}:${a.actor.id}`;
    const bk = `${b.actor.type}:${b.actor.id}`;
    return ak.localeCompare(bk);
  });

  return pending;
}

function settlementInstructionsGet({ store, cycleId, actor }) {
  const timeline = store.state.timelines[cycleId];
  if (!timeline) return { ok: false, body: errorResponse('NOT_FOUND', 'settlement timeline not found', { cycle_id: cycleId }) };

  const authz = authorizeRead({ actor, timeline });
  if (!authz.ok) return { ok: false, body: errorResponse(authz.code, authz.message, { ...authz.details, cycle_id: cycleId }) };

  const instructions = buildDepositInstructions(timeline);
  const correlation_id = `corr_${cycleId}`;
  return { ok: true, body: { correlation_id, timeline, instructions } };
}

function settlementStatusGet({ store, cycleId, actor }) {
  const timeline = store.state.timelines[cycleId];
  if (!timeline) return { ok: false, body: errorResponse('NOT_FOUND', 'settlement timeline not found', { cycle_id: cycleId }) };

  const authz = authorizeRead({ actor, timeline });
  if (!authz.ok) return { ok: false, body: errorResponse(authz.code, authz.message, { ...authz.details, cycle_id: cycleId }) };

  const correlation_id = `corr_${cycleId}`;
  return { ok: true, body: { correlation_id, timeline } };
}

function receiptGet({ store, cycleId, actor }) {
  const receipt = store.state.receipts[cycleId];
  if (!receipt) return { ok: false, body: errorResponse('NOT_FOUND', 'receipt not found', { cycle_id: cycleId }) };

  // Determine participant set from timeline if present.
  const timeline = store.state.timelines[cycleId] ?? { legs: [] };
  const authz = authorizeRead({ actor, timeline });
  if (!authz.ok) return { ok: false, body: errorResponse(authz.code, authz.message, { ...authz.details, cycle_id: cycleId }) };

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
if (!p3) throw new Error('expected a 3-cycle proposal in fixtures');
const proposalByRef = { p3 };

// Scenario
const scenarioPath = path.join(root, 'fixtures/settlement/m14_scenario.json');
const expectedPath = path.join(root, 'fixtures/settlement/m14_expected.json');
const scenario = readJson(scenarioPath);

const actorRefs = {
  actor_partner: scenario.actor_partner,
  actor_participant: scenario.actor_participant,
  actor_outsider: scenario.actor_outsider,
  actor_agent: scenario.actor_agent
};

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
      actor: op.actor,
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
    operations.push({ op: op.op, cycle_id: proposal.id, actor: op.actor, ok: true, replayed: r.replayed, timeline_state: r.timeline.state });
    continue;
  }

  if (op.op === 'settlement.deposit_confirmed') {
    const proposal = proposalByRef[op.proposal_ref];
    const r = settlementSvc.confirmDeposit({ actor: op.actor, cycleId: proposal.id, depositRef: op.deposit_ref, occurredAt: op.occurred_at });
    if (!r.ok) throw new Error(`confirmDeposit failed: ${JSON.stringify(r)}`);
    operations.push({ op: op.op, cycle_id: proposal.id, actor: op.actor, ok: true, replayed: r.replayed ?? false, timeline_state: r.timeline.state });
    continue;
  }

  if (op.op === 'settlement.begin_execution') {
    const proposal = proposalByRef[op.proposal_ref];
    const r = settlementSvc.beginExecution({ actor: op.actor, cycleId: proposal.id, occurredAt: op.occurred_at });
    if (!r.ok) throw new Error(`beginExecution failed: ${JSON.stringify(r)}`);
    operations.push({ op: op.op, cycle_id: proposal.id, actor: op.actor, ok: true, timeline_state: r.timeline.state });
    continue;
  }

  if (op.op === 'settlement.complete') {
    const proposal = proposalByRef[op.proposal_ref];
    const r = settlementSvc.complete({ actor: op.actor, cycleId: proposal.id, occurredAt: op.occurred_at });
    if (!r.ok) throw new Error(`complete failed: ${JSON.stringify(r)}`);
    operations.push({ op: op.op, cycle_id: proposal.id, actor: op.actor, ok: true, timeline_state: r.timeline.state, receipt_id: r.receipt.id, final_state: r.receipt.final_state });
    continue;
  }

  if (op.op === 'settlement.instructions' || op.op === 'settlement.status' || op.op === 'receipts.get') {
    const proposal = proposalByRef[op.proposal_ref];
    const cycleId = proposal.id;
    const actor = actorRefs[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

    let res;
    if (op.op === 'settlement.instructions') res = settlementInstructionsGet({ store, cycleId, actor });
    if (op.op === 'settlement.status') res = settlementStatusGet({ store, cycleId, actor });
    if (op.op === 'receipts.get') res = receiptGet({ store, cycleId, actor });

    const endpoint = endpointsByOp.get(op.op);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

    if (res.ok) {
      const v = validateAgainstSchemaFile(endpoint.response_schema, res.body);
      if (!v.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(v.errors)}`);
    } else {
      const v = validateAgainstSchemaFile('ErrorResponse.schema.json', res.body);
      if (!v.ok) throw new Error(`error response invalid for op=${op.op}: ${JSON.stringify(v.errors)}`);
    }

    // Keep snapshot small: just ok + error code.
    operations.push({
      op: op.op,
      cycle_id: cycleId,
      actor,
      ok: res.ok,
      error_code: res.ok ? null : res.body.error.code
    });
    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

store.save();

const out = canonicalize({
  operations
});

// write outputs before assertion
writeFileSync(path.join(outDir, 'authz_output.json'), JSON.stringify(out, null, 2));

const expected = readJson(expectedPath);
assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M14', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
