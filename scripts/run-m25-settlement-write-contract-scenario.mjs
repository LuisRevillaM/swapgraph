import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { CycleProposalsCommitService } from '../src/service/cycleProposalsCommitService.mjs';
import { SettlementWriteApiService } from '../src/service/settlementWriteApiService.mjs';
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

// ---- Load API manifest for schema mapping ----
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
const scenario = readJson(path.join(root, 'fixtures/settlement/m25_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/settlement/m25_expected.json'));

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
const p3 = proposals.find(p => p.participants.length === 3);
const p2 = proposals.find(p => p.participants.length === 2);
if (!p3 || !p2) throw new Error('expected both a 2-cycle and 3-cycle proposal in fixtures');
const proposalByRef = { p2, p3 };

store.state.proposals ||= {};
for (const p of proposals) {
  const v = validateAgainstSchemaFile('CycleProposal.schema.json', p);
  if (!v.ok) throw new Error(`seed proposal invalid: ${JSON.stringify(v.errors)}`);
  store.state.proposals[p.id] = p;
}

// Seed proposal partner scoping.
store.state.tenancy ||= {};
store.state.tenancy.proposals ||= {};
for (const p of proposals) {
  store.state.tenancy.proposals[p.id] = { partner_id: actors.partner.id };
}

const commitSvc = new CycleProposalsCommitService({ store });
const writeSvc = new SettlementWriteApiService({ store });

const operations = [];

for (const op of scenario.operations ?? []) {
  const endpoint = endpointsByOp.get(op.op);
  if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

  const cycleId = op.proposal_ref ? proposalByRef[op.proposal_ref]?.id : (op.cycle_id ?? null);
  const actor = actors[op.actor_ref];
  if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  // ---- Commit ops (setup) ----
  if (op.op === 'cycleProposals.accept') {
    if (!cycleId) throw new Error(`missing cycleId for proposal_ref=${op.proposal_ref ?? 'null'}`);

    const req = { proposal_id: cycleId };
    const vreq = validateAgainstSchemaFile(endpoint.request_schema, req);
    if (!vreq.ok) throw new Error(`request invalid for op=${op.op}: ${JSON.stringify(vreq.errors)}`);

    const r = commitSvc.accept({ actor, idempotencyKey: op.idempotency_key, proposalId: cycleId, requestBody: req, occurredAt: op.occurred_at });
    const res = r.result;

    if (res.ok) {
      const vres = validateAgainstSchemaFile(endpoint.response_schema, res.body);
      if (!vres.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(vres.errors)}`);
    } else {
      const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', res.body);
      if (!verr.ok) throw new Error(`error response invalid for op=${op.op}: ${JSON.stringify(verr.errors)}`);
    }

    operations.push({
      op: op.op,
      cycle_id: cycleId,
      actor,
      ok: res.ok,
      replayed: r.replayed,
      error_code: res.ok ? null : res.body.error.code,
      commit_phase: res.ok ? res.body.commit.phase : null
    });
    continue;
  }

  // ---- Settlement write ops ----
  const requestBody = op.request_body ?? {};
  if (endpoint.request_schema) {
    const vreq = validateAgainstSchemaFile(endpoint.request_schema, requestBody);
    if (!vreq.ok) throw new Error(`request invalid for op=${op.op}: ${JSON.stringify(vreq.errors)}`);
  }

  let res;
  if (op.op === 'settlement.start') {
    res = writeSvc.start({ actor, cycleId, requestBody, occurredAt: op.occurred_at });
  } else if (op.op === 'settlement.deposit_confirmed') {
    res = writeSvc.depositConfirmed({ actor, cycleId, requestBody, occurredAt: op.occurred_at });
  } else if (op.op === 'settlement.begin_execution') {
    res = writeSvc.beginExecution({ actor, cycleId, requestBody, occurredAt: op.occurred_at });
  } else if (op.op === 'settlement.complete') {
    res = writeSvc.complete({ actor, cycleId, requestBody, occurredAt: op.occurred_at });
  } else if (op.op === 'settlement.expire_deposit_window') {
    res = writeSvc.expireDepositWindow({ actor, cycleId, requestBody });
  } else {
    throw new Error(`unsupported op: ${op.op}`);
  }

  if (res.ok) {
    const vres = validateAgainstSchemaFile(endpoint.response_schema, res.body);
    if (!vres.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(vres.errors)}`);
  } else {
    const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', res.body);
    if (!verr.ok) throw new Error(`error response invalid for op=${op.op}: ${JSON.stringify(verr.errors)}`);
  }

  const summary = {
    op: op.op,
    cycle_id: cycleId,
    actor,
    ok: res.ok,
    error_code: res.ok ? null : res.body.error.code
  };

  if (res.ok) {
    summary.correlation_id = res.body.correlation_id;

    if (res.body.timeline) summary.timeline_state = res.body.timeline.state;
    if (res.body.receipt) {
      summary.receipt_id = res.body.receipt.id;
      summary.receipt_final_state = res.body.receipt.final_state;
    }

    if (res.body.no_op) {
      summary.no_op = true;
      summary.details_reason = res.body.details?.reason ?? null;
    }
  }

  operations.push(summary);
}

store.save();

const out = canonicalize({
  operations,
  final: {
    cycles: {
      p3: {
        cycle_id: proposalByRef.p3.id,
        timeline_state: store.state.timelines?.[proposalByRef.p3.id]?.state ?? null,
        receipt_final_state: store.state.receipts?.[proposalByRef.p3.id]?.final_state ?? null
      },
      p2: {
        cycle_id: proposalByRef.p2.id,
        timeline_state: store.state.timelines?.[proposalByRef.p2.id]?.state ?? null,
        receipt_final_state: store.state.receipts?.[proposalByRef.p2.id]?.final_state ?? null
      }
    }
  }
});

// write outputs before assertion
writeFileSync(path.join(outDir, 'settlement_write_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M25', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
