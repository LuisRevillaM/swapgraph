import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { MarketService } from '../src/service/marketService.mjs';
import { canonicalize, canonicalStringify } from '../src/util/canonicalJson.mjs';

const MILESTONE = 'M140';
const SCENARIO_FILE = 'fixtures/release/m140_scenario.json';
const EXPECTED_FILE = 'fixtures/release/m140_expected.json';
const OUTPUT_FILE = 'market_listing_edge_feed_output.json';

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

const market = new MarketService({ store });
const operations = [];

for (const op of scenario.operations ?? []) {
  const actor = op.actor_ref ? actors?.[op.actor_ref] : null;
  if (op.actor_ref && !actor) throw new Error(`unknown actor_ref: ${op.actor_ref}`);
  const auth = op.auth ?? {};

  let response;
  let replayed = null;

  if (op.op === 'marketListings.create') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = market.createListing({ actor, auth, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'marketListings.patch') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = market.patchListing({ actor, auth, listingId: op.listing_id, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'marketListings.pause') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = market.pauseListing({ actor, auth, listingId: op.listing_id, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'marketListings.close') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = market.closeListing({ actor, auth, listingId: op.listing_id, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'marketListings.get') {
    response = market.getListing({ actor, auth, listingId: op.listing_id });
  } else if (op.op === 'marketListings.list') {
    response = market.listListings({ actor, auth, query: clone(op.query ?? {}) });
  } else if (op.op === 'marketEdges.create') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = market.createEdge({ actor, auth, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'marketEdges.accept') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = market.acceptEdge({ actor, auth, edgeId: op.edge_id, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'marketEdges.decline') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = market.declineEdge({ actor, auth, edgeId: op.edge_id, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'marketEdges.withdraw') {
    const request = clone(op.request ?? {});
    if (!op.skip_request_validation) validateApiRequest(op.op, request);
    const out = market.withdrawEdge({ actor, auth, edgeId: op.edge_id, idempotencyKey: op.idempotency_key, request });
    replayed = out.replayed;
    response = out.result;
  } else if (op.op === 'marketEdges.get') {
    response = market.getEdge({ actor, auth, edgeId: op.edge_id });
  } else if (op.op === 'marketEdges.list') {
    response = market.listEdges({ actor, auth, query: clone(op.query ?? {}) });
  } else if (op.op === 'marketFeed.get') {
    response = market.getFeed({ actor, auth, query: clone(op.query ?? {}) });
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

  if (response.ok && response.body.listing) {
    rec.listing_id = response.body.listing.listing_id ?? null;
    rec.listing_status = response.body.listing.status ?? null;
    rec.listing_kind = response.body.listing.kind ?? null;
  }

  if (response.ok && response.body.edge) {
    rec.edge_id = response.body.edge.edge_id ?? null;
    rec.edge_status = response.body.edge.status ?? null;
    rec.edge_type = response.body.edge.edge_type ?? null;
  }

  if (response.ok && Array.isArray(response.body.listings)) {
    rec.total = Number(response.body.total ?? response.body.listings.length);
    rec.next_cursor = response.body.next_cursor ?? null;
    rec.first_listing_id = response.body.listings?.[0]?.listing_id ?? null;
  }

  if (response.ok && Array.isArray(response.body.edges)) {
    rec.total = Number(response.body.total ?? response.body.edges.length);
    rec.next_cursor = response.body.next_cursor ?? null;
    rec.first_edge_id = response.body.edges?.[0]?.edge_id ?? null;
  }

  if (response.ok && Array.isArray(response.body.items)) {
    rec.items_count = response.body.items.length;
    rec.next_cursor = response.body.next_cursor ?? null;
    rec.first_item_type = response.body.items?.[0]?.item_type ?? null;
    rec.first_item_id = response.body.items?.[0]?.item_id ?? null;
  }

  operations.push(rec);
  applyExpectations(op, rec);
}

store.save();

const final = {
  market_listings_count: Object.keys(store.state.market_listings ?? {}).length,
  market_edges_count: Object.keys(store.state.market_edges ?? {}).length,
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
