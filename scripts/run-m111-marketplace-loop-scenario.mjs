import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { MarketplaceMatchingService } from '../src/service/marketplaceMatchingService.mjs';
import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M111';
const SCENARIO_FILE = 'fixtures/release/m111_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m111_expected.json';
const OUTPUT_FILE = 'marketplace_matching_output.json';

const root = process.cwd();
const outDir = process.env.OUT_DIR;
if (!outDir) {
  console.error('Missing OUT_DIR env');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256HexCanonical(value) {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function reasonCodeFromError(body) {
  return body?.error?.details?.reason_code ?? null;
}

function applyExpectations(op, rec) {
  for (const [key, value] of Object.entries(op)) {
    if (!key.startsWith('expect_')) continue;
    const field = key.slice('expect_'.length);
    assert.deepEqual(rec[field], value, `expectation_failed op=${op.op} field=${field}`);
  }
}

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

const apiManifest = readJson(path.join(root, 'docs/spec/api/manifest.v1.json'));
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(ep => [ep.operation_id, ep]));

function endpointFor(opId) {
  const endpoint = endpointsByOp.get(opId);
  if (!endpoint) throw new Error(`missing endpoint for operation_id=${opId}`);
  return endpoint;
}

function validateApiRequest(opId, requestPayload) {
  const endpoint = endpointFor(opId);
  if (!endpoint.request_schema) return;
  const v = validateAgainstSchemaFile(endpoint.request_schema, requestPayload);
  if (!v.ok) throw new Error(`request invalid for op=${opId}: ${JSON.stringify(v.errors)}`);
}

function validateApiResponse(opId, response) {
  const endpoint = endpointFor(opId);
  if (response.ok) {
    const v = validateAgainstSchemaFile(endpoint.response_schema, response.body);
    if (!v.ok) throw new Error(`response invalid for op=${opId}: ${JSON.stringify(v.errors)}`);
    return;
  }
  const verr = validateAgainstSchemaFile('ErrorResponse.schema.json', response.body);
  if (!verr.ok) throw new Error(`error response invalid for op=${opId}: ${JSON.stringify(verr.errors)}`);
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const actors = scenario.actors ?? {};

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();
for (const [key, value] of Object.entries(scenario.seed_state ?? {})) {
  store.state[key] = clone(value);
}

if (scenario.seed_from_matching_fixture === true) {
  const matching = readJson(path.join(root, 'fixtures/matching/m5_input.json'));
  store.state.intents ||= {};
  for (const intent of matching.intents ?? []) {
    store.state.intents[intent.id] = { ...clone(intent), status: intent.status ?? 'active' };
  }
}

const service = new MarketplaceMatchingService({ store });
const operations = [];

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);
  const auth = op.auth ?? {};

  let response;
  let replayed = null;

  if (op.op === 'marketplaceMatching.run') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.runMatching({ actor, auth, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'marketplaceMatchingRun.get') {
    response = service.getMatchingRun({ actor, auth, runId: op.run_id });
  } else {
    throw new Error(`unsupported op: ${op.op}`);
  }

  validateApiResponse(op.op, response);

  const rec = {
    op: op.op,
    ok: response.ok,
    replayed,
    error_code: response.ok ? null : response.body.error.code,
    reason_code: response.ok ? null : reasonCodeFromError(response.body)
  };

  if (response.ok && response.body.run) {
    rec.run_id = response.body.run.run_id ?? null;
    rec.selected_proposals_count = response.body.run.selected_proposals_count ?? null;
    rec.stored_proposals_count = response.body.run.stored_proposals_count ?? null;
    rec.replaced_proposals_count = response.body.run.replaced_proposals_count ?? null;
    rec.expired_proposals_count = response.body.run.expired_proposals_count ?? null;
    rec.first_proposal_id = response.body.run.proposal_ids?.[0] ?? null;
    rec.candidate_cycles = response.body.run.stats?.candidate_cycles ?? null;
  }

  operations.push(rec);
  applyExpectations(op, rec);
}

store.save();

const final = {
  intents_count: Object.keys(store.state.intents ?? {}).length,
  proposals_count: Object.keys(store.state.proposals ?? {}).length,
  marketplace_matching_runs_count: Object.keys(store.state.marketplace_matching_runs ?? {}).length,
  marketplace_matching_proposal_runs_count: Object.keys(store.state.marketplace_matching_proposal_runs ?? {}).length,
  marketplace_matching_run_counter: Number(store.state.marketplace_matching_run_counter ?? 0),
  idempotency_keys_count: Object.keys(store.state.idempotency ?? {}).length
};

const out = canonicalize({ operations, final });
writeFileSync(path.join(outDir, OUTPUT_FILE), JSON.stringify(out, null, 2));

const outHash = sha256HexCanonical(out);
const assertions = {
  milestone: MILESTONE,
  expected_sha256: expected.expected_sha256,
  actual_sha256: outHash,
  matched: outHash === expected.expected_sha256,
  operations_count: operations.length,
  final
};
writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify(assertions, null, 2));

if (!assertions.matched) {
  console.error(JSON.stringify(assertions, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(assertions, null, 2));
