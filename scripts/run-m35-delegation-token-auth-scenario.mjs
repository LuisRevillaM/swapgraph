import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { DelegationsService } from '../src/service/delegationsService.mjs';
import { CycleProposalsReadService } from '../src/read/cycleProposalsReadService.mjs';
import { parseAuthHeaders } from '../src/core/authHeaders.mjs';
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

if (process.env.AUTHZ_ENFORCE !== '1') {
  console.error('AUTHZ_ENFORCE must be 1 for M35 scenario');
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
const scenarioPath = path.join(root, 'fixtures/delegation/m35_scenario.json');
const expectedPath = path.join(root, 'fixtures/delegation/m35_expected.json');
const scenario = readJson(scenarioPath);
const expected = readJson(expectedPath);

const actors = scenario.actors;

// ---- Seed store proposals ----
const matchingOut = readJson(path.join(root, 'fixtures/matching/m5_expected.json'));
const proposals = matchingOut.proposals;

const storeFile = path.join(outDir, 'store.json');
const store = new JsonStateStore({ filePath: storeFile });
store.load();

store.state.proposals ||= {};
for (const p of proposals) {
  const v = validateAgainstSchemaFile('CycleProposal.schema.json', p);
  if (!v.ok) throw new Error(`seed proposal invalid: ${JSON.stringify(v.errors)}`);
  store.state.proposals[p.id] = p;
}

store.state.tenancy ||= {};
store.state.tenancy.proposals ||= {};
for (const p of proposals) {
  store.state.tenancy.proposals[p.id] = { partner_id: 'swapgraph' };
}

store.state.delegations ||= {};

store.save();

const delegationsSvc = new DelegationsService({ store });
const proposalsRead = new CycleProposalsReadService({ store });

function tamperToken(token) {
  if (!token || typeof token !== 'string' || token.length < 5) throw new Error('token too short to tamper');
  const last = token[token.length - 1];
  const flipped = last === 'A' ? 'B' : 'A';
  return token.slice(0, -1) + flipped;
}

const tokenRefs = {};
const operations = [];

for (const op of scenario.operations ?? []) {
  if (op.op === 'delegations.create') {
    const actor = actors?.[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

    const endpoint = endpointsByOp.get('delegations.create');
    if (!endpoint) throw new Error('missing endpoint for delegations.create');

    const auth = op.auth ?? {};

    const vreq = validateAgainstSchemaFile(endpoint.request_schema, op.request);
    if (!vreq.ok) throw new Error(`request invalid for op=${op.op}: ${JSON.stringify(vreq.errors)}`);

    const r = delegationsSvc.create({ actor, auth, idempotencyKey: op.idempotency_key, requestBody: op.request, occurredAt: op.occurred_at });
    const res = r.result;

    if (res.ok) {
      const vres = validateAgainstSchemaFile(endpoint.response_schema, res.body);
      if (!vres.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(vres.errors)}`);
      tokenRefs.created = res.body.delegation_token;
    } else {
      const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', res.body);
      if (!verr.ok) throw new Error(`error response invalid for op=${op.op}: ${JSON.stringify(verr.errors)}`);
    }

    const rec = {
      op: op.op,
      actor,
      ok: res.ok,
      replayed: r.replayed,
      error_code: res.ok ? null : res.body.error.code,
      delegation_id: op.request?.delegation?.delegation_id ?? null,
      has_delegation_token: res.ok ? typeof res.body.delegation_token === 'string' : null
    };
    operations.push(rec);

    if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
    continue;
  }

  if (op.op === 'delegations.revoke') {
    const actor = actors?.[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

    const endpoint = endpointsByOp.get('delegations.revoke');
    if (!endpoint) throw new Error('missing endpoint for delegations.revoke');

    const auth = op.auth ?? {};

    const vreq = validateAgainstSchemaFile(endpoint.request_schema, op.request);
    if (!vreq.ok) throw new Error(`request invalid for op=${op.op}: ${JSON.stringify(vreq.errors)}`);

    const r = delegationsSvc.revoke({ actor, auth, idempotencyKey: op.idempotency_key, delegationId: op.path?.id, requestBody: op.request });
    const res = r.result;

    if (res.ok) {
      const vres = validateAgainstSchemaFile(endpoint.response_schema, res.body);
      if (!vres.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(vres.errors)}`);
    } else {
      const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', res.body);
      if (!verr.ok) throw new Error(`error response invalid for op=${op.op}: ${JSON.stringify(verr.errors)}`);
    }

    const rec = {
      op: op.op,
      actor,
      ok: res.ok,
      replayed: r.replayed,
      error_code: res.ok ? null : res.body.error.code,
      delegation_id: op.path?.id ?? null,
      revoked_at_present: res.ok ? !!res.body.delegation?.revoked_at : null
    };
    operations.push(rec);

    if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
    continue;
  }

  if (op.op === 'authHeaders.parse' || op.op === 'authHeaders.parse.tampered') {
    const baseToken = tokenRefs[op.token_ref];
    if (!baseToken) throw new Error(`missing token_ref: ${op.token_ref}`);

    const token = op.op === 'authHeaders.parse.tampered' ? tamperToken(baseToken) : baseToken;
    const parsed = parseAuthHeaders({ headers: { Authorization: `Bearer ${token}` } });

    const rec = {
      op: op.op,
      ok: parsed.ok,
      error_code: parsed.ok ? null : parsed.error.code,
      actor: parsed.ok ? parsed.actor : null
    };
    operations.push(rec);

    if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
    if (!rec.ok && op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
    if (rec.ok && op.expect_actor) assert.deepEqual(rec.actor, op.expect_actor);
    continue;
  }

  if (op.op === 'cycleProposals.list.via_token') {
    const token = tokenRefs[op.token_ref];
    if (!token) throw new Error(`missing token_ref: ${op.token_ref}`);

    const parsed = parseAuthHeaders({ headers: { Authorization: `Bearer ${token}` } });

    const endpoint = endpointsByOp.get('cycleProposals.list');
    if (!endpoint) throw new Error('missing endpoint for cycleProposals.list');

    let rec;

    if (!parsed.ok) {
      rec = {
        op: op.op,
        parse_ok: false,
        ok: false,
        error_code: parsed.error.code,
        proposals_count: null
      };
      operations.push(rec);
    } else {
      const res = proposalsRead.list({ actor: parsed.actor, auth: parsed.auth });

      if (res.ok) {
        const vres = validateAgainstSchemaFile(endpoint.response_schema, res.body);
        if (!vres.ok) throw new Error(`response invalid for op=${op.op}: ${JSON.stringify(vres.errors)}`);
      } else {
        const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', res.body);
        if (!verr.ok) throw new Error(`error response invalid for op=${op.op}: ${JSON.stringify(verr.errors)}`);
      }

      rec = {
        op: op.op,
        parse_ok: true,
        ok: res.ok,
        error_code: res.ok ? null : res.body.error.code,
        proposals_count: res.ok ? (res.body.proposals ?? []).length : null
      };
      operations.push(rec);
    }

    if (typeof op.expect_parse_ok === 'boolean') assert.equal(rec.parse_ok, op.expect_parse_ok);
    if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
    if (!rec.ok && op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
    if (rec.ok && typeof op.expect_proposals_count === 'number') assert.equal(rec.proposals_count, op.expect_proposals_count);
    continue;
  }

  throw new Error(`unsupported op in scenario: ${op.op}`);
}

store.save();

const out = canonicalize({ operations });

writeFileSync(path.join(outDir, 'delegation_token_auth_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M35', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
