import test from 'node:test';
import assert from 'node:assert/strict';

import { JsonStateStore } from '../../src/store/jsonStateStore.mjs';
import { MarketService } from '../../src/service/marketService.mjs';
import { MarketBlueprintService } from '../../src/service/marketBlueprintService.mjs';
import { MarketCandidateService } from '../../src/service/marketCandidateService.mjs';

function createStore() {
  return new JsonStateStore({
    filePath: `/tmp/swapgraph-market-blueprints-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  });
}

function auth(scopes = ['market:read', 'market:write']) {
  return {
    scopes,
    now_iso: '2026-03-09T18:00:00.000Z',
    client_fingerprint: 'test-client'
  };
}

function actor(id) {
  return { type: 'user', id };
}

test('blueprints support draft publish archive lifecycle with public listing only after publish', () => {
  const store = createStore();
  const blueprints = new MarketBlueprintService({ store });
  const owner = actor('blueprint_owner');
  const ownerAuth = auth();

  const created = blueprints.create({
    actor: owner,
    auth: ownerAuth,
    idempotencyKey: 'bp-create-1',
    request: {
      recorded_at: ownerAuth.now_iso,
      blueprint: {
        blueprint_id: 'bp_skill_1',
        workspace_id: 'open_market',
        title: 'Render deploy skill pack',
        category: 'skill',
        artifact_ref: 'https://example.com/render-skill-pack.tgz',
        artifact_format: 'tarball',
        delivery_mode: 'download',
        pricing_model: 'one_time',
        valuation_hint: { usd_amount: 25 }
      }
    }
  }).result;

  assert.equal(created.ok, true);
  assert.equal(created.body.blueprint.status, 'draft');

  const anonDraftList = blueprints.list({ actor: null, auth: {}, query: { workspace_id: 'open_market' } });
  assert.equal(anonDraftList.ok, true);
  assert.equal(anonDraftList.body.blueprints.length, 0);

  const published = blueprints.publish({
    actor: owner,
    auth: ownerAuth,
    blueprintId: 'bp_skill_1',
    idempotencyKey: 'bp-publish-1',
    request: { recorded_at: ownerAuth.now_iso }
  }).result;
  assert.equal(published.ok, true);
  assert.equal(published.body.blueprint.status, 'published');

  const anonPublishedList = blueprints.list({ actor: null, auth: {}, query: { workspace_id: 'open_market' } });
  assert.equal(anonPublishedList.ok, true);
  assert.equal(anonPublishedList.body.blueprints.length, 1);
  assert.equal(anonPublishedList.body.blueprints[0].blueprint_id, 'bp_skill_1');

  const archived = blueprints.archive({
    actor: owner,
    auth: ownerAuth,
    blueprintId: 'bp_skill_1',
    idempotencyKey: 'bp-archive-1',
    request: { recorded_at: ownerAuth.now_iso }
  }).result;
  assert.equal(archived.ok, true);
  assert.equal(archived.body.blueprint.status, 'archived');

  const anonArchivedList = blueprints.list({ actor: null, auth: {}, query: { workspace_id: 'open_market' } });
  assert.equal(anonArchivedList.ok, true);
  assert.equal(anonArchivedList.body.blueprints.length, 0);
});

test('candidate compute finds mixed direct blueprint-for-cash opportunity and supports participant acceptance', () => {
  const store = createStore();
  const market = new MarketService({ store });
  const blueprints = new MarketBlueprintService({ store });
  const candidates = new MarketCandidateService({ store });
  const seller = actor('seller_blueprint');
  const buyer = actor('buyer_budget');
  const sellerAuth = auth();
  const buyerAuth = auth();

  const createdBlueprint = blueprints.create({
    actor: seller,
    auth: sellerAuth,
    idempotencyKey: 'bp-create-2',
    request: {
      recorded_at: sellerAuth.now_iso,
      blueprint: {
        blueprint_id: 'bp_skill_2',
        workspace_id: 'open_market',
        title: 'QA swarm blueprint',
        category: 'skill',
        artifact_ref: 'https://example.com/qa-swarm.tgz',
        artifact_format: 'tarball',
        delivery_mode: 'download',
        pricing_model: 'one_time',
        valuation_hint: { usd_amount: 25 }
      }
    }
  }).result;
  assert.equal(createdBlueprint.ok, true);
  assert.equal(blueprints.publish({
    actor: seller,
    auth: sellerAuth,
    blueprintId: 'bp_skill_2',
    idempotencyKey: 'bp-publish-2',
    request: { recorded_at: sellerAuth.now_iso }
  }).result.ok, true);

  const want = market.createListing({
    actor: buyer,
    auth: buyerAuth,
    idempotencyKey: 'listing-buyer-want',
    request: {
      recorded_at: buyerAuth.now_iso,
      listing: {
        listing_id: 'buyer_want_1',
        workspace_id: 'open_market',
        kind: 'want',
        title: 'Need a QA blueprint',
        want_spec: {
          type: 'set',
          any_of: [{ type: 'category', category: 'blueprint:skill' }]
        },
        budget: { amount: 25, currency: 'USD' }
      }
    }
  }).result;
  assert.equal(want.ok, true);

  const computed = candidates.compute({
    actor: buyer,
    auth: buyerAuth,
    idempotencyKey: 'cand-compute-1',
    request: {
      workspace_id: 'open_market',
      max_cycle_length: 3,
      max_candidates: 10,
      recorded_at: buyerAuth.now_iso
    }
  }).result;

  assert.equal(computed.ok, true);
  assert.ok(computed.body.candidates.length >= 1);
  const candidate = computed.body.candidates.find(row => row.input_refs.some(ref => ref.kind === 'blueprint' && ref.id === 'bp_skill_2'));
  assert.ok(candidate);
  assert.equal(candidate.candidate_type, 'mixed');
  assert.ok(candidate.legs_preview.some(leg => leg.leg_type === 'blueprint_delivery'));
  assert.ok(candidate.legs_preview.some(leg => leg.leg_type === 'cash_payment'));
  assert.equal(candidate.obligation_graph.graph_type, 'economic');
  assert.equal(candidate.execution_graph.graph_type, 'execution_mapping');
  assert.equal(candidate.obligation_graph.obligations.length, candidate.legs_preview.length);
  assert.equal(candidate.execution_graph.steps.length, candidate.legs_preview.length);
  assert.ok(candidate.obligation_graph.participant_roles.every(row => row.principal && row.executor));
  assert.equal(candidate.clearing_policy.mode, 'continuous');
  assert.ok(candidate.score_breakdown.completion_probability > 0);
  assert.ok(candidate.explanation.some(line => line.startsWith('clearing_mode=')));

  const buyerAccepted = candidates.accept({
    actor: buyer,
    auth: buyerAuth,
    candidateId: candidate.candidate_id,
    idempotencyKey: 'cand-accept-buyer',
    request: { recorded_at: buyerAuth.now_iso }
  }).result;
  assert.equal(buyerAccepted.ok, true);
  assert.equal(buyerAccepted.body.candidate.status, 'awaiting_acceptance');

  const sellerAccepted = candidates.accept({
    actor: seller,
    auth: sellerAuth,
    candidateId: candidate.candidate_id,
    idempotencyKey: 'cand-accept-seller',
    request: { recorded_at: sellerAuth.now_iso }
  }).result;
  assert.equal(sellerAccepted.ok, true);
  assert.equal(sellerAccepted.body.candidate.status, 'accepted');

  const anonGet = candidates.get({ actor: null, auth: {}, candidateId: candidate.candidate_id });
  assert.equal(anonGet.ok, true);
  assert.equal(anonGet.body.candidate.candidate_id, candidate.candidate_id);
});

test('candidate compute translates legacy-style 3-party barter cycles from market listings', () => {
  const store = createStore();
  const market = new MarketService({ store });
  const candidates = new MarketCandidateService({ store });
  const actorA = actor('cycle_a');
  const actorB = actor('cycle_b');
  const actorC = actor('cycle_c');
  const authA = auth();
  const authB = auth();
  const authC = auth();

  const listingDefs = [
    {
      actor: actorA,
      auth: authA,
      id: 'post_a',
      title: 'Asset A',
      offer: [{ platform: 'steam', asset_id: 'assetA', metadata: { category: 'games' }, estimated_value_usd: 10 }],
      want_spec: { type: 'set', any_of: [{ type: 'specific_asset', platform: 'steam', asset_key: 'steam:assetB' }] }
    },
    {
      actor: actorB,
      auth: authB,
      id: 'post_b',
      title: 'Asset B',
      offer: [{ platform: 'steam', asset_id: 'assetB', metadata: { category: 'games' }, estimated_value_usd: 11 }],
      want_spec: { type: 'set', any_of: [{ type: 'specific_asset', platform: 'steam', asset_key: 'steam:assetC' }] }
    },
    {
      actor: actorC,
      auth: authC,
      id: 'post_c',
      title: 'Asset C',
      offer: [{ platform: 'steam', asset_id: 'assetC', metadata: { category: 'games' }, estimated_value_usd: 12 }],
      want_spec: { type: 'set', any_of: [{ type: 'specific_asset', platform: 'steam', asset_key: 'steam:assetA' }] }
    }
  ];

  for (const def of listingDefs) {
    const created = market.createListing({
      actor: def.actor,
      auth: def.auth,
      idempotencyKey: `listing-${def.id}`,
      request: {
        recorded_at: def.auth.now_iso,
        listing: {
          listing_id: def.id,
          workspace_id: 'cycle_market',
          kind: 'post',
          title: def.title,
          offer: def.offer,
          want_spec: def.want_spec,
          valuation_hint: { usd_total: def.offer[0].estimated_value_usd }
        }
      }
    }).result;
    assert.equal(created.ok, true);
  }

  const computed = candidates.compute({
    actor: actorA,
    auth: authA,
    idempotencyKey: 'cand-compute-cycle',
    request: {
      workspace_id: 'cycle_market',
      max_cycle_length: 4,
      max_candidates: 10,
      recorded_at: authA.now_iso
    }
  }).result;
  assert.equal(computed.ok, true);

  const cycleCandidate = computed.body.candidates.find(row => row.candidate_type === 'cycle');
  assert.ok(cycleCandidate);
  assert.equal(cycleCandidate.participants.length, 3);
  assert.equal(cycleCandidate.legs_preview.length, 3);
  assert.equal(cycleCandidate.obligation_graph.obligations.length, 3);
  assert.equal(cycleCandidate.execution_graph.steps.length, 3);
  assert.equal(cycleCandidate.obligation_graph.fallback_policy.mode, 'recompute_or_expire');
  assert.equal(cycleCandidate.clearing_policy.mode, 'batch_window');
  assert.equal(cycleCandidate.clearing_policy.window_seconds, 60);
  assert.ok(cycleCandidate.score_breakdown.trust_confidence > 0);
  assert.ok(cycleCandidate.explanation.some(line => /cycle_length=3/.test(line)));
});
