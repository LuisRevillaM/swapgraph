import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { DelegationsService } from '../src/service/delegationsService.mjs';
import { SwapIntentsService } from '../src/service/swapIntentsService.mjs';
import { parseAuthHeaders } from '../src/core/authHeaders.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const root = process.cwd();
const outDir = process.env.OUT_DIR;
if (!outDir) {
  console.error('Missing OUT_DIR env');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

if (process.env.AUTHZ_ENFORCE !== '1') {
  console.error('AUTHZ_ENFORCE must be 1 for M38 scenario');
  process.exit(2);
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

const apiManifest = readJson(path.join(root, 'docs/spec/api/manifest.v1.json'));
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(e => [e.operation_id, e]));

const schemasDir = path.join(root, 'docs/spec/schemas');
const schemaFiles = readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const sf of schemaFiles) ajv.addSchema(readJson(path.join(schemasDir, sf)));

function validateAgainstSchemaFile(schemaFile, payload) {
  const schema = readJson(path.join(schemasDir, schemaFile));
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  const ok = validate(payload);
  return { ok, errors: validate.errors ?? [] };
}

function validateResponseOrError({ endpoint, opName, response }) {
  if (response.ok) {
    const vr = validateAgainstSchemaFile(endpoint.response_schema, response.body);
    if (!vr.ok) throw new Error(`response invalid for op=${opName}: ${JSON.stringify(vr.errors)}`);
  } else {
    const ve = validateAgainstSchemaFile('ErrorResponse.schema.json', response.body);
    if (!ve.ok) throw new Error(`error response invalid for op=${opName}: ${JSON.stringify(ve.errors)}`);
  }
}

function endpointFor(operationId) {
  const ep = endpointsByOp.get(operationId);
  if (!ep) throw new Error(`missing endpoint for operation_id=${operationId}`);
  return ep;
}

const scenario = readJson(path.join(root, 'fixtures/delegation/m38_scenario.json'));
const expected = readJson(path.join(root, 'fixtures/delegation/m38_expected.json'));

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();
store.save();

const delegationsSvc = new DelegationsService({ store });
const intentsSvc = new SwapIntentsService({ store });

const actors = scenario.actors ?? {};
const tokenRefs = {};
const operations = [];

