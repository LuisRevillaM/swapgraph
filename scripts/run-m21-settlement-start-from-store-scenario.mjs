import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { CycleProposalsCommitService } from '../src/service/cycleProposalsCommitService.mjs';
import { SettlementStartService } from '../src/service/settlementStartService.mjs';
import { SettlementReadService } from '../src/read/settlementReadService.mjs';
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

// ---- Scenario ----
const scenario = readJson(path.join(root, 'fixtures/settlement/m21_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/settlement/m21_expected.json'));

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
const p3 = proposals.find(p => p.participants.length === 3);
if (!p3) throw new Error('expected a 3-cycle proposal in fixtures');

const proposalByRef = { p3 };

store.state.proposals ||= {};
for (const p of proposals) {
  const v = validateAgainstSchemaFile('CycleProposal.schema.json', p);
  if (!v.ok) throw new Error(`seed proposal invalid: ${JSON.stringify(v.errors)}`);
  store.state.proposals[p.id] = p;
}

// Seed proposal partner scoping.
store.state.tenancy ||= {};
store.state.tenancy.proposals ||= {};
store.state.tenancy.proposals[p3.id] = { partner_id: scenario.actors.partner_a.id };

const actors = scenario.actors;

const commitSvc = new CycleProposalsCommitService({ store });
const startSvc = new SettlementStartService({ store });
const readSvc = new SettlementReadService({ store });

const operations = [];

for (const op of scenario.operations) {
  if (op.op === 'cycleProposals.accept') {
    const proposalId = proposalByRef[op.proposal_ref]?.id;
    const actor = actors[op.actor_ref];
    const req = { proposal_id: proposalId };

    const r = commitSvc.accept({ actor, idempotencyKey: op.idempotency_key, proposalId, requestBody: req, occurredAt: op.occurred_at });
    const res = r.result;

    if (res.ok) {
      const vres = validateAgainstSchemaFile('CommitResponse.schema.json', res.body);
      if (!vres.ok) throw new Error(`accept response invalid: ${JSON.stringify(vres.errors)}`);
    } else {
      const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', res.body);
      if (!verr.ok) throw new Error(`accept error invalid: ${JSON.stringify(verr.errors)}`);
    }

    operations.push({
      op: op.op,
      cycle_id: proposalId,
      ok: res.ok,
      replayed: r.replayed,
      error_code: res.ok ? null : res.body.error.code,
      commit_phase: res.ok ? res.body.commit.phase : null
    });
    continue;
  }

  if (op.op === 'settlement.start') {
    const proposalId = proposalByRef[op.proposal_ref]?.id;
    const actor = actors[op.actor_ref];
    const depositDeadlineAt = scenario.cycles?.[op.proposal_ref]?.deposit_deadline_at;

    const r = startSvc.start({ actor, cycleId: proposalId, occurredAt: op.occurred_at, depositDeadlineAt });

    operations.push({
      op: op.op,
      cycle_id: proposalId,
      actor,
      ok: r.ok,
      error_code: r.ok ? null : r.error.code,
      timeline_state: r.ok ? r.timeline.state : null
    });
    continue;
  }

  if (op.op === 'settlement.status') {
    const proposalId = proposalByRef[op.proposal_ref]?.id;
    const actor = actors[op.actor_ref];

    const r = readSvc.status({ actor, cycleId: proposalId });

    const endpoint = endpointsByOp.get(op.op);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

    if (r.ok) {
      const v = validateAgainstSchemaFile(endpoint.response_schema, r.body);
      if (!v.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(v.errors)}`);
    } else {
      const v = validateAgainstSchemaFile('ErrorResponse.schema.json', r.body);
      if (!v.ok) throw new Error(`error invalid for op=${op.op}: ${JSON.stringify(v.errors)}`);
    }

    operations.push({ op: op.op, cycle_id: proposalId, actor, ok: r.ok, error_code: r.ok ? null : r.body.error.code });
    continue;
  }

  throw new Error(`unsupported op: ${op.op}`);
}

store.save();

const out = canonicalize({
  operations,
  tenancy: store.state.tenancy
});

// write outputs before assertion
writeFileSync(path.join(outDir, 'settlement_start_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M21', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
