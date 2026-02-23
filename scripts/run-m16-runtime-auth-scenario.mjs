import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { createRuntimeApiServer } from '../src/server/runtimeApiServer.mjs';
import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const root = process.cwd();
const outDir = process.env.OUT_DIR;
if (!outDir) {
  console.error('Missing OUT_DIR env');
  process.exit(2);
}
if (process.env.AUTHZ_ENFORCE !== '1') {
  console.error('AUTHZ_ENFORCE must be 1 for M16 runtime auth scenario');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hydrateCyclePlaceholders(value, cycleId) {
  if (Array.isArray(value)) return value.map(item => hydrateCyclePlaceholders(item, cycleId));
  if (!value || typeof value !== 'object') return value === '$CYCLE_ID' ? cycleId : value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = hydrateCyclePlaceholders(v, cycleId);
  }
  return out;
}

function methodForOperation(op) {
  if (op === 'receipts.get') return 'GET';
  return 'POST';
}

function pathForOperation({ op, cycleId }) {
  if (op === 'cycleProposals.accept') return `/cycle-proposals/${encodeURIComponent(cycleId)}/accept`;
  if (op === 'settlement.start') return `/settlement/${encodeURIComponent(cycleId)}/start`;
  if (op === 'settlement.deposit_confirmed') return `/settlement/${encodeURIComponent(cycleId)}/deposit-confirmed`;
  if (op === 'settlement.begin_execution') return `/settlement/${encodeURIComponent(cycleId)}/begin-execution`;
  if (op === 'settlement.complete') return `/settlement/${encodeURIComponent(cycleId)}/complete`;
  if (op === 'receipts.get') return `/receipts/${encodeURIComponent(cycleId)}`;
  throw new Error(`unsupported op: ${op}`);
}

const scenario = readJson(path.join(root, 'fixtures/settlement/m16_runtime_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/settlement/m16_runtime_expected.json'));

const apiManifest = readJson(path.join(root, 'docs/spec/api/manifest.v1.json'));
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(endpoint => [endpoint.operation_id, endpoint]));