for (const op of scenario.operations ?? []) {
  if (op.op === 'delegations.create') {
    const endpoint = endpointFor('delegations.create');
    const actor = actors?.[op.actor_ref];
    if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

    const vreq = validateAgainstSchemaFile(endpoint.request_schema, op.request);
    if (!vreq.ok) throw new Error(`request invalid for op=${op.op}: ${JSON.stringify(vreq.errors)}`);

    const r = delegationsSvc.create({
      actor,
      auth: op.auth ?? {},
      idempotencyKey: op.idempotency_key,
      requestBody: op.request,
      occurredAt: op.occurred_at
    });

    const response = r.result;
    validateResponseOrError({ endpoint, opName: op.op, response });

    if (response.ok) {
      tokenRefs[op.save_token_ref ?? 'created'] = response.body.delegation_token;
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

    const parsed = parseAuthHeaders({ headers: { Authorization: `Bearer ${token}` } });

    const rec = {
      op: op.op,
      ok: parsed.ok,
      error_code: parsed.ok ? null : parsed.error.code,
      actor: parsed.ok ? parsed.actor : null
    };
    operations.push(rec);

    if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
    if (rec.ok && op.expect_actor) assert.deepEqual(rec.actor, op.expect_actor);
    if (!rec.ok && op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
    continue;
  }

  if (
    op.op === 'swapIntents.create.via_token' ||
    op.op === 'swapIntents.update.via_token' ||
    op.op === 'swapIntents.cancel.via_token' ||
    op.op === 'swapIntents.list.via_token'
  ) {
    const token = tokenRefs[op.token_ref];
    if (!token) throw new Error(`missing token_ref: ${op.token_ref}`);

    const headers = { Authorization: `Bearer ${token}` };
    if (op.auth?.now_iso) headers['X-Now-Iso'] = op.auth.now_iso;

    const parsed = parseAuthHeaders({ headers });
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

    const auth = { ...(parsed.auth ?? {}) };
    if (op.auth?.user_consent) auth.user_consent = op.auth.user_consent;

    let endpoint;
    let r;

    if (op.op === 'swapIntents.create.via_token') {
      endpoint = endpointFor('swapIntents.create');
      const vreq = validateAgainstSchemaFile(endpoint.request_schema, op.request);
      if (!vreq.ok) throw new Error(`request invalid for op=${op.op}: ${JSON.stringify(vreq.errors)}`);
      r = intentsSvc.create({ actor: parsed.actor, auth, idempotencyKey: op.idempotency_key, requestBody: op.request });
    } else if (op.op === 'swapIntents.update.via_token') {
      endpoint = endpointFor('swapIntents.update');
      const vreq = validateAgainstSchemaFile(endpoint.request_schema, op.request);
      if (!vreq.ok) throw new Error(`request invalid for op=${op.op}: ${JSON.stringify(vreq.errors)}`);
      r = intentsSvc.update({ actor: parsed.actor, auth, id: op.path?.id, idempotencyKey: op.idempotency_key, requestBody: op.request });
    } else if (op.op === 'swapIntents.cancel.via_token') {
      endpoint = endpointFor('swapIntents.cancel');
      const vreq = validateAgainstSchemaFile(endpoint.request_schema, op.request);
      if (!vreq.ok) throw new Error(`request invalid for op=${op.op}: ${JSON.stringify(vreq.errors)}`);
      r = intentsSvc.cancel({ actor: parsed.actor, auth, idempotencyKey: op.idempotency_key, requestBody: op.request });
    } else if (op.op === 'swapIntents.list.via_token') {
      endpoint = endpointFor('swapIntents.list');
      r = intentsSvc.list({ actor: parsed.actor, auth });
    }

    const response = r?.result ?? r;
    validateResponseOrError({ endpoint, opName: op.op, response });

    const rec = {
      op: op.op,
      parse_ok: true,
      ok: response.ok,
      error_code: response.ok ? null : response.body.error.code
    };

    if (typeof r?.replayed === 'boolean') rec.replayed = r.replayed;

    if (op.op === 'swapIntents.create.via_token') {
      rec.intent_id = op.request?.intent?.id ?? null;
    }

    if (op.op === 'swapIntents.update.via_token') {
      rec.intent_id = op.path?.id ?? null;
      rec.updated_max_usd = response.ok ? response.body.intent?.value_band?.max_usd ?? null : null;
    }

    if (op.op === 'swapIntents.cancel.via_token') {
      rec.intent_id = op.request?.id ?? null;
      rec.status = response.ok ? response.body.status ?? null : null;
    }

    if (op.op === 'swapIntents.list.via_token') {
      rec.intent_ids = response.ok ? (response.body.intents ?? []).map(i => i.id).sort() : null;
      rec.intents_count = response.ok ? (response.body.intents ?? []).length : null;
    }

    operations.push(rec);

    if (typeof op.expect_ok === 'boolean') assert.equal(rec.ok, op.expect_ok);
    if (!rec.ok && op.expect_error_code) assert.equal(rec.error_code, op.expect_error_code);
    if (Array.isArray(op.expect_intent_ids)) assert.deepEqual(rec.intent_ids, op.expect_intent_ids);
    continue;
  }

  throw new Error(`unsupported op in scenario: ${op.op}`);
}

store.save();

const intentsSnapshot = Object.values(store.state.intents)
  .map(i => ({
    id: i.id,
    status: i.status ?? 'active',
    max_usd: i.value_band?.max_usd ?? null
  }))
  .sort((a, b) => a.id.localeCompare(b.id));

const auditSnapshot = (store.state.policy_audit ?? []).map(a => ({
  operation_id: a.operation_id,
  decision: a.decision,
  reason_code: a.reason_code,
  intent_id: a.intent_id,
  day_key: a.details?.day_key ?? null,
  projected_usd: a.details?.projected_usd ?? null,
  cap_usd: a.details?.cap_usd ?? null,
  consent_id: a.details?.consent_id ?? null
}));

const out = canonicalize({
  operations,
  final: {
    intents: intentsSnapshot,
    policy_spend_daily: store.state.policy_spend_daily,
    policy_audit: auditSnapshot
  }
});

writeFileSync(path.join(outDir, 'delegated_write_policy_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M38', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length, intents: intentsSnapshot.length, audit: auditSnapshot.length } }, null, 2));
