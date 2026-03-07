import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { MarketService } from '../src/service/marketService.mjs';
import { MarketDealService } from '../src/service/marketDealService.mjs';
import { canonicalize } from '../src/util/canonicalJson.mjs';

const outDir = process.env.OUT_DIR;
if (!outDir) {
  console.error('Missing OUT_DIR env');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const root = process.cwd();
const schemasDir = path.join(root, 'docs/spec/schemas');
const apiManifest = JSON.parse(readFileSync(path.join(root, 'docs/spec/api/manifest.v1.json'), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
for (const file of readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'))) {
  ajv.addSchema(JSON.parse(readFileSync(path.join(schemasDir, file), 'utf8')));
}
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(ep => [ep.operation_id, ep]));

function validate(opId, response) {
  const endpoint = endpointsByOp.get(opId);
  if (!endpoint) throw new Error(`missing endpoint ${opId}`);
  const schemaFile = response.ok ? endpoint.response_schema : 'ErrorResponse.schema.json';
  const schema = JSON.parse(readFileSync(path.join(schemasDir, schemaFile), 'utf8'));
  const fn = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  const ok = fn(response.body);
  if (!ok) throw new Error(`schema validation failed for ${opId}: ${JSON.stringify(fn.errors)}`);
}

const store = new JsonStateStore({ filePath: path.join(outDir, 'store.json') });
store.load();
store.state.market_listings = {};
store.state.market_listing_counter = 0;
store.state.market_edges = {};
store.state.market_edge_counter = 0;
store.state.market_threads = {};
store.state.market_thread_counter = 0;
store.state.market_messages = {};
store.state.market_message_counter = 0;
store.state.market_deals = {};
store.state.market_deal_counter = 0;
store.state.idempotency = {};
store.state.receipts = {};

const market = new MarketService({ store });
const deals = new MarketDealService({ store });
const seller = { type: 'user', id: 'm142_seller' };
const buyer = { type: 'user', id: 'm142_buyer' };
const auth = { scopes: ['market:read', 'market:write', 'receipts:read'] };

const sellerListing = market.createListing({
  actor: seller,
  auth,
  idempotencyKey: 'm142-l1',
  request: {
    listing: {
      workspace_id: 'm142',
      kind: 'post',
      title: 'Offer design review',
      offer: [{ asset: 'design_review' }],
      constraints: { latency_hours: 24 }
    },
    recorded_at: '2026-03-07T16:00:00.000Z'
  }
});
validate('marketListings.create', sellerListing.result);
assert.equal(sellerListing.result.ok, true);

const buyerWant = market.createListing({
  actor: buyer,
  auth,
  idempotencyKey: 'm142-l2',
  request: {
    listing: {
      workspace_id: 'm142',
      kind: 'want',
      title: 'Need design review',
      want_spec: { deliverable: 'annotated_pdf' },
      budget: { amount: 20, currency: 'USD' }
    },
    recorded_at: '2026-03-07T16:00:01.000Z'
  }
});
validate('marketListings.create', buyerWant.result);
assert.equal(buyerWant.result.ok, true);

const edge = market.createEdge({
  actor: buyer,
  auth,
  idempotencyKey: 'm142-e1',
  request: {
    edge: {
      source_ref: { kind: 'listing', id: buyerWant.result.body.listing.listing_id },
      target_ref: { kind: 'listing', id: sellerListing.result.body.listing.listing_id },
      edge_type: 'offer',
      terms_patch: { credit_amount: 20, currency: 'USD' }
    },
    recorded_at: '2026-03-07T16:00:02.000Z'
  }
});
validate('marketEdges.create', edge.result);
assert.equal(edge.result.ok, true);

const accepted = market.acceptEdge({
  actor: seller,
  auth,
  edgeId: edge.result.body.edge.edge_id,
  idempotencyKey: 'm142-e2',
  request: { recorded_at: '2026-03-07T16:00:03.000Z' }
});
validate('marketEdges.accept', accepted.result);
assert.equal(accepted.result.ok, true);

const deal = deals.createFromEdge({
  actor: buyer,
  auth,
  edgeId: edge.result.body.edge.edge_id,
  idempotencyKey: 'm142-d1',
  request: { recorded_at: '2026-03-07T16:00:04.000Z' }
});
validate('marketDeals.createFromEdge', deal.result);
assert.equal(deal.result.ok, true);
assert.equal(deal.result.body.deal.status, 'ready_for_settlement');

const dealGet = deals.get({ actor: seller, auth, dealId: deal.result.body.deal.deal_id });
validate('marketDeals.get', dealGet);
assert.equal(dealGet.ok, true);

const threadId = deal.result.body.deal.thread_id;
assert.ok(threadId);
const message = market.createThreadMessage({
  actor: buyer,
  auth,
  threadId,
  idempotencyKey: 'm142-m1',
  request: {
    message: {
      message_type: 'terms_patch',
      payload: {
        text: 'Can deliver tonight',
        delivery_eta: '2026-03-07T23:00:00.000Z'
      }
    },
    recorded_at: '2026-03-07T16:00:05.000Z'
  }
});
validate('marketThreadMessages.create', message.result);
assert.equal(message.result.ok, true);

const messages = market.listThreadMessages({ actor: seller, auth, threadId, query: {} });
validate('marketThreadMessages.list', messages);
assert.equal(messages.ok, true);
assert.ok(messages.body.messages.length >= 2, 'expected system + user messages');

const output = canonicalize({
  deal_id: deal.result.body.deal.deal_id,
  thread_id: threadId,
  message_count: messages.body.messages.length,
  final_status: dealGet.body.deal.status,
  listing_count: Object.keys(store.state.market_listings).length,
  edge_count: Object.keys(store.state.market_edges).length,
  deal_count: Object.keys(store.state.market_deals).length
});
writeFileSync(path.join(outDir, 'market_deals_threads_output.json'), JSON.stringify(output, null, 2));
writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ ok: true, milestone: 'M142', output }, null, 2));
store.save();
console.log(JSON.stringify({ ok: true, milestone: 'M142', output }, null, 2));
