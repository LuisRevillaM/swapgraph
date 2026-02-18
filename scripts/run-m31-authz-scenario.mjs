import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { SwapIntentsService } from '../src/service/swapIntentsService.mjs';
import { CycleProposalsReadService } from '../src/read/cycleProposalsReadService.mjs';
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

// Enforce authz in this scenario.
if (process.env.AUTHZ_ENFORCE !== '1') {
  console.error('AUTHZ_ENFORCE must be 1 for M31 scenario');
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
const scenario = readJson(path.join(root, 'fixtures/authz/m31_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/authz/m31_expected.json'));

const actors = scenario.actors;

// ---- Seed store ----
const storeFile = path.join(outDir, 'store.json');
const store = new JsonStateStore({ filePath: storeFile });
store.load();

// Seed intents from fixture input.
const matchingInput = readJson(path.join(root, 'fixtures/matching/m5_input.json'));
for (const it of matchingInput.intents) {
  const intent = { ...it, status: it.status ?? 'active' };
  const v = validateAgainstSchemaFile('SwapIntent.schema.json', intent);
  if (!v.ok) throw new Error(`seed intent invalid: ${JSON.stringify(v.errors)}`);
  store.state.intents[intent.id] = intent;
}

// Seed proposals via delivery fixture.
const delivery = readJson(path.join(root, 'fixtures/delivery/m6_expected.json'));
for (const p of delivery.polling_response?.proposals ?? []) {
  const v = validateAgainstSchemaFile('CycleProposal.schema.json', p);
  if (!v.ok) throw new Error(`seed proposal invalid: ${JSON.stringify(v.errors)}`);
  store.state.proposals[p.id] = p;
  store.state.tenancy.proposals[p.id] = { partner_id: actors.partner.id };
}

// Seed a timeline + receipt for one cycle so settlement.status has something to read.
const cycleId = delivery.polling_response?.proposals?.[0]?.id;
if (!cycleId) throw new Error('expected at least one proposal in delivery fixture');
store.state.tenancy.cycles[cycleId] = { partner_id: actors.partner.id };
store.state.timelines[cycleId] = {
  cycle_id: cycleId,
  state: 'escrow.pending',
  legs: [],
  updated_at: '2026-02-16T00:00:00Z'
};
store.state.receipts[cycleId] = {
  id: `receipt_${cycleId}`,
  cycle_id: cycleId,
  final_state: 'completed',
  intent_ids: [],
  asset_ids: [],
  created_at: '2026-02-16T00:00:00Z',
  signature: {
    key_id: 'dev-k1',
    alg: 'ed25519',
    sig: 'BASE64_SIGNATURE'
  }
};

store.save();

const intentsSvc = new SwapIntentsService({ store });
const proposalsRead = new CycleProposalsReadService({ store });
const settlementRead = new SettlementReadService({ store });

const operations = [];

function pushResult({ op, actor, auth, res, endpoint }) {
  if (res.ok) {
    const v = validateAgainstSchemaFile(endpoint.response_schema, res.body);
    if (!v.ok) throw new Error(`response invalid for op=${op}: ${JSON.stringify(v.errors)}`);
    operations.push({ op, actor, auth, ok: true, error_code: null });
    return;
  }

  const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', res.body);
  if (!verr.ok) throw new Error(`error response invalid for op=${op}: ${JSON.stringify(verr.errors)}`);
  operations.push({ op, actor, auth, ok: false, error_code: res.body.error.code });
}

for (const op of scenario.ops ?? []) {
  const actor = actors[op.actor_ref];
  if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  const auth = op.auth ?? { scopes: [] };

  const endpoint = endpointsByOp.get(op.op);
  if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

  if (op.op === 'swapIntents.list') {
    const res = intentsSvc.list({ actor, auth });
    pushResult({ op: op.op, actor, auth, res, endpoint });
  } else if (op.op === 'cycleProposals.list') {
    const res = proposalsRead.list({ actor, auth });
    pushResult({ op: op.op, actor, auth, res, endpoint });
  } else if (op.op === 'settlement.status') {
    const res = settlementRead.status({ actor, auth, cycleId });
    pushResult({ op: op.op, actor, auth, res, endpoint });
  } else {
    throw new Error(`unsupported op in scenario: ${op.op}`);
  }

  // Assert against expectations inline.
  const last = operations[operations.length - 1];
  if ((op.expect_ok ?? null) !== null) {
    assert.equal(last.ok, op.expect_ok);
  }
  if (!last.ok && op.expect_error_code) {
    assert.equal(last.error_code, op.expect_error_code);
  }
}

const out = canonicalize({
  operations
});

writeFileSync(path.join(outDir, 'authz_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M31', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
