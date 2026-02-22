import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { LiquidityListingDecisionService } from '../src/service/liquidityListingDecisionService.mjs';
import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M106';
const SCENARIO_FILE = 'fixtures/release/m106_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m106_expected.json';
const OUTPUT_FILE = 'liquidity_listing_decision_output.json';

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

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function sha256HexCanonical(value) {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function reasonCodeFromError(body) {
  return body?.error?.details?.reason_code ?? null;
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

const eventsManifest = readJson(path.join(root, 'docs/spec/events/manifest.v1.json'));
const eventPayloadByType = new Map((eventsManifest.event_types ?? []).map(et => [et.type, et.payload_schema]));

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

function applyExpectations(op, rec) {
  for (const [k, v] of Object.entries(op)) {
    if (!k.startsWith('expect_')) continue;
    const field = k.slice('expect_'.length);
    assert.deepEqual(rec[field], v, `expectation_failed op=${op.op} field=${field}`);
  }
}

const scenario = readJson(path.join(root, SCENARIO_FILE));
const expected = readJson(path.join(root, EXPECTED_FILE));
const actors = scenario.actors ?? {};

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();
for (const [key, value] of Object.entries(scenario.seed_state ?? {})) {
  store.state[key] = clone(value);
}

store.state.idempotency ||= {};
store.state.liquidity_listings ||= {};
store.state.liquidity_decisions ||= {};
store.state.liquidity_decision_counter ||= 0;

const service = new LiquidityListingDecisionService({ store });

const operations = [];
const refs = new Map();

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);
  const auth = op.auth ?? {};
  const providerId = op.provider_id_ref ? refs.get(op.provider_id_ref) : op.provider_id;
  const proposalId = op.proposal_id_ref ? refs.get(op.proposal_id_ref) : op.proposal_id;
  const intentId = op.intent_id_ref ? refs.get(op.intent_id_ref) : op.intent_id;
  const decisionId = op.decision_id_ref ? refs.get(op.decision_id_ref) : op.decision_id;

  let response;
  let replayed = null;

  if (op.op === 'liquidityListings.upsert') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.upsertListing({ actor, auth, providerId, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'liquidityListings.cancel') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.cancelListing({ actor, auth, providerId, intentId, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'liquidityListings.list') {
    response = service.listListings({ actor, auth, providerId, query: clone(op.query ?? {}) });
  } else if (op.op === 'liquidityDecisions.proposal.accept') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.acceptProposalDecision({
      actor,
      auth,
      providerId,
      proposalId,
      idempotencyKey: op.idempotency_key,
      request
    });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'liquidityDecisions.proposal.decline') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = service.declineProposalDecision({
      actor,
      auth,
      providerId,
      proposalId,
      idempotencyKey: op.idempotency_key,
      request
    });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'liquidityDecisions.get') {
    response = service.getDecision({ actor, auth, providerId, decisionId });
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

  if ((op.op === 'liquidityListings.upsert' || op.op === 'liquidityListings.cancel') && response.ok) {
    rec.provider_id = response.body.provider_id ?? null;
    rec.intent_id = response.body.listing?.intent_id ?? null;
    rec.listing_status = response.body.listing?.status ?? null;
    rec.cancel_reason_code = response.body.listing?.cancel_reason_code ?? null;

    if (typeof op.save_provider_ref === 'string') refs.set(op.save_provider_ref, rec.provider_id);
    if (typeof op.save_intent_ref === 'string') refs.set(op.save_intent_ref, rec.intent_id);
  }

  if (op.op === 'liquidityListings.list' && response.ok) {
    const listings = response.body.listings ?? [];
    rec.provider_id = response.body.provider_id ?? null;
    rec.listings_count = listings.length;
    rec.active_count = listings.filter(row => row?.status === 'active').length;
    rec.cancelled_count = listings.filter(row => row?.status === 'cancelled').length;
    rec.first_intent_id = listings[0]?.intent_id ?? null;
  }

  if ((op.op === 'liquidityDecisions.proposal.accept' || op.op === 'liquidityDecisions.proposal.decline' || op.op === 'liquidityDecisions.get') && response.ok) {
    rec.provider_id = response.body.provider_id ?? null;
    rec.decision_id = response.body.decision?.decision_id ?? null;
    rec.decision = response.body.decision?.decision ?? null;
    rec.proposal_id = response.body.decision?.proposal_id ?? null;
    rec.intent_ids_count = response.body.decision?.intent_ids?.length ?? null;
    rec.commit_id = response.body.decision?.commit_id ?? null;
    rec.trust_safety_decision_id = response.body.decision?.trust_safety_decision_id ?? null;

    if ((op.op === 'liquidityDecisions.proposal.accept' || op.op === 'liquidityDecisions.proposal.decline') && typeof op.save_decision_ref === 'string') {
      refs.set(op.save_decision_ref, rec.decision_id);
    }
  }

  operations.push(rec);
  applyExpectations(op, rec);
}

const eventChecks = [];
for (const check of scenario.event_payload_checks ?? []) {
  const schemaFile = eventPayloadByType.get(check.type);
  if (!schemaFile) throw new Error(`unknown event type in check: ${check.type}`);
  const v = validateAgainstSchemaFile(schemaFile, check.payload ?? {});
  const rec = {
    type: check.type,
    schema: schemaFile,
    ok: v.ok,
    errors_count: v.errors?.length ?? 0
  };
  if (typeof check.expect_ok === 'boolean') {
    assert.equal(rec.ok, check.expect_ok, `event payload check failed for type=${check.type}`);
  }
  eventChecks.push(rec);
}

store.save();

const listingsCount = Object.values(store.state.liquidity_listings ?? {})
  .reduce((sum, rows) => sum + Object.keys(rows ?? {}).length, 0);

const final = {
  liquidity_listings_count: listingsCount,
  liquidity_decisions_count: Object.keys(store.state.liquidity_decisions ?? {}).length,
  idempotency_keys_count: Object.keys(store.state.idempotency ?? {}).length
};

const out = canonicalize({
  operations,
  event_checks: eventChecks,
  final
});

writeFileSync(path.join(outDir, OUTPUT_FILE), JSON.stringify(out, null, 2));

const outHash = sha256HexCanonical(out);
if (typeof expected?.expected_sha256 === 'string' && expected.expected_sha256.trim()) {
  assert.equal(outHash, expected.expected_sha256.trim());
} else {
  assert.deepEqual(out, expected);
}

writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ milestone: MILESTONE, status: 'pass' }, null, 2));
console.log(JSON.stringify({ ok: true, stats: { operations: operations.length, event_checks: eventChecks.length } }, null, 2));
