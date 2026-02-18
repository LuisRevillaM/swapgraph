import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { SwapIntentsService } from '../src/service/swapIntentsService.mjs';
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
  console.error('AUTHZ_ENFORCE must be 1 for M32 scenario');
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
const scenarioPath = path.join(root, 'fixtures/delegation/m32_scenario.json');
const expectedPath = path.join(root, 'fixtures/delegation/m32_expected.json');
const scenario = readJson(scenarioPath);
const expected = readJson(expectedPath);

const actors = scenario.actors;
const delegations = scenario.delegations;

function resolveAuth(authSpec) {
  const a = authSpec ?? {};
  const out = {};

  if (Array.isArray(a.scopes)) out.scopes = a.scopes;

  if (a.delegation_ref) {
    const d = delegations?.[a.delegation_ref];
    if (!d) throw new Error(`unknown delegation_ref: ${a.delegation_ref}`);
    const vd = validateAgainstSchemaFile('DelegationGrant.schema.json', d);
    if (!vd.ok) throw new Error(`delegation invalid for ref=${a.delegation_ref}: ${JSON.stringify(vd.errors)}`);
    out.delegation = d;
  }

  return out;
}

// ---- Seed store ----
const storeFile = path.join(outDir, 'store.json');
const store = new JsonStateStore({ filePath: storeFile });
store.load();

for (const it of scenario.seed_intents ?? []) {
  const intent = { ...it, status: it.status ?? 'active' };
  const v = validateAgainstSchemaFile('SwapIntent.schema.json', intent);
  if (!v.ok) throw new Error(`seed intent invalid: ${JSON.stringify(v.errors)}`);
  store.state.intents[intent.id] = intent;
}

store.save();

const svc = new SwapIntentsService({ store });

const operations = [];

function summarizeList(res) {
  const ids = (res.body?.intents ?? []).map(i => i.id).slice().sort();
  return { intents_count: ids.length, intent_ids: ids };
}

for (const op of scenario.ops ?? []) {
  const endpoint = endpointsByOp.get(op.op);
  if (!endpoint) throw new Error(`missing endpoint in API manifest for op=${op.op}`);

  const actor = actors?.[op.actor_ref];
  if (!actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);

  const auth = resolveAuth(op.auth);

  // Validate request if schema present.
  if (endpoint.request_schema) {
    const vreq = validateAgainstSchemaFile(endpoint.request_schema, op.request);
    if (!vreq.ok) throw new Error(`request invalid for op=${op.op}: ${JSON.stringify(vreq.errors)}`);
  }

  let replayed = undefined;
  let res;

  if (op.op === 'swapIntents.create') {
    const r = svc.create({ actor, auth, idempotencyKey: op.idempotency_key, requestBody: op.request });
    replayed = r.replayed;
    res = r.result;
  } else if (op.op === 'swapIntents.update') {
    const r = svc.update({ actor, auth, id: op.path?.id, idempotencyKey: op.idempotency_key, requestBody: op.request });
    replayed = r.replayed;
    res = r.result;
  } else if (op.op === 'swapIntents.cancel') {
    const r = svc.cancel({ actor, auth, idempotencyKey: op.idempotency_key, requestBody: op.request });
    replayed = r.replayed;
    res = r.result;
  } else if (op.op === 'swapIntents.get') {
    res = svc.get({ actor, auth, id: op.path?.id });
  } else if (op.op === 'swapIntents.list') {
    res = svc.list({ actor, auth });
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
    auth: auth.delegation ? { delegation_id: auth.delegation.delegation_id, scopes: auth.delegation.scopes } : { scopes: auth.scopes ?? [] },
    ok: res.ok,
    error_code: res.ok ? null : res.body.error.code
  };
  if (typeof replayed === 'boolean') record.replayed = replayed;

  if (op.op === 'swapIntents.list' && res.ok) {
    Object.assign(record, summarizeList(res));
  }

  if (op.op === 'swapIntents.get') {
    record.id = op.path?.id ?? null;
    if (res.ok) record.returned_intent_id = res.body.intent?.id ?? null;
  }

  if (op.op === 'swapIntents.create') {
    record.intent_id = op.request?.intent?.id ?? null;
  }

  operations.push(record);

  // Inline expectation checks.
  if (typeof op.expect_ok === 'boolean') {
    assert.equal(record.ok, op.expect_ok, `expect_ok mismatch for op=${op.op}`);
  }
  if (!record.ok && op.expect_error_code) {
    assert.equal(record.error_code, op.expect_error_code, `expect_error_code mismatch for op=${op.op}`);
  }
  if (record.ok && typeof op.expect_intents_count === 'number' && op.op === 'swapIntents.list') {
    assert.equal(record.intents_count, op.expect_intents_count);
  }
  if (record.ok && Array.isArray(op.expect_intent_ids) && op.op === 'swapIntents.list') {
    assert.deepEqual(record.intent_ids, op.expect_intent_ids);
  }
}

store.save();

const snapshot = Object.values(store.state.intents)
  .map(i => ({
    id: i.id,
    actor: i.actor,
    status: i.status ?? 'active',
    max_usd: i.value_band?.max_usd ?? null
  }))
  .sort((a, b) => a.id.localeCompare(b.id));

const out = canonicalize({
  operations,
  final: {
    intents: snapshot
  }
});

writeFileSync(path.join(outDir, 'delegation_output.json'), JSON.stringify(out, null, 2));

assert.deepEqual(out, expected);

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M32', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, stats: { operations: operations.length, intents: snapshot.length } }, null, 2));
