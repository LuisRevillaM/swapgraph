import test from 'node:test';
import assert from 'node:assert/strict';

import { JsonStateStore } from '../../src/store/jsonStateStore.mjs';
import { MarketService } from '../../src/service/marketService.mjs';
import { MarketDealService } from '../../src/service/marketDealService.mjs';

function createStore() {
  return new JsonStateStore({
    filePath: `/tmp/swapgraph-market-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  });
}

function marketAuth(scopes = ['market:write', 'market:read', 'receipts:read']) {
  return {
    scopes,
    now_iso: '2026-03-07T12:00:00.000Z',
    client_fingerprint: 'test-client'
  };
}

function createListing(service, { actor, auth, listingId, title, kind = 'want', workspaceId = 'open_market', description = 'test listing', extra = {} }) {
  return service.createListing({
    actor,
    auth,
    idempotencyKey: `idem_${listingId}`,
    request: {
      recorded_at: auth.now_iso,
      listing: {
        listing_id: listingId,
        workspace_id: workspaceId,
        kind,
        title,
        description,
        ...(kind === 'want'
          ? { want_spec: { summary: description } }
          : kind === 'post'
            ? { offer: [{ label: title }] }
            : {
              capability_profile: {
                deliverable_schema: { summary: description },
                rate_card: { usd: 100 }
              }
            }),
        ...extra
      }
    }
  }).result;
}

function acceptEdge(service, { actor, auth, edgeId }) {
  return service.acceptEdge({
    actor,
    auth,
    edgeId,
    idempotencyKey: `accept_${edgeId}`,
    request: { recorded_at: auth.now_iso }
  }).result;
}

test.beforeEach(() => {
  process.env.AUTHZ_ENFORCE = '1';
  delete process.env.MARKET_SIGNUP_RATE_LIMIT_PER_HOUR;
  delete process.env.MARKET_LISTING_RATE_LIMIT_PER_HOUR;
  delete process.env.MARKET_EDGE_RATE_LIMIT_PER_HOUR;
  delete process.env.MARKET_DEAL_RATE_LIMIT_PER_HOUR;
});

test('market signup is rate-limited per client fingerprint', () => {
  process.env.MARKET_SIGNUP_RATE_LIMIT_PER_HOUR = '2';
  const store = createStore();
  const market = new MarketService({ store });

  const first = market.signup({
    actor: null,
    auth: { client_fingerprint: 'client-a', now_iso: '2026-03-07T12:00:00.000Z' },
    idempotencyKey: 'signup_1',
    request: { display_name: 'Alpha', recorded_at: '2026-03-07T12:00:00.000Z' }
  }).result;
  const second = market.signup({
    actor: null,
    auth: { client_fingerprint: 'client-a', now_iso: '2026-03-07T12:10:00.000Z' },
    idempotencyKey: 'signup_2',
    request: { display_name: 'Beta', recorded_at: '2026-03-07T12:10:00.000Z' }
  }).result;
  const third = market.signup({
    actor: null,
    auth: { client_fingerprint: 'client-a', now_iso: '2026-03-07T12:20:00.000Z' },
    idempotencyKey: 'signup_3',
    request: { display_name: 'Gamma', recorded_at: '2026-03-07T12:20:00.000Z' }
  }).result;

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, false);
  assert.equal(third.body.error.details.reason_code, 'market_signup_rate_limited');
});

test('listing creation is rate-limited and suspicious listings enter moderation queue', () => {
  process.env.MARKET_LISTING_RATE_LIMIT_PER_HOUR = '2';
  const store = createStore();
  const market = new MarketService({ store });
  const actor = { type: 'user', id: 'owner_alpha' };
  const auth = marketAuth();

  const suspicious = createListing(market, {
    actor,
    auth,
    listingId: 'listing_a',
    title: 'Fast agent help',
    description: 'DM me on telegram or visit https://one.example and https://two.example',
    kind: 'want'
  });
  const second = createListing(market, {
    actor,
    auth: { ...auth, now_iso: '2026-03-07T12:15:00.000Z' },
    listingId: 'listing_b',
    title: 'Need benchmark run',
    description: 'Need a benchmark',
    kind: 'want'
  });
  const third = createListing(market, {
    actor,
    auth: { ...auth, now_iso: '2026-03-07T12:30:00.000Z' },
    listingId: 'listing_c',
    title: 'Need audit',
    description: 'Need a route audit',
    kind: 'want'
  });

  assert.equal(suspicious.ok, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, false);
  assert.equal(third.body.error.details.reason_code, 'market_listing_rate_limited');
  const moderationEntries = Object.values(store.state.market_moderation_queue);
  assert.equal(moderationEntries.length, 1);
  assert.deepEqual(moderationEntries[0].reason_codes.sort(), ['listing_many_urls', 'listing_offplatform_contact']);
  const trust = market.getTrustProfile({ actor, auth });
  assert.equal(trust.ok, true);
  assert.equal(trust.body.moderation_items.length, 1);
});

test('deal creation is rate-limited per actor', () => {
  process.env.MARKET_DEAL_RATE_LIMIT_PER_HOUR = '1';
  const store = createStore();
  const market = new MarketService({ store });
  const deals = new MarketDealService({ store });
  const actorA = { type: 'user', id: 'owner_a' };
  const actorB = { type: 'user', id: 'owner_b' };
  const authA = marketAuth();
  const authB = marketAuth();

  assert.equal(createListing(market, { actor: actorA, auth: authA, listingId: 'post_a1', title: 'Asset A1', kind: 'post' }).ok, true);
  assert.equal(createListing(market, { actor: actorA, auth: authA, listingId: 'post_a2', title: 'Asset A2', kind: 'post' }).ok, true);
  assert.equal(createListing(market, { actor: actorB, auth: authB, listingId: 'want_b1', title: 'Want B1', kind: 'want' }).ok, true);
  assert.equal(createListing(market, { actor: actorB, auth: authB, listingId: 'want_b2', title: 'Want B2', kind: 'want' }).ok, true);

  const edge1 = market.createEdge({
    actor: actorA,
    auth: authA,
    idempotencyKey: 'edge_1',
    request: {
      recorded_at: authA.now_iso,
      edge: {
        edge_id: 'edge_1',
        source_ref: { kind: 'listing', id: 'post_a1' },
        target_ref: { kind: 'listing', id: 'want_b1' },
        edge_type: 'offer'
      }
    }
  }).result;
  const edge2 = market.createEdge({
    actor: actorA,
    auth: { ...authA, now_iso: '2026-03-07T12:05:00.000Z' },
    idempotencyKey: 'edge_2',
    request: {
      recorded_at: '2026-03-07T12:05:00.000Z',
      edge: {
        edge_id: 'edge_2',
        source_ref: { kind: 'listing', id: 'post_a2' },
        target_ref: { kind: 'listing', id: 'want_b2' },
        edge_type: 'offer'
      }
    }
  }).result;
  assert.equal(edge1.ok, true);
  assert.equal(edge2.ok, true);
  assert.equal(acceptEdge(market, { actor: actorB, auth: authB, edgeId: 'edge_1' }).ok, true);
  assert.equal(acceptEdge(market, { actor: actorB, auth: { ...authB, now_iso: '2026-03-07T12:06:00.000Z' }, edgeId: 'edge_2' }).ok, true);

  const firstDeal = deals.createFromEdge({
    actor: actorA,
    auth: authA,
    edgeId: 'edge_1',
    idempotencyKey: 'deal_1',
    request: { recorded_at: authA.now_iso }
  }).result;
  const secondDeal = deals.createFromEdge({
    actor: actorA,
    auth: { ...authA, now_iso: '2026-03-07T12:10:00.000Z' },
    edgeId: 'edge_2',
    idempotencyKey: 'deal_2',
    request: { recorded_at: '2026-03-07T12:10:00.000Z' }
  }).result;

  assert.equal(firstDeal.ok, true);
  assert.equal(secondDeal.ok, false);
  assert.equal(secondDeal.body.error.details.reason_code, 'market_deal_rate_limited');
});

test('completed public deals expose anonymous receipt reads', () => {
  const store = createStore();
  const market = new MarketService({ store });
  const deals = new MarketDealService({ store });
  const actorA = { type: 'user', id: 'buyer_a' };
  const actorB = { type: 'user', id: 'seller_b' };
  const authA = marketAuth();
  const authB = marketAuth();

  assert.equal(createListing(market, { actor: actorA, auth: authA, listingId: 'buyer_post', title: 'Buyer credits', kind: 'post' }).ok, true);
  assert.equal(createListing(market, { actor: actorB, auth: authB, listingId: 'seller_want', title: 'Seller wants credits', kind: 'want' }).ok, true);

  const edge = market.createEdge({
    actor: actorA,
    auth: authA,
    idempotencyKey: 'receipt_edge',
    request: {
      recorded_at: authA.now_iso,
      edge: {
        edge_id: 'receipt_edge',
        source_ref: { kind: 'listing', id: 'buyer_post' },
        target_ref: { kind: 'listing', id: 'seller_want' },
        edge_type: 'offer',
        terms_patch: { credit_amount: 10 }
      }
    }
  }).result;
  assert.equal(edge.ok, true);
  assert.equal(acceptEdge(market, { actor: actorB, auth: authB, edgeId: 'receipt_edge' }).ok, true);

  const deal = deals.createFromEdge({
    actor: actorA,
    auth: authA,
    edgeId: 'receipt_edge',
    idempotencyKey: 'receipt_deal',
    request: { recorded_at: authA.now_iso }
  }).result;
  assert.equal(deal.ok, true);
  assert.equal(deals.startSettlement({
    actor: actorA,
    auth: authA,
    dealId: deal.body.deal.deal_id,
    idempotencyKey: 'receipt_start',
    request: {
      recorded_at: authA.now_iso,
      settlement_mode: 'internal_credit',
      terms: { credit_amount: 10 }
    }
  }).result.ok, true);
  assert.equal(deals.complete({
    actor: actorA,
    auth: authA,
    dealId: deal.body.deal.deal_id,
    idempotencyKey: 'receipt_complete',
    request: { recorded_at: authA.now_iso }
  }).result.ok, true);

  const receipt = deals.receipt({
    actor: null,
    auth: { client_fingerprint: 'anon-viewer' },
    dealId: deal.body.deal.deal_id
  });
  assert.equal(receipt.ok, true);
  assert.match(receipt.body.receipt.id, /^receipt_/);
});

test('moderator can resolve moderation item, block actor, and future writes are denied', () => {
  const store = createStore();
  const market = new MarketService({ store });
  const actor = { type: 'user', id: 'owner_watchlist' };
  const auth = marketAuth();

  const suspicious = createListing(market, {
    actor,
    auth,
    listingId: 'listing_block_me',
    title: 'Fast offplatform deal',
    description: 'dm me on telegram with https://one.example and https://two.example',
    kind: 'want'
  });
  assert.equal(suspicious.ok, true);
  const moderationId = Object.keys(store.state.market_moderation_queue)[0];
  assert.ok(moderationId);

  const moderator = { type: 'user', id: 'market_operator' };
  const moderated = market.resolveModerationItem({
    actor: moderator,
    auth: { scopes: ['market:moderate', 'market:write'], now_iso: '2026-03-07T13:00:00.000Z' },
    moderationId,
    idempotencyKey: 'moderation_block',
    request: {
      action: 'set_blocked',
      recorded_at: '2026-03-07T13:00:00.000Z',
      note: 'spam probe'
    }
  }).result;

  assert.equal(moderated.ok, true);
  assert.equal(moderated.body.moderation.resolution.action, 'set_blocked');
  assert.equal(store.state.market_actor_quotas['user:owner_watchlist'].trust_tier, 'blocked');

  const denied = createListing(market, {
    actor,
    auth: { ...auth, now_iso: '2026-03-07T13:10:00.000Z' },
    listingId: 'listing_after_block',
    title: 'Should fail',
    description: 'blocked actor write',
    kind: 'want'
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.body.error.details.reason_code, 'market_actor_blocked');
});

test('moderator scope can list the full moderation queue', () => {
  const store = createStore();
  const market = new MarketService({ store });

  assert.equal(createListing(market, {
    actor: { type: 'user', id: 'owner_one' },
    auth: marketAuth(),
    listingId: 'listing_one',
    title: 'Need growth',
    description: 'DM me on telegram or visit https://one.example and https://two.example',
    kind: 'want'
  }).ok, true);

  assert.equal(createListing(market, {
    actor: { type: 'user', id: 'owner_two' },
    auth: marketAuth(),
    listingId: 'listing_two',
    title: 'Need audit',
    description: 'DM me on telegram or visit https://three.example and https://four.example',
    kind: 'want'
  }).ok, true);

  const moderator = market.listModerationQueue({
    actor: { type: 'user', id: 'ops_moderator' },
    auth: {
      scopes: ['market:read', 'market:write', 'market:moderate'],
      now_iso: '2026-03-07T12:00:00.000Z',
      client_fingerprint: 'mod-client'
    },
    query: {}
  });

  assert.equal(moderator.ok, true);
  assert.equal(moderator.body.actor_scope, 'moderator');
  assert.equal(moderator.body.total, 2);
  assert.deepEqual(
    moderator.body.moderation_items.map(item => item.actor.id).sort(),
    ['owner_one', 'owner_two']
  );
});
