import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { DelegationsService } from '../src/service/delegationsService.mjs';
import { CycleProposalsReadService } from '../src/read/cycleProposalsReadService.mjs';
import { CommitService } from '../src/commit/commitService.mjs';
import { SettlementReadService } from '../src/read/settlementReadService.mjs';
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
  console.error('AUTHZ_ENFORCE must be 1 for M37 scenario');
  process.exit(2);
}

const apiManifest = readJson(path.join(root, 'docs/spec/api/manifest.v1.json'));
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(e => [e.operation_id, e]));

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

function validateResponseOrError({ opName, endpoint, response }) {
  if (response.ok) {
    const v = validateAgainstSchemaFile(endpoint.response_schema, response.body);
    if (!v.ok) throw new Error(`response invalid for op=${opName}: ${JSON.stringify(v.errors)}`);
  } else {
    const v = validateAgainstSchemaFile('ErrorResponse.schema.json', response.body);
    if (!v.ok) throw new Error(`error response invalid for op=${opName}: ${JSON.stringify(v.errors)}`);
  }
}

function endpointForOperationId(operationId) {
  const ep = endpointsByOp.get(operationId);
  if (!ep) throw new Error(`missing endpoint in API manifest for operation_id=${operationId}`);
  return ep;
}

function parseTokenContext({ token, nowIso }) {
  const headers = {
    Authorization: `Bearer ${token}`
  };
  if (nowIso) headers['X-Now-Iso'] = nowIso;

  return parseAuthHeaders({ headers });
}

const scenarioPath = path.join(root, 'fixtures/delegation/m37_scenario.json');
const expectedPath = path.join(root, 'fixtures/delegation/m37_expected.json');
const scenario = readJson(scenarioPath);
const expected = readJson(expectedPath);

const storeFile = path.join(outDir, 'store.json');
const store = new JsonStateStore({ filePath: storeFile });
store.load();

store.state.proposals ||= {};
store.state.commits ||= {};
store.state.timelines ||= {};
store.state.receipts ||= {};
store.state.delegations ||= {};

for (const p of scenario.seed?.proposals ?? []) {
  const v = validateAgainstSchemaFile('CycleProposal.schema.json', p);
  if (!v.ok) throw new Error(`seed proposal invalid: ${JSON.stringify(v.errors)}`);
  store.state.proposals[p.id] = p;
}

for (const c of scenario.seed?.commits ?? []) {
  const v = validateAgainstSchemaFile('Commit.schema.json', c);
  if (!v.ok) throw new Error(`seed commit invalid: ${JSON.stringify(v.errors)}`);
  store.state.commits[c.id] = c;
}

for (const t of scenario.seed?.timelines ?? []) {
  const v = validateAgainstSchemaFile('SettlementTimeline.schema.json', t);
  if (!v.ok) throw new Error(`seed timeline invalid: ${JSON.stringify(v.errors)}`);
  store.state.timelines[t.cycle_id] = t;
}

for (const r of scenario.seed?.receipts ?? []) {
  const v = validateAgainstSchemaFile('SwapReceipt.schema.json', r);
  if (!v.ok) throw new Error(`seed receipt invalid: ${JSON.stringify(v.errors)}`);
  store.state.receipts[r.cycle_id] = r;
}

store.save();

const actors = scenario.actors ?? {};
const tokenRefs = {};
const operations = [];

const delegationsSvc = new DelegationsService({ store });
const cycleReadSvc = new CycleProposalsReadService({ store });
const commitSvc = new CommitService({ store });
const settlementReadSvc = new SettlementReadService({ store });

