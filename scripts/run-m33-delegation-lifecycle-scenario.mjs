import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { CycleProposalsReadService } from '../src/read/cycleProposalsReadService.mjs';
import { SettlementReadService } from '../src/read/settlementReadService.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';
import { signReceipt } from '../src/crypto/receiptSigning.mjs';

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

// Enforce authz in this scenario.
if (process.env.AUTHZ_ENFORCE !== '1') {
  console.error('AUTHZ_ENFORCE must be 1 for M33 scenario');
  process.exit(2);
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

// ---- Load scenario + expected ----
const scenarioPath = path.join(root, 'fixtures/delegation/m33_scenario.json');
const expectedPath = path.join(root, 'fixtures/delegation/m33_expected.json');
const scenario = readJson(scenarioPath);
const expected = readJson(expectedPath);

const actors = scenario.actors;
const delegations = scenario.delegations;

function resolveAuth(authSpec) {
  const a = authSpec ?? {};
  const out = {};

  if (a.now_iso) out.now_iso = a.now_iso;

  if (a.delegation_ref) {
    const d = delegations?.[a.delegation_ref];
    if (!d) throw new Error(`unknown delegation_ref: ${a.delegation_ref}`);
    const vd = validateAgainstSchemaFile('DelegationGrant.schema.json', d);
    if (!vd.ok) throw new Error(`delegation invalid for ref=${a.delegation_ref}: ${JSON.stringify(vd.errors)}`);
    out.delegation = d;
  }

  return out;
}

// ---- Seed store proposals from matching fixture output ----
const matchingOut = readJson(path.join(root, 'fixtures/matching/m5_expected.json'));
const proposals = matchingOut.proposals;

const p3 = proposals.find(p => (p.participants ?? []).length === 3);
const p2 = proposals.find(p => (p.participants ?? []).length === 2);
if (!p3 || !p2) throw new Error('expected both a 3-cycle and 2-cycle proposal in fixtures');

const proposalByRef = { p2, p3 };

const storeFile = path.join(outDir, 'store.json');
const store = new JsonStateStore({ filePath: storeFile });
store.load();

store.state.proposals ||= {};
for (const p of proposals) {
  const v = validateAgainstSchemaFile('CycleProposal.schema.json', p);
  if (!v.ok) throw new Error(`seed proposal invalid: ${JSON.stringify(v.errors)}`);
  store.state.proposals[p.id] = p;
}

// Partner scoping for proposals (used by partner reads; user reads ignore it).
store.state.tenancy ||= {};
store.state.tenancy.proposals ||= {};
for (const p of proposals) {
  store.state.tenancy.proposals[p.id] = { partner_id: 'swapgraph' };
}

// Seed timelines + signed receipts:
// - p3: u1 participates (positive read proofs)
// - p2: u1 does NOT participate (negative FORBIDDEN proof)
const cycleIdP3 = p3.id;
const cycleIdP2 = p2.id;

store.state.tenancy.cycles ||= {};
store.state.tenancy.cycles[cycleIdP3] = { partner_id: 'swapgraph' };
store.state.tenancy.cycles[cycleIdP2] = { partner_id: 'swapgraph' };

store.state.timelines ||= {};
store.state.timelines[cycleIdP3] = {
  cycle_id: cycleIdP3,
  state: 'escrow.pending',
  legs: [
    {
      leg_id: `leg_${cycleIdP3}_intent_a`,
      intent_id: 'intent_a',
      from_actor: { type: 'user', id: 'u1' },
      to_actor: { type: 'user', id: 'u2' },
      assets: [{ platform: 'steam', asset_id: 'assetA' }],
      status: 'pending',
      deposit_deadline_at: '2026-03-01T00:00:00Z'
    },
    {
      leg_id: `leg_${cycleIdP3}_intent_b`,
      intent_id: 'intent_b',
      from_actor: { type: 'user', id: 'u2' },
      to_actor: { type: 'user', id: 'u3' },
      assets: [{ platform: 'steam', asset_id: 'assetB' }],
      status: 'pending',
      deposit_deadline_at: '2026-03-01T00:00:00Z'
    },
    {
      leg_id: `leg_${cycleIdP3}_intent_c`,
      intent_id: 'intent_c',
      from_actor: { type: 'user', id: 'u3' },
      to_actor: { type: 'user', id: 'u1' },
      assets: [{ platform: 'steam', asset_id: 'assetC' }],
      status: 'pending',
      deposit_deadline_at: '2026-03-01T00:00:00Z'
    }
  ],
  updated_at: '2026-02-16T00:00:00Z'
};

store.state.timelines[cycleIdP2] = {
  cycle_id: cycleIdP2,
  state: 'escrow.pending',
  legs: [
    {
      leg_id: `leg_${cycleIdP2}_intent_d`,
      intent_id: 'intent_d',
      from_actor: { type: 'user', id: 'u5' },
      to_actor: { type: 'user', id: 'u6' },
      assets: [{ platform: 'steam', asset_id: 'assetD' }],
      status: 'pending',
      deposit_deadline_at: '2026-03-01T00:00:00Z'
    },
    {
      leg_id: `leg_${cycleIdP2}_intent_e`,
      intent_id: 'intent_e',
      from_actor: { type: 'user', id: 'u6' },
      to_actor: { type: 'user', id: 'u5' },
      assets: [{ platform: 'steam', asset_id: 'assetE' }],
      status: 'pending',
      deposit_deadline_at: '2026-03-01T00:00:00Z'
    }
  ],
  updated_at: '2026-02-16T00:00:00Z'
};

store.state.receipts ||= {};

const unsignedReceiptP3 = {
  id: `receipt_${cycleIdP3}`,
  cycle_id: cycleIdP3,
  final_state: 'failed',
  intent_ids: ['intent_a', 'intent_b', 'intent_c'],
  asset_ids: ['assetA', 'assetB', 'assetC'],
  created_at: '2026-02-16T00:00:00Z'
};
store.state.receipts[cycleIdP3] = { ...unsignedReceiptP3, signature: signReceipt(unsignedReceiptP3) };

const unsignedReceiptP2 = {
  id: `receipt_${cycleIdP2}`,
  cycle_id: cycleIdP2,
  final_state: 'failed',
  intent_ids: ['intent_d', 'intent_e'],
  asset_ids: ['assetD', 'assetE'],
  created_at: '2026-02-16T00:00:00Z'
};
store.state.receipts[cycleIdP2] = { ...unsignedReceiptP2, signature: signReceipt(unsignedReceiptP2) };

store.save();

const proposalsRead = new CycleProposalsReadService({ store });
const settlementRead = new SettlementReadService({ store });

const operations = [];

function pushResult({ op, actor, auth, res, endpoint, extra = {} }) {
  if (res.ok) {
    const v = validateAgainstSchemaFile(endpoint.response_schema, res.body);
    if (!v.ok) throw new Error(`response invalid for op=${op}: ${JSON.stringify(v.errors)}`);
    operations.push({ op, actor, auth: summarizeAuth(auth), ok: true, error_code: null, ...extra });
    return;
  }

  const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', res.body);
  if (!verr.ok) throw new Error(`error response invalid for op=${op}: ${JSON.stringify(verr.errors)}`);
  operations.push({ op, actor, auth: summarizeAuth(auth), ok: false, error_code: res.body.error.code, ...extra });
}

function summarizeAuth(auth) {
  const out = {};
  if (auth?.now_iso) out.now_iso = auth.now_iso;
  if (auth?.delegation) {
    out.delegation_id = auth.delegation.delegation_id;
    out.scopes = auth.delegation.scopes;
    if (auth.delegation.revoked_at) out.revoked_at = auth.delegation.revoked_at;
    out.expires_at = auth.delegation.expires_at;
  }
  return out;
}

for (const op of scenario.ops ?? []) {
  const actor = actors?.[op.actor_ref];
  if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  const auth = resolveAuth(op.auth);

  const endpoint = endpointsByOp.get(op.op);
  if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

  if (op.op === 'cycleProposals.list') {
    const res = proposalsRead.list({ actor, auth });
    const extra = {};
    if (res.ok) extra.proposals_count = (res.body.proposals ?? []).length;
    pushResult({ op: op.op, actor, auth, res, endpoint, extra });
  } else if (op.op === 'cycleProposals.get') {
    const proposalId = proposalByRef[op.proposal_ref]?.id;
    if (!proposalId) throw new Error(`unknown proposal_ref: ${op.proposal_ref}`);
    const res = proposalsRead.get({ actor, auth, proposalId });
    const extra = { proposal_id: proposalId };
    if (res.ok) extra.returned_proposal_id = res.body.proposal?.id ?? null;
    pushResult({ op: op.op, actor, auth, res, endpoint, extra });
  } else if (op.op === 'settlement.status') {
    const cycleId = proposalByRef[op.cycle_ref]?.id;
    if (!cycleId) throw new Error(`unknown cycle_ref: ${op.cycle_ref}`);
    const res = settlementRead.status({ actor, auth, cycleId });
    const extra = { cycle_id: cycleId };
    if (res.ok) extra.timeline_state = res.body.timeline?.state ?? null;
    pushResult({ op: op.op, actor, auth, res, endpoint, extra });
  } else if (op.op === 'settlement.instructions') {
    const cycleId = proposalByRef[op.cycle_ref]?.id;
    if (!cycleId) throw new Error(`unknown cycle_ref: ${op.cycle_ref}`);
    const res = settlementRead.instructions({ actor, auth, cycleId });
    const extra = { cycle_id: cycleId };
    if (res.ok) extra.instructions_count = (res.body.instructions ?? []).length;
    pushResult({ op: op.op, actor, auth, res, endpoint, extra });
  } else if (op.op === 'receipts.get') {
    const cycleId = proposalByRef[op.cycle_ref]?.id;
    if (!cycleId) throw new Error(`unknown cycle_ref: ${op.cycle_ref}`);
    const res = settlementRead.receipt({ actor, auth, cycleId });
    const extra = { cycle_id: cycleId };
    if (res.ok) extra.receipt_id = res.body.receipt?.id ?? null;
    pushResult({ op: op.op, actor, auth, res, endpoint, extra });
  } else {
    throw new Error(`unsupported op in scenario: ${op.op}`);
  }

  const last = operations[operations.length - 1];
  if (typeof op.expect_ok === 'boolean') assert.equal(last.ok, op.expect_ok);
  if (!last.ok && op.expect_error_code) assert.equal(last.error_code, op.expect_error_code);
  if (last.ok && typeof op.expect_proposals_count === 'number' && op.op === 'cycleProposals.list') {
    assert.equal(last.proposals_count, op.expect_proposals_count);
  }
  if (last.ok && typeof op.expect_instructions_count === 'number' && op.op === 'settlement.instructions') {
    assert.equal(last.instructions_count, op.expect_instructions_count);
  }
}

const out = canonicalize({ operations });

writeFileSync(path.join(outDir, 'delegation_lifecycle_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M33', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