const schemasDir = path.join(root, 'docs/spec/schemas');
const schemaFiles = readdirSync(schemasDir).filter(file => file.endsWith('.schema.json'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const schemaFile of schemaFiles) {
  ajv.addSchema(readJson(path.join(schemasDir, schemaFile)));
}

function validateAgainstSchemaFile(schemaFile, payload) {
  const schema = readJson(path.join(schemasDir, schemaFile));
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  const ok = validate(payload);
  return { ok, errors: validate.errors ?? [] };
}

function validateResponseSchema({ op, responseBody, ok }) {
  if (ok) {
    const endpoint = endpointsByOp.get(op);
    if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op}`);
    if (!endpoint.response_schema) return;
    const v = validateAgainstSchemaFile(endpoint.response_schema, responseBody);
    if (!v.ok) throw new Error(`response invalid for op=${op}: ${JSON.stringify(v.errors)}`);
    return;
  }

  const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', responseBody);
  if (!verr.ok) throw new Error(`error response invalid for op=${op}: ${JSON.stringify(verr.errors)}`);
}

const matchingInput = readJson(path.join(root, 'fixtures/matching/m5_input.json'));
const matchingOut = readJson(path.join(root, 'fixtures/matching/m5_expected.json'));
const proposal = (matchingOut.proposals ?? []).find(p => p.participants?.length === 3);
if (!proposal) throw new Error('expected 3-cycle proposal in matching fixtures');
const cycleId = proposal.id;

const actors = scenario.actors ?? {};
const proposalPartner = actors?.[scenario?.cycle?.proposal_partner_actor_ref ?? ''];
if (!proposalPartner?.id) throw new Error('scenario.cycle.proposal_partner_actor_ref must reference a partner actor');

const storeFile = path.join(outDir, 'runtime_m16_state.json');
const seedStore = new JsonStateStore({ filePath: storeFile });
seedStore.load();

for (const it of matchingInput.intents ?? []) {
  const intent = { ...it, status: it.status ?? 'active' };
  const v = validateAgainstSchemaFile('SwapIntent.schema.json', intent);
  if (!v.ok) throw new Error(`seed intent invalid: ${JSON.stringify(v.errors)}`);
  seedStore.state.intents[intent.id] = intent;
}

const proposalValidation = validateAgainstSchemaFile('CycleProposal.schema.json', proposal);
if (!proposalValidation.ok) throw new Error(`seed proposal invalid: ${JSON.stringify(proposalValidation.errors)}`);
seedStore.state.proposals[cycleId] = proposal;
seedStore.state.tenancy ||= {};
seedStore.state.tenancy.proposals ||= {};
seedStore.state.tenancy.proposals[cycleId] = { partner_id: proposalPartner.id };
seedStore.save();

const runtime = createRuntimeApiServer({
  host: '127.0.0.1',
  port: 0,
  stateBackend: 'json',
  storePath: storeFile
});
await runtime.listen();

const baseUrl = `http://${runtime.host}:${runtime.port}`;
const operations = [];

try {
  for (const op of scenario.operations ?? []) {
    const actor = actors[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

    const method = methodForOperation(op.op);
    const pathName = pathForOperation({ op: op.op, cycleId });
    const url = `${baseUrl}${pathName}`;
    const scopes = Array.isArray(op.scopes) ? op.scopes : [];
    const body = Object.prototype.hasOwnProperty.call(op, 'body')
      ? hydrateCyclePlaceholders(clone(op.body), cycleId)
      : undefined;

    const headers = {
      accept: 'application/json',
      'x-actor-type': actor.type,
      'x-actor-id': actor.id
    };
    if (scopes.length > 0) headers['x-auth-scopes'] = scopes.join(' ');
    if (op.idempotency_key) headers['idempotency-key'] = op.idempotency_key;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    const raw = await response.text();
    const responseBody = raw ? JSON.parse(raw) : {};
    const ok = response.status >= 200 && response.status < 300;

    validateResponseSchema({ op: op.op, responseBody, ok });

    assert.equal(response.status, op.expect_status, `status mismatch for ${op.op} actor=${op.actor_ref}`);
    if (Object.prototype.hasOwnProperty.call(op, 'expect_error_code')) {
      assert.equal(responseBody?.error?.code ?? null, op.expect_error_code, `error code mismatch for ${op.op} actor=${op.actor_ref}`);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_commit_phase')) {
      assert.equal(responseBody?.commit?.phase ?? null, op.expect_commit_phase, `commit phase mismatch for ${op.op} actor=${op.actor_ref}`);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_timeline_state')) {
      assert.equal(responseBody?.timeline?.state ?? null, op.expect_timeline_state, `timeline state mismatch for ${op.op} actor=${op.actor_ref}`);
    }
    if (Object.prototype.hasOwnProperty.call(op, 'expect_receipt_present')) {
      const receiptPresent = typeof responseBody?.receipt?.id === 'string' && responseBody.receipt.id.length > 0;
      assert.equal(receiptPresent, op.expect_receipt_present === true, `receipt presence mismatch for ${op.op} actor=${op.actor_ref}`);
    }

    operations.push({
      op: op.op,
      actor,
      scopes,
      status: response.status,
      ok,
      error_code: ok ? null : responseBody?.error?.code ?? null,
      commit_phase: responseBody?.commit?.phase ?? null,
      timeline_state: responseBody?.timeline?.state ?? null,
      receipt_id: responseBody?.receipt?.id ?? null,
      receipt_final_state: responseBody?.receipt?.final_state ?? null
    });
  }
} finally {
  await runtime.close();
}

const finalStore = new JsonStateStore({ filePath: storeFile });
finalStore.load();

const out = canonicalize({
  operations,
  state: {
    cycle_id: cycleId,
    proposal_partner_id: finalStore.state.tenancy?.proposals?.[cycleId]?.partner_id ?? null,
    cycle_partner_id: finalStore.state.tenancy?.cycles?.[cycleId]?.partner_id ?? null,
    timeline_state: finalStore.state.timelines?.[cycleId]?.state ?? null,
    receipt_id: finalStore.state.receipts?.[cycleId]?.id ?? null,
    receipt_final_state: finalStore.state.receipts?.[cycleId]?.final_state ?? null
  }
});

writeFileSync(path.join(outDir, 'runtime_auth_output.json'), JSON.stringify(out, null, 2));
assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'runtime_auth_assertions.json'), JSON.stringify({
  milestone: 'M16',
  check: 'runtime_auth',
  status: 'pass',
  operations: operations.length
}, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
