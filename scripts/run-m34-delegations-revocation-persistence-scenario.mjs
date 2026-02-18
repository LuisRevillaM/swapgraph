import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { DelegationsService } from '../src/service/delegationsService.mjs';
import { CycleProposalsReadService } from '../src/read/cycleProposalsReadService.mjs';
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
  console.error('AUTHZ_ENFORCE must be 1 for M34 scenario');
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
const scenarioPath = path.join(root, 'fixtures/delegation/m34_scenario.json');
const expectedPath = path.join(root, 'fixtures/delegation/m34_expected.json');
const scenario = readJson(scenarioPath);
const expected = readJson(expectedPath);

const actors = scenario.actors;

// ---- Seed store proposals ----
const matchingOut = readJson(path.join(root, 'fixtures/matching/m5_expected.json'));
const proposals = matchingOut.proposals;
const p3 = proposals.find(p => (p.participants ?? []).length === 3);
if (!p3) throw new Error('expected a 3-cycle proposal in fixtures');

const storeFile = path.join(outDir, 'store.json');
const store = new JsonStateStore({ filePath: storeFile });
store.load();

store.state.proposals ||= {};
for (const p of proposals) {
  const v = validateAgainstSchemaFile('CycleProposal.schema.json', p);
  if (!v.ok) throw new Error(`seed proposal invalid: ${JSON.stringify(v.errors)}`);
  store.state.proposals[p.id] = p;
}

// Partner scoping for completeness.
store.state.tenancy ||= {};
store.state.tenancy.proposals ||= {};
for (const p of proposals) {
  store.state.tenancy.proposals[p.id] = { partner_id: 'swapgraph' };
}

store.state.delegations ||= {};

store.save();

const delegationsSvc = new DelegationsService({ store });
const proposalsRead = new CycleProposalsReadService({ store });

let createdGrant = null;

function resolveAuth(opAuth) {
  const a = opAuth ?? {};
  if (a.use_created_delegation) {
    if (!createdGrant) throw new Error('createdGrant not available');
    return { delegation: createdGrant };
  }
  return { scopes: a.scopes ?? [] };
}

const operations = [];

for (const op of scenario.operations ?? []) {
  const endpoint = endpointsByOp.get(op.op);
  if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

  const actor = actors?.[op.actor_ref];
  if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  const auth = resolveAuth(op.auth);

  if (endpoint.request_schema) {
    const vreq = validateAgainstSchemaFile(endpoint.request_schema, op.request);
    if (!vreq.ok) throw new Error(`request invalid for op=${op.op}: ${JSON.stringify(vreq.errors)}`);
  }

  let replayed = undefined;
  let res;

  if (op.op === 'delegations.create') {
    const r = delegationsSvc.create({ actor, auth, idempotencyKey: op.idempotency_key, requestBody: op.request, occurredAt: op.occurred_at });
    replayed = r.replayed;
    res = r.result;

    if (res.ok) {
      createdGrant = JSON.parse(JSON.stringify(res.body.delegation));
    }
  } else if (op.op === 'delegations.get') {
    res = delegationsSvc.get({ actor, auth, delegationId: op.path?.id });
  } else if (op.op === 'delegations.revoke') {
    const r = delegationsSvc.revoke({ actor, auth, idempotencyKey: op.idempotency_key, delegationId: op.path?.id, requestBody: op.request });
    replayed = r.replayed;
    res = r.result;
  } else if (op.op === 'cycleProposals.list') {
    res = proposalsRead.list({ actor, auth });
  } else {
    throw new Error(`unsupported op in scenario: ${op.op}`);
  }

  // Validate response/error payload.
  if (res.ok) {
    const vres = validateAgainstSchemaFile(endpoint.response_schema, res.body);
    if (!vres.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(vres.errors)}`);
  } else {
    const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', res.body);
    if (!verr.ok) throw new Error(`error response invalid for op=${op.op}: ${JSON.stringify(verr.errors)}`);
  }

  const record = {
    op: op.op,
    actor,
    ok: res.ok,
    error_code: res.ok ? null : res.body.error.code
  };

  if (typeof replayed === 'boolean') record.replayed = replayed;

  if (op.op === 'cycleProposals.list') {
    record.proposals_count = res.ok ? (res.body.proposals ?? []).length : null;
    record.grant_revoked_at_present = createdGrant ? !!createdGrant.revoked_at : null;
  }

  if (op.op === 'delegations.get') {
    record.delegation_id = op.path?.id ?? null;
    record.revoked_at_present = res.ok ? !!res.body.delegation?.revoked_at : null;
  }

  if (op.op === 'delegations.create') {
    record.delegation_id = op.request?.delegation?.delegation_id ?? null;
  }

  if (op.op === 'delegations.revoke') {
    record.delegation_id = op.path?.id ?? null;
    record.revoked_at_present = res.ok ? !!res.body.delegation?.revoked_at : null;
  }

  operations.push(record);

  // Inline expectation checks.
  if (typeof op.expect_ok === 'boolean') assert.equal(record.ok, op.expect_ok);
  if (!record.ok && op.expect_error_code) assert.equal(record.error_code, op.expect_error_code);
  if (record.ok && typeof op.expect_proposals_count === 'number' && op.op === 'cycleProposals.list') {
    assert.equal(record.proposals_count, op.expect_proposals_count);
  }
  if (record.ok && typeof op.expect_revoked_at_present === 'boolean' && op.op === 'delegations.get') {
    assert.equal(record.revoked_at_present, op.expect_revoked_at_present);
  }
  if (!record.ok && typeof op.expect_grant_revoked_at_present === 'boolean' && op.op === 'cycleProposals.list') {
    assert.equal(record.grant_revoked_at_present, op.expect_grant_revoked_at_present);
  }
}

store.save();

const out = canonicalize({ operations });

writeFileSync(path.join(outDir, 'delegations_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M34', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
