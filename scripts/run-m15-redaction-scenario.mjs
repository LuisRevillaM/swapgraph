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
const scenario = readJson(path.join(root, 'fixtures/settlement/m15_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/settlement/m15_expected.json'));

const actorRefs = {
  actor_partner: scenario.actor_partner,
  actor_user_u1: scenario.actor_user_u1
};

const commitSvc = new CommitService({ store });
const settlementSvc = new SettlementService({ store });
const readSvc = new SettlementReadService({ store });

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
      commit_phase: res.ok ? res.body.commit.phase : null,
      error_code: res.ok ? null : res.body.error.code
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

  if (op.op === 'settlement.status' || op.op === 'settlement.instructions') {
    const proposal = proposalByRef[op.proposal_ref];
    const cycleId = proposal.id;
    const actor = actorRefs[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

    const r = op.op === 'settlement.status'
      ? readSvc.status({ actor, cycleId })
      : readSvc.instructions({ actor, cycleId });

    const endpoint = endpointsByOp.get(op.op);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

    if (r.ok) {
      const v = validateAgainstSchemaFile(endpoint.response_schema, r.body);
      if (!v.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(v.errors)}`);
    } else {
      const v = validateAgainstSchemaFile('ErrorResponse.schema.json', r.body);
      if (!v.ok) throw new Error(`error response invalid for op=${op.op}: ${JSON.stringify(v.errors)}`);
    }

    const bodySnapshot = r.ok ? JSON.parse(JSON.stringify(r.body)) : r.body;
    operations.push({
      op: op.op,
      cycle_id: cycleId,
      actor,
      ok: r.ok,
      error_code: r.ok ? null : r.body.error.code,
      body: bodySnapshot
    });
    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

store.save();

const out = canonicalize({ operations });

writeFileSync(path.join(outDir, 'redaction_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M15', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
