import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { MarketService } from '../src/service/marketService.mjs';
import { MarketDealService } from '../src/service/marketDealService.mjs';
import { signReceipt } from '../src/crypto/receiptSigning.mjs';
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
  const schemaFile = response.ok ? endpoint.response_schema : 'ErrorResponse.schema.json';
  const schema = JSON.parse(readFileSync(path.join(schemasDir, schemaFile), 'utf8'));
  const fn = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  if (!fn(response.body)) throw new Error(`${opId} schema fail ${JSON.stringify(fn.errors)}`);
}
function auth() { return { scopes: ['market:read', 'market:write', 'receipts:read'] }; }
function actor(id) { return { type: 'user', id }; }
function blankStore() {
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
  store.state.market_payment_proofs = {};
  store.state.market_payment_proof_counter = 0;
  store.state.idempotency = {};
  store.state.receipts = {};
  store.state.market_actor_quotas = {};
  return store;
}
function createDeal({ market, deals, buyerId, sellerId, workspace, prefix, amount }) {
  const buyer = actor(buyerId);
  const seller = actor(sellerId);
  const listing = market.createListing({ actor: seller, auth: auth(), idempotencyKey: `${prefix}-l1`, request: { listing: { workspace_id: workspace, kind: 'post', title: `post-${prefix}`, offer: [{ asset: prefix }] }, recorded_at: '2026-03-07T17:00:00.000Z' } });
  const want = market.createListing({ actor: buyer, auth: auth(), idempotencyKey: `${prefix}-l2`, request: { listing: { workspace_id: workspace, kind: 'want', title: `want-${prefix}` }, recorded_at: '2026-03-07T17:00:01.000Z' } });
  const edge = market.createEdge({ actor: buyer, auth: auth(), idempotencyKey: `${prefix}-e1`, request: { edge: { source_ref: { kind: 'listing', id: want.result.body.listing.listing_id }, target_ref: { kind: 'listing', id: listing.result.body.listing.listing_id }, edge_type: 'offer', terms_patch: { credit_amount: amount } }, recorded_at: '2026-03-07T17:00:02.000Z' } });
  const accepted = market.acceptEdge({ actor: seller, auth: auth(), edgeId: edge.result.body.edge.edge_id, idempotencyKey: `${prefix}-e2`, request: { recorded_at: '2026-03-07T17:00:03.000Z' } });
  validate('marketEdges.accept', accepted.result);
  const deal = deals.createFromEdge({ actor: buyer, auth: auth(), edgeId: edge.result.body.edge.edge_id, idempotencyKey: `${prefix}-d1`, request: { recorded_at: '2026-03-07T17:00:04.000Z' } });
  validate('marketDeals.createFromEdge', deal.result);
  return { buyer, seller, dealId: deal.result.body.deal.deal_id };
}

const store = blankStore();
const market = new MarketService({ store });
const deals = new MarketDealService({ store });

const direct = createDeal({ market, deals, buyerId: 'm143_direct_buyer', sellerId: 'm143_direct_seller', workspace: 'm143_direct', prefix: 'direct', amount: 30 });
const directStart = deals.startSettlement({ actor: direct.buyer, auth: auth(), dealId: direct.dealId, idempotencyKey: 'm143-direct-start', request: { settlement_mode: 'internal_credit', terms: { credit_amount: 30 }, recorded_at: '2026-03-07T17:00:05.000Z' } });
validate('marketDeals.startSettlement', directStart.result);
const directComplete = deals.complete({ actor: direct.seller, auth: auth(), dealId: direct.dealId, idempotencyKey: 'm143-direct-complete', request: { recorded_at: '2026-03-07T17:00:06.000Z' } });
validate('marketDeals.complete', directComplete.result);
const directReceipt = deals.receipt({ actor: direct.buyer, auth: { scopes: ['receipts:read'] }, dealId: direct.dealId });
validate('marketDeals.receipt', directReceipt);

const bridge = createDeal({ market, deals, buyerId: 'm143_bridge_buyer', sellerId: 'm143_bridge_seller', workspace: 'm143_bridge', prefix: 'bridge', amount: 10 });
const seededReceipt = {
  id: 'receipt_cycle_bridge_demo',
  cycle_id: 'cycle_bridge_demo',
  final_state: 'completed',
  intent_ids: [],
  asset_ids: [],
  created_at: '2026-03-07T17:10:05.000Z',
  transparency: { seeded: true }
};
store.state.receipts.cycle_bridge_demo = { ...seededReceipt, signature: signReceipt(seededReceipt) };
const bridgeStart = deals.startSettlement({ actor: bridge.buyer, auth: auth(), dealId: bridge.dealId, idempotencyKey: 'm143-bridge-start', request: { settlement_mode: 'cycle_bridge', cycle_id: 'cycle_bridge_demo', recorded_at: '2026-03-07T17:10:00.000Z' } });
validate('marketDeals.startSettlement', bridgeStart.result);
const bridgeComplete = deals.complete({ actor: bridge.seller, auth: auth(), dealId: bridge.dealId, idempotencyKey: 'm143-bridge-complete', request: { recorded_at: '2026-03-07T17:10:06.000Z' } });
validate('marketDeals.complete', bridgeComplete.result);
const bridgeReceipt = deals.receipt({ actor: bridge.buyer, auth: { scopes: ['receipts:read'] }, dealId: bridge.dealId });
validate('marketDeals.receipt', bridgeReceipt);
assert.equal(bridgeReceipt.body.receipt.id, 'receipt_cycle_bridge_demo');

const output = canonicalize({
  direct: {
    deal_id: direct.dealId,
    receipt_id: directReceipt.body.receipt.id,
    status: directComplete.result.body.deal.status
  },
  cycle_bridge: {
    deal_id: bridge.dealId,
    receipt_id: bridgeReceipt.body.receipt.id,
    settlement_ref: bridgeStart.result.body.deal.settlement_ref,
    status: bridgeComplete.result.body.deal.status
  }
});
writeFileSync(path.join(outDir, 'market_settlement_bridge_output.json'), JSON.stringify(output, null, 2));
writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ ok: true, milestone: 'M143', output }, null, 2));
store.save();
console.log(JSON.stringify({ ok: true, milestone: 'M143', output }, null, 2));
