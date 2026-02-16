import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { SwapIntentsService } from '../src/service/swapIntentsService.mjs';

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

const scenarioPath = path.join(root, 'fixtures/scenarios/m4_intents_scenario.json');
const expectedPath = path.join(root, 'fixtures/scenarios/m4_expected_results.json');

const scenario = readJson(scenarioPath);
const expected = readJson(expectedPath);

const storeFile = path.join(outDir, 'store.json');
const store = new JsonStateStore({ filePath: storeFile });
store.load();

const svc = new SwapIntentsService({ store });

// Load API manifest for schema mapping.
const apiManifest = readJson(path.join(root, 'docs/spec/api/manifest.v1.json'));
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(e => [e.operation_id, e]));

// Load all schemas.
const schemasDir = path.join(root, 'docs/spec/schemas');
const schemaFiles = readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const sf of schemaFiles) {
  const s = readJson(path.join(schemasDir, sf));
  ajv.addSchema(s);
}

function validateAgainstSchemaFile(schemaFile, payload) {
  const schema = readJson(path.join(schemasDir, schemaFile));
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  const ok = validate(payload);
  return { ok, errors: validate.errors ?? [] };
}

const results = [];
for (const op of scenario.operations) {
  const endpoint = endpointsByOp.get(op.op);
  if (!endpoint) throw new Error(`Unknown op in scenario: ${op.op}`);

  // validate request if schema present
  if (endpoint.request_schema) {
    const vreq = validateAgainstSchemaFile(endpoint.request_schema, op.request);
    if (!vreq.ok) {
      throw new Error(`Scenario request invalid for op=${op.op}: ${JSON.stringify(vreq.errors)}`);
    }
  }

  let replayed = false;
  let res;

  if (op.op === 'swapIntents.create') {
    const r = svc.create({ actor: op.actor, idempotencyKey: op.idempotency_key, requestBody: op.request });
    replayed = r.replayed;
    res = r.result;
  } else if (op.op === 'swapIntents.update') {
    const r = svc.update({ actor: op.actor, id: op.path.id, idempotencyKey: op.idempotency_key, requestBody: op.request });
    replayed = r.replayed;
    res = r.result;
  } else if (op.op === 'swapIntents.cancel') {
    const r = svc.cancel({ actor: op.actor, idempotencyKey: op.idempotency_key, requestBody: op.request });
    replayed = r.replayed;
    res = r.result;
  } else if (op.op === 'swapIntents.get') {
    res = svc.get({ actor: op.actor, id: op.path.id });
  } else if (op.op === 'swapIntents.list') {
    res = svc.list({ actor: op.actor });
  } else {
    throw new Error(`op not implemented: ${op.op}`);
  }

  // validate response/error payload
  if (res.ok) {
    const vres = validateAgainstSchemaFile(endpoint.response_schema, res.body);
    if (!vres.ok) {
      throw new Error(`Response invalid for op=${op.op}: ${JSON.stringify(vres.errors)}`);
    }
  } else {
    const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', res.body);
    if (!verr.ok) {
      throw new Error(`Error response invalid for op=${op.op}: ${JSON.stringify(verr.errors)}`);
    }
  }

  results.push({ op: op.op, ok: res.ok, replayed: op.idempotency_key ? replayed : undefined, body: res.body });
}

store.save();

// Reload store to prove persistence.
const store2 = new JsonStateStore({ filePath: storeFile });
store2.load();
const finalIntent = store2.state.intents['intent_123'];

const summary = {
  operations: results.map(r => {
    const o = { op: r.op, ok: r.ok };
    if (typeof r.replayed === 'boolean') o.replayed = r.replayed;
    if (!r.ok) o.error_code = r.body?.error?.code;
    return o;
  }),
  final_intent_status: finalIntent?.status ?? null
};

// compare summary to expected
import assert from 'node:assert/strict';
assert.deepEqual(summary, expected);

writeFileSync(path.join(outDir, 'intent_ingestion_results.json'), JSON.stringify(results, null, 2));
writeFileSync(path.join(outDir, 'intents_store_snapshot.json'), JSON.stringify({ intents: store2.state.intents, idempotency_keys: Object.keys(store2.state.idempotency).length }, null, 2));
writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: 'M4', status: 'pass' }, null, 2));

console.log(JSON.stringify({ ok: true, summary }, null, 2));
