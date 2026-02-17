import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { CycleProposalsCommitService } from '../src/service/cycleProposalsCommitService.mjs';
import { SettlementStartService } from '../src/service/settlementStartService.mjs';
import { SettlementActionsService } from '../src/service/settlementActionsService.mjs';
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

// ---- Scenario ----
const scenario = readJson(path.join(root, 'fixtures/settlement/m23_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/settlement/m23_expected.json'));

const actors = scenario.actors;

// Seed store intents from matching fixture input.
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

// Seed proposals into store.
const matchingOut = readJson(path.join(root, 'fixtures/matching/m5_expected.json'));
const proposals = matchingOut.proposals;
const p2 = proposals.find(p => p.participants.length === 2);
if (!p2) throw new Error('expected a 2-cycle proposal in fixtures');
const proposalByRef = { p2 };

store.state.proposals ||= {};
for (const p of proposals) {
  const v = validateAgainstSchemaFile('CycleProposal.schema.json', p);
  if (!v.ok) throw new Error(`seed proposal invalid: ${JSON.stringify(v.errors)}`);
  store.state.proposals[p.id] = p;
}

// Seed proposal partner scoping (required for settlement.start).
store.state.tenancy ||= {};
store.state.tenancy.proposals ||= {};
store.state.tenancy.proposals[p2.id] = { partner_id: actors.partner_a.id };

const commitSvc = new CycleProposalsCommitService({ store });
const startSvc = new SettlementStartService({ store });
const actionsSvc = new SettlementActionsService({ store });

const operations = [];

for (const op of scenario.operations) {
  if (op.op === 'cycleProposals.accept') {
    const cycleId = proposalByRef[op.proposal_ref]?.id;
    const actor = actors[op.actor_ref];

    const req = { proposal_id: cycleId };
    const r = commitSvc.accept({ actor, idempotencyKey: op.idempotency_key, proposalId: cycleId, requestBody: req, occurredAt: op.occurred_at });
    const res = r.result;

    // Basic schema validation of response bodies.
    if (res.ok) {
      const vres = validateAgainstSchemaFile('CommitResponse.schema.json', res.body);
      if (!vres.ok) throw new Error(`accept response invalid: ${JSON.stringify(vres.errors)}`);
    } else {
      const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', res.body);
      if (!verr.ok) throw new Error(`accept error invalid: ${JSON.stringify(verr.errors)}`);
    }

    operations.push({
      op: op.op,
      cycle_id: cycleId,
      ok: res.ok,
      replayed: r.replayed,
      error_code: res.ok ? null : res.body.error.code,
      commit_phase: res.ok ? res.body.commit.phase : null
    });
    continue;
  }

  if (op.op === 'settlement.start') {
    const cycleId = proposalByRef[op.proposal_ref]?.id;
    const actor = actors[op.actor_ref];
    const depositDeadlineAt = scenario.cycles?.[op.proposal_ref]?.deposit_deadline_at;

    const r = startSvc.start({ actor, cycleId, occurredAt: op.occurred_at, depositDeadlineAt });

    operations.push({
      op: op.op,
      cycle_id: cycleId,
      actor,
      ok: r.ok,
      error_code: r.ok ? null : r.error.code,
      timeline_state: r.ok ? r.timeline.state : null
    });
    continue;
  }

  if (op.op === 'settlement.deposit_confirmed') {
    const cycleId = proposalByRef[op.proposal_ref]?.id;
    const actor = actors[op.actor_ref];

    const r = actionsSvc.confirmDeposit({ actor, cycleId, depositRef: op.deposit_ref, occurredAt: op.occurred_at });

    operations.push({
      op: op.op,
      cycle_id: cycleId,
      actor,
      ok: r.ok,
      replayed: r.ok ? (r.replayed ?? false) : false,
      error_code: r.ok ? null : r.error.code,
      timeline_state: r.ok ? r.timeline.state : null
    });
    continue;
  }

  if (op.op === 'settlement.expire_deposit_window') {
    const cycleId = proposalByRef[op.proposal_ref]?.id;
    const actor = actors[op.actor_ref];

    const r = actionsSvc.expireDepositWindow({ actor, cycleId, nowIso: op.now_iso });

    operations.push({
      op: op.op,
      cycle_id: cycleId,
      actor,
      ok: r.ok,
      error_code: r.ok ? null : r.error.code,
      no_op: r.ok ? (r.no_op ?? false) : false,
      timeline_state: r.ok ? (r.timeline?.state ?? null) : null,
      receipt_id: r.ok ? (r.receipt?.id ?? null) : null,
      final_state: r.ok ? (r.receipt?.final_state ?? null) : null,
      reason_code: r.ok ? (r.receipt?.transparency?.reason_code ?? null) : null
    });
    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

store.save();

const cycleId = proposalByRef.p2.id;
const timeline = store.state.timelines?.[cycleId] ?? null;
const receipt = store.state.receipts?.[cycleId] ?? null;

const out = canonicalize({
  operations,
  final: {
    cycle_id: cycleId,
    timeline_state: timeline?.state ?? null,
    receipt_id: receipt?.id ?? null,
    receipt_final_state: receipt?.final_state ?? null,
    receipt_reason_code: receipt?.transparency?.reason_code ?? null,
    reservations_keys: Object.keys(store.state.reservations ?? {}).slice().sort()
  },
  tenancy: store.state.tenancy
});

// write outputs before assertion
writeFileSync(path.join(outDir, 'settlement_failure_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M23', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
