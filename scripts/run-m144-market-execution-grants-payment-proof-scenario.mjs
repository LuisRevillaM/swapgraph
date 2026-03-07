import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { JsonStateStore } from '../src/store/jsonStateStore.mjs';
import { MarketService } from '../src/service/marketService.mjs';
import { MarketDealService } from '../src/service/marketDealService.mjs';
import { MarketExecutionGrantService } from '../src/service/marketExecutionGrantService.mjs';
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
for (const file of readdirSync(schemasDir).filter(f => f.endsWith('.schema.json'))) ajv.addSchema(JSON.parse(readFileSync(path.join(schemasDir, file), 'utf8')));
const endpointsByOp = new Map((apiManifest.endpoints ?? []).map(ep => [ep.operation_id, ep]));
function validate(opId, response) {
  const endpoint = endpointsByOp.get(opId);
  const schemaFile = response.ok ? endpoint.response_schema : 'ErrorResponse.schema.json';
  const schema = JSON.parse(readFileSync(path.join(schemasDir, schemaFile), 'utf8'));
  const fn = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  if (!fn(response.body)) throw new Error(`${opId} schema fail ${JSON.stringify(fn.errors)}`);
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
store.state.market_payment_proofs = {};
store.state.market_payment_proof_counter = 0;
store.state.market_execution_grants = {};
store.state.market_execution_grant_counter = 0;
store.state.idempotency = {};
store.state.receipts = {};

const market = new MarketService({ store });
const deals = new MarketDealService({ store });
const grants = new MarketExecutionGrantService({ store });
const buyer = { type: 'user', id: 'm144_buyer' };
const seller = { type: 'user', id: 'm144_seller' };
const agent = { type: 'agent', id: 'm144_agent' };
const auth = { scopes: ['market:read', 'market:write', 'payment_proofs:write', 'receipts:read', 'execution_grants:write', 'execution_grants:consume'] };

const listing = market.createListing({ actor: seller, auth, idempotencyKey: 'm144-l1', request: { listing: { workspace_id: 'm144', kind: 'post', title: 'Seller post', offer: [{ asset: 'service' }] }, recorded_at: '2026-03-07T18:00:00.000Z' } });
const want = market.createListing({ actor: buyer, auth, idempotencyKey: 'm144-l2', request: { listing: { workspace_id: 'm144', kind: 'want', title: 'Buyer want' }, recorded_at: '2026-03-07T18:00:01.000Z' } });
const edge = market.createEdge({ actor: buyer, auth, idempotencyKey: 'm144-e1', request: { edge: { source_ref: { kind: 'listing', id: want.result.body.listing.listing_id }, target_ref: { kind: 'listing', id: listing.result.body.listing.listing_id }, edge_type: 'offer' }, recorded_at: '2026-03-07T18:00:02.000Z' } });
const accepted = market.acceptEdge({ actor: seller, auth, edgeId: edge.result.body.edge.edge_id, idempotencyKey: 'm144-e2', request: { recorded_at: '2026-03-07T18:00:03.000Z' } });
validate('marketEdges.accept', accepted.result);
const deal = deals.createFromEdge({ actor: buyer, auth, edgeId: edge.result.body.edge.edge_id, idempotencyKey: 'm144-d1', request: { recorded_at: '2026-03-07T18:00:04.000Z' } });
validate('marketDeals.createFromEdge', deal.result);
const dealId = deal.result.body.deal.deal_id;
const start = deals.startSettlement({ actor: buyer, auth, dealId, idempotencyKey: 'm144-d2', request: { settlement_mode: 'external_payment_proof', recorded_at: '2026-03-07T18:00:05.000Z' } });
validate('marketDeals.startSettlement', start.result);
const proof1 = deals.attachPaymentProof({ actor: buyer, auth, dealId, idempotencyKey: 'm144-p1', request: { payment_proof: { payment_rail: 'bank', proof_fingerprint: 'm144-proof-fp', attestation_role: 'payer', external_reference: 'wire-1' }, recorded_at: '2026-03-07T18:00:06.000Z' } });
validate('marketDeals.attachPaymentProof', proof1.result);
const failBeforeSecondAttestation = deals.complete({ actor: seller, auth, dealId, idempotencyKey: 'm144-d3', request: { recorded_at: '2026-03-07T18:00:07.000Z' } });
validate('marketDeals.complete', failBeforeSecondAttestation.result);
assert.equal(failBeforeSecondAttestation.result.ok, false);
assert.equal(failBeforeSecondAttestation.result.body.error.details.reason_code, 'market_payment_proof_unattested');
const proof2 = deals.attachPaymentProof({ actor: seller, auth, dealId, idempotencyKey: 'm144-p2', request: { payment_proof: { payment_rail: 'bank', proof_fingerprint: 'm144-proof-fp', attestation_role: 'payee', external_reference: 'wire-1' }, recorded_at: '2026-03-07T18:00:08.000Z' } });
validate('marketDeals.attachPaymentProof', proof2.result);
const completed = deals.complete({ actor: seller, auth, dealId, idempotencyKey: 'm144-d4', request: { recorded_at: '2026-03-07T18:00:09.000Z' } });
validate('marketDeals.complete', completed.result);
assert.equal(completed.result.ok, true);
const replayedProof = deals.complete({ actor: seller, auth, dealId, idempotencyKey: 'm144-d5', request: { recorded_at: '2026-03-07T18:00:10.000Z' } });
validate('marketDeals.complete', replayedProof.result);
assert.equal(replayedProof.result.ok, false);
assert.equal(replayedProof.result.body.error.details.reason_code, 'market_deal_status_invalid');

const grant = grants.create({ actor: buyer, auth, idempotencyKey: 'm144-g1', request: { grant: { audience: agent, scope: ['execute:deliver'], grant_mode: 'encrypted_envelope', ciphertext: 'cipher' }, recorded_at: '2026-03-07T18:00:11.000Z' } });
validate('marketExecutionGrants.create', grant.result);
const grantId = grant.result.body.grant.grant_id;
store.state.delegations.m144_agent_delegation = {
  delegation_id: 'm144_agent_delegation',
  principal_agent: agent,
  subject_actor: buyer,
  scopes: ['execution_grants:consume'],
  policy: {
    max_value_per_swap_usd: 100,
    max_value_per_day_usd: 1000,
    min_confidence_score: 0,
    max_cycle_length: 4,
    require_escrow: false,
    quiet_hours: { start: '00:00', end: '00:00', tz: 'UTC' }
  },
  issued_at: '2026-03-07T18:00:11.500Z',
  expires_at: '2026-03-07T19:00:00.000Z'
};
const delegatedAgentAuth = { now_iso: '2026-03-07T18:00:12.000Z', delegation: store.state.delegations.m144_agent_delegation };
const grantConsume = grants.consume({ actor: agent, auth: delegatedAgentAuth, grantId, idempotencyKey: 'm144-g2', request: { required_scope: 'execute:deliver', recorded_at: '2026-03-07T18:00:12.000Z' } });
validate('marketExecutionGrants.consume', grantConsume.result);
assert.equal(grantConsume.result.ok, true);
const grantReplay = grants.consume({ actor: agent, auth: { ...delegatedAgentAuth, now_iso: '2026-03-07T18:00:13.000Z' }, grantId, idempotencyKey: 'm144-g3', request: { required_scope: 'execute:deliver', recorded_at: '2026-03-07T18:00:13.000Z' } });
validate('marketExecutionGrants.consume', grantReplay.result);
assert.equal(grantReplay.result.ok, false);
assert.equal(grantReplay.result.body.error.details.reason_code, 'market_execution_grant_replayed');

const grantScopeMismatch = grants.create({ actor: buyer, auth, idempotencyKey: 'm144-g4', request: { grant: { audience: agent, scope: ['execute:inspect'], grant_mode: 'token' }, recorded_at: '2026-03-07T18:00:14.000Z' } });
validate('marketExecutionGrants.create', grantScopeMismatch.result);
const mismatchConsume = grants.consume({ actor: agent, auth: { ...delegatedAgentAuth, now_iso: '2026-03-07T18:00:15.000Z' }, grantId: grantScopeMismatch.result.body.grant.grant_id, idempotencyKey: 'm144-g5', request: { required_scope: 'execute:deliver', recorded_at: '2026-03-07T18:00:15.000Z' } });
validate('marketExecutionGrants.consume', mismatchConsume.result);
assert.equal(mismatchConsume.result.ok, false);
assert.equal(mismatchConsume.result.body.error.details.reason_code, 'market_execution_grant_scope_invalid');

const output = canonicalize({
  deal_id: dealId,
  payment_proof_id: proof1.result.body.payment_proof.proof_id,
  deal_status: completed.result.body.deal.status,
  grant_id: grantId,
  grant_replay_reason: grantReplay.result.body.error.details.reason_code,
  grant_scope_reason: mismatchConsume.result.body.error.details.reason_code
});
writeFileSync(path.join(outDir, 'market_execution_grants_payment_proof_output.json'), JSON.stringify(output, null, 2));
writeFileSync(path.join(outDir, 'assertions.json'), JSON.stringify({ ok: true, milestone: 'M144', output }, null, 2));
store.save();
console.log(JSON.stringify({ ok: true, milestone: 'M144', output }, null, 2));