for (const op of scenario.operations ?? []) {
  if (op.op === 'delegations.create') {
    const endpoint = endpointForOperationId('delegations.create');

    const actor = actors?.[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

    const auth = op.auth ?? {};
    const requestBody = op.request;

    const vreq = validateAgainstSchemaFile(endpoint.request_schema, requestBody);
    if (!vreq.ok) throw new Error(`request invalid for op=${op.op}: ${JSON.stringify(vreq.errors)}`);

    const r = delegationsSvc.create({
      actor,
      auth,
      idempotencyKey: op.idempotency_key,
      requestBody,
      occurredAt: op.occurred_at
    });

    const response = r.result;
    validateResponseOrError({ opName: op.op, endpoint, response });

    if (response.ok) {
      const saveTokenRef = op.save_token_ref ?? 'created';
      tokenRefs[saveTokenRef] = response.body.delegation_token;
    }

    const rec = {
      op: op.op,
      actor,
      ok: response.ok,
      replayed: r.replayed,
      error_code: response.ok ? null : response.body.error.code,
      delegation_id: op.request?.delegation?.delegation_id ?? null
    };
    operations.push(rec);

    if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
    continue;
  }

  if (op.op === 'authHeaders.parse') {
    const token = tokenRefs[op.token_ref];
    if (!token) throw new Error(`missing token_ref: ${op.token_ref}`);

    const parsed = parseTokenContext({ token, nowIso: op.now_iso });

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

  if (
    op.op === 'cycleProposals.list.via_token' ||
    op.op === 'cycleProposals.get.via_token' ||
    op.op === 'commits.get.via_token' ||
    op.op === 'settlement.status.via_token' ||
    op.op === 'settlement.instructions.via_token' ||
    op.op === 'receipts.get.via_token'
  ) {
    const token = tokenRefs[op.token_ref];
    if (!token) throw new Error(`missing token_ref: ${op.token_ref}`);

    const parsed = parseTokenContext({ token, nowIso: op.now_iso });
    if (!parsed.ok) {
      const rec = {
        op: op.op,
        parse_ok: false,
        ok: false,
        error_code: parsed.error.code
      };
      operations.push(rec);

      if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
      if (op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
      continue;
    }

    let response;
    let endpoint;

    if (op.op === 'cycleProposals.list.via_token') {
      endpoint = endpointForOperationId('cycleProposals.list');
      response = cycleReadSvc.list({ actor: parsed.actor, auth: parsed.auth });
    } else if (op.op === 'cycleProposals.get.via_token') {
      endpoint = endpointForOperationId('cycleProposals.get');
      response = cycleReadSvc.get({ actor: parsed.actor, auth: parsed.auth, proposalId: op.path?.id });
    } else if (op.op === 'commits.get.via_token') {
      endpoint = endpointForOperationId('commits.get');
      response = commitSvc.get({ actor: parsed.actor, auth: parsed.auth, commitId: op.path?.id });
    } else if (op.op === 'settlement.status.via_token') {
      endpoint = endpointForOperationId('settlement.status');
      response = settlementReadSvc.status({ actor: parsed.actor, auth: parsed.auth, cycleId: op.path?.cycle_id });
    } else if (op.op === 'settlement.instructions.via_token') {
      endpoint = endpointForOperationId('settlement.instructions');
      response = settlementReadSvc.instructions({ actor: parsed.actor, auth: parsed.auth, cycleId: op.path?.cycle_id });
    } else if (op.op === 'receipts.get.via_token') {
      endpoint = endpointForOperationId('receipts.get');
      response = settlementReadSvc.receipt({ actor: parsed.actor, auth: parsed.auth, cycleId: op.path?.cycle_id });
    }

    validateResponseOrError({ opName: op.op, endpoint, response });

    const rec = {
      op: op.op,
      parse_ok: true,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code
    };

    if (op.op === 'cycleProposals.list.via_token') {
      rec.proposal_ids = response.ok ? (response.body.proposals ?? []).map(p => p.id).sort() : null;
      rec.proposals_count = response.ok ? (response.body.proposals ?? []).length : null;
    }

    if (op.op === 'cycleProposals.get.via_token') {
      rec.proposal_id = op.path?.id ?? null;
      rec.proposal_found = response.ok ? response.body.proposal?.id ?? null : null;
    }

    if (op.op === 'commits.get.via_token') {
      rec.commit_id = op.path?.id ?? null;
      rec.commit_phase = response.ok ? response.body.commit?.phase ?? null : null;
    }

    if (op.op === 'settlement.status.via_token') {
      rec.cycle_id = op.path?.cycle_id ?? null;
      rec.timeline_state = response.ok ? response.body.timeline?.state ?? null : null;
    }

    if (op.op === 'settlement.instructions.via_token') {
      rec.cycle_id = op.path?.cycle_id ?? null;
      rec.instructions_count = response.ok ? (response.body.instructions ?? []).length : null;
    }

    if (op.op === 'receipts.get.via_token') {
      rec.cycle_id = op.path?.cycle_id ?? null;
      rec.receipt_final_state = response.ok ? response.body.receipt?.final_state ?? null : null;
    }

    operations.push(rec);

    if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
    if (!rec.ok && op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
    if (Array.isArray(op.expect_proposal_ids)) assert.deepEqual(rec.proposal_ids, op.expect_proposal_ids);
    if (typeof op.expect_instructions_count === 'number') assert.equal(rec.instructions_count, op.expect_instructions_count);

    continue;
  }

  throw new Error(`unsupported op in scenario: ${op.op}`);
}

store.save();

const out = canonicalize({ operations });
writeFileSync(path.join(outDir, 'policy_boundaries_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M37', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length } }, null, 2));
