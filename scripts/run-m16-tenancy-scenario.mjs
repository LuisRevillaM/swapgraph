import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { CommitService } from '../src/commit/commitService.mjs';
import { SettlementService } from '../src/settlement/settlementService.mjs';
import { SettlementReadService } from '../src/read/settlementReadService.mjs';
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

function authForOperation(op) {
  const endpoint = endpointsByOp.get(op);
  const requiredScopes = Array.isArray(endpoint?.auth?.required_scopes) ? endpoint.auth.required_scopes : [];
  return { scopes: requiredScopes };
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

// Proposals from matching fixture output
const matchingOut = readJson(path.join(root, 'fixtures/matching/m5_expected.json'));
const proposals = matchingOut.proposals;
const p3 = proposals.find(p => p.participants.length === 3);
if (!p3) throw new Error('expected a 3-cycle proposal in fixtures');
const proposalByRef = { p3 };

// Scenario
const scenario = readJson(path.join(root, 'fixtures/settlement/m16_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/settlement/m16_expected.json'));

const actors = scenario.actors;

store.state.tenancy ||= {};
store.state.tenancy.proposals ||= {};
store.state.tenancy.proposals[p3.id] = { partner_id: actors.partner_a?.id ?? 'partner_a' };

const commitSvc = new CommitService({ store });
const settlementSvc = new SettlementService({ store });
const readSvc = new SettlementReadService({ store });

const operations = [];

for (const op of scenario.operations) {
  if (op.op === 'cycleProposals.accept') {
    const proposal = proposalByRef[op.proposal_ref];
    const req = { proposal_id: proposal.id };
    const auth = authForOperation(op.op);
    const r = commitSvc.accept({ actor: op.actor, auth, idempotencyKey: op.idempotency_key, proposal, requestBody: req, occurredAt: op.occurred_at });
    const res = r.result;
    operations.push({ op: op.op, cycle_id: proposal.id, ok: res.ok, error_code: res.ok ? null : res.body.error.code, commit_phase: res.ok ? res.body.commit.phase : null });
    continue;
  }

  if (op.op === 'settlement.start') {
    const proposal = proposalByRef[op.proposal_ref];
    const actor = actors[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);
    const depositDeadlineAt = scenario.cycles?.[op.proposal_ref]?.deposit_deadline_at;
    const r = settlementSvc.start({ actor, proposal, occurredAt: op.occurred_at, depositDeadlineAt });
    if (!r.ok) throw new Error(`settlement.start failed: ${JSON.stringify(r)}`);
    operations.push({ op: op.op, cycle_id: proposal.id, ok: true, replayed: r.replayed ?? false, timeline_state: r.timeline.state });
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
    const actor = actors[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);
    const r = settlementSvc.beginExecution({ actor, cycleId: proposal.id, occurredAt: op.occurred_at });
    if (!r.ok) throw new Error(`beginExecution failed: ${JSON.stringify(r)}`);
    operations.push({ op: op.op, cycle_id: proposal.id, ok: true, timeline_state: r.timeline.state });
    continue;
  }

  if (op.op === 'settlement.complete') {
    const proposal = proposalByRef[op.proposal_ref];
    const actor = actors[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);
    const r = settlementSvc.complete({ actor, cycleId: proposal.id, occurredAt: op.occurred_at });
    if (!r.ok) throw new Error(`complete failed: ${JSON.stringify(r)}`);
    operations.push({
      op: op.op,
      cycle_id: proposal.id,
      ok: true,
      timeline_state: r.timeline.state,
      receipt_id: r.receipt.id,
      receipt_final_state: r.receipt.final_state
    });
    continue;
  }

  if (op.op === 'settlement.status' || op.op === 'settlement.instructions' || op.op === 'receipts.get') {
    const proposal = proposalByRef[op.proposal_ref];
    const actor = actors[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);
    const auth = authForOperation(op.op);

    let r;
    if (op.op === 'settlement.status') r = readSvc.status({ actor, auth, cycleId: proposal.id });
    if (op.op === 'settlement.instructions') r = readSvc.instructions({ actor, auth, cycleId: proposal.id });
    if (op.op === 'receipts.get') r = readSvc.receipt({ actor, auth, cycleId: proposal.id });

    const endpoint = endpointsByOp.get(op.op);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

    if (r.ok) {
      const v = validateAgainstSchemaFile(endpoint.response_schema, r.body);
      if (!v.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(v.errors)}`);
    } else {
      const v = validateAgainstSchemaFile('ErrorResponse.schema.json', r.body);
      if (!v.ok) throw new Error(`error invalid for op=${op.op}: ${JSON.stringify(v.errors)}`);
    }

    operations.push({ op: op.op, cycle_id: proposal.id, actor, ok: r.ok, error_code: r.ok ? null : r.body.error.code });
    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

// Guard against tenancy scope hijack on replay when scope state is unexpectedly missing.
{
  const proposal = proposalByRef.p3;
  const cycleId = proposal.id;
  const originalScope = store.state.tenancy?.cycles?.[cycleId]
    ? JSON.parse(JSON.stringify(store.state.tenancy.cycles[cycleId]))
    : null;

  if (store.state.tenancy?.cycles) delete store.state.tenancy.cycles[cycleId];

  const replaySelfHeal = settlementSvc.start({
    actor: actors.partner_a,
    proposal,
    occurredAt: '2026-02-16T00:09:58Z',
    depositDeadlineAt: scenario.cycles?.p3?.deposit_deadline_at
  });

  if (!replaySelfHeal.ok) throw new Error(`replay self-heal start failed: ${JSON.stringify(replaySelfHeal)}`);

  const scopeAfterSelfHeal = store.state.tenancy?.cycles?.[cycleId] ?? null;
  if (scopeAfterSelfHeal?.partner_id !== actors.partner_a?.id) {
    throw new Error(`replay self-heal did not restore cycle tenancy: ${JSON.stringify(scopeAfterSelfHeal)}`);
  }

  operations.push({
    op: 'settlement.start.replay_scope_self_heal',
    cycle_id: cycleId,
    actor: actors.partner_a,
    ok: replaySelfHeal.ok,
    replayed: replaySelfHeal.replayed ?? false,
    scope_after_partner_id: scopeAfterSelfHeal?.partner_id ?? null
  });

  if (store.state.tenancy?.cycles) delete store.state.tenancy.cycles[cycleId];

  const replay = settlementSvc.start({
    actor: actors.partner_b,
    proposal,
    occurredAt: '2026-02-16T00:09:59Z',
    depositDeadlineAt: scenario.cycles?.p3?.deposit_deadline_at
  });

  if (replay.ok) throw new Error(`replay guard unexpectedly succeeded: ${JSON.stringify(replay)}`);
  if (replay.error?.code !== 'FORBIDDEN') throw new Error(`replay guard expected FORBIDDEN: ${JSON.stringify(replay)}`);

  const scopeAfterReplay = store.state.tenancy?.cycles?.[cycleId] ?? null;
  if (scopeAfterReplay?.partner_id) {
    throw new Error(`replay start rebound cycle tenancy: ${JSON.stringify(scopeAfterReplay)}`);
  }

  store.state.tenancy ||= {};
  store.state.tenancy.cycles ||= {};
  if (originalScope) {
    store.state.tenancy.cycles[cycleId] = originalScope;
  } else {
    delete store.state.tenancy.cycles[cycleId];
  }

  operations.push({
    op: 'settlement.start.replay_scope_guard',
    cycle_id: cycleId,
    actor: actors.partner_b,
    ok: replay.ok,
    error_code: replay.error?.code ?? null,
    scope_after_partner_id: scopeAfterReplay?.partner_id ?? null
  });
}

store.save();

const out = canonicalize({
  operations,
  tenancy: store.state.tenancy
});

writeFileSync(path.join(outDir, 'tenancy_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M16', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
