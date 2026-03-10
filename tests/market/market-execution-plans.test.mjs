import test from 'node:test';
import assert from 'node:assert/strict';

import { JsonStateStore } from '../../src/store/jsonStateStore.mjs';
import { MarketService } from '../../src/service/marketService.mjs';
import { MarketBlueprintService } from '../../src/service/marketBlueprintService.mjs';
import { MarketCandidateService } from '../../src/service/marketCandidateService.mjs';
import { MarketExecutionPlanService } from '../../src/service/marketExecutionPlanService.mjs';

function createStore() {
  return new JsonStateStore({
    filePath: `/tmp/swapgraph-market-plans-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  });
}

function auth(scopes = ['market:read', 'market:write']) {
  return {
    scopes,
    now_iso: '2026-03-09T19:00:00.000Z',
    client_fingerprint: 'test-client'
  };
}

function actor(id) {
  return { type: 'user', id };
}

test('execution plans materialize accepted 3-party cycle candidates and bridge receipts', () => {
  const store = createStore();
  const market = new MarketService({ store });
  const candidates = new MarketCandidateService({ store });
  const plans = new MarketExecutionPlanService({ store });
  const actorA = actor('plan_cycle_a');
  const actorB = actor('plan_cycle_b');
  const actorC = actor('plan_cycle_c');
  const authA = auth();
  const authB = auth();
  const authC = auth();

  const listingDefs = [
    {
      actor: actorA,
      auth: authA,
      id: 'plan_post_a',
      title: 'Asset A',
      offer: [{ platform: 'steam', asset_id: 'assetA', metadata: { category: 'games' }, estimated_value_usd: 10 }],
      want_spec: { type: 'set', any_of: [{ type: 'specific_asset', platform: 'steam', asset_key: 'steam:assetB' }] }
    },
    {
      actor: actorB,
      auth: authB,
      id: 'plan_post_b',
      title: 'Asset B',
      offer: [{ platform: 'steam', asset_id: 'assetB', metadata: { category: 'games' }, estimated_value_usd: 11 }],
      want_spec: { type: 'set', any_of: [{ type: 'specific_asset', platform: 'steam', asset_key: 'steam:assetC' }] }
    },
    {
      actor: actorC,
      auth: authC,
      id: 'plan_post_c',
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
          workspace_id: 'cycle_plan_market',
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
    idempotencyKey: 'cand-compute-plan-cycle',
    request: {
      workspace_id: 'cycle_plan_market',
      max_cycle_length: 4,
      max_candidates: 10,
      recorded_at: authA.now_iso
    }
  }).result;
  assert.equal(computed.ok, true);
  const cycleCandidate = computed.body.candidates.find(row => row.candidate_type === 'cycle');
  assert.ok(cycleCandidate);

  const createdPlan = plans.createFromCandidate({
    actor: actorA,
    auth: authA,
    candidateId: cycleCandidate.candidate_id,
    idempotencyKey: 'plan-create-cycle',
    request: { recorded_at: authA.now_iso }
  }).result;
  assert.equal(createdPlan.ok, true);
  assert.equal(createdPlan.body.plan.status, 'pending_participant_acceptance');
  assert.equal(createdPlan.body.plan.transfer_legs.length, 3);
  assert.equal(createdPlan.body.plan.obligation_graph.graph_type, 'economic');
  assert.equal(createdPlan.body.plan.execution_graph.graph_type, 'execution_mapping');
  assert.equal(createdPlan.body.plan.failure_policy.on_blocking_leg_failure, 'fail_plan');

  assert.equal(plans.accept({ actor: actorA, auth: authA, planId: createdPlan.body.plan.plan_id, idempotencyKey: 'plan-accept-a', request: { recorded_at: authA.now_iso } }).result.ok, true);
  assert.equal(plans.accept({ actor: actorB, auth: authB, planId: createdPlan.body.plan.plan_id, idempotencyKey: 'plan-accept-b', request: { recorded_at: authB.now_iso } }).result.ok, true);
  const accepted = plans.accept({ actor: actorC, auth: authC, planId: createdPlan.body.plan.plan_id, idempotencyKey: 'plan-accept-c', request: { recorded_at: authC.now_iso } }).result;
  assert.equal(accepted.ok, true);
  assert.equal(accepted.body.plan.status, 'ready_for_settlement');

  const proposalId = cycleCandidate.legacy_refs.proposal_id;
  store.state.receipts[proposalId] = {
    id: 'receipt_legacy_cycle_plan',
    cycle_id: proposalId,
    final_state: 'completed',
    intent_ids: [],
    asset_ids: ['assetA', 'assetB', 'assetC'],
    created_at: authA.now_iso,
    transparency: { bridge: true },
    signature: 'signed-legacy'
  };

  const started = plans.startSettlement({
    actor: actorA,
    auth: authA,
    planId: createdPlan.body.plan.plan_id,
    idempotencyKey: 'plan-start-cycle',
    request: { settlement_mode: 'cycle_bridge', cycle_id: proposalId, recorded_at: authA.now_iso }
  }).result;
  assert.equal(started.ok, true);
  assert.equal(started.body.plan.status, 'settlement_in_progress');

  for (const leg of started.body.plan.transfer_legs) {
    const legActor = leg.from_actor;
    const legAuth = legActor.id === actorA.id ? authA : (legActor.id === actorB.id ? authB : authC);
    const completed = plans.completeLeg({
      actor: legActor,
      auth: legAuth,
      planId: createdPlan.body.plan.plan_id,
      legId: leg.leg_id,
      idempotencyKey: `plan-complete-${leg.leg_id}`,
      request: { verification_result: { status: 'ok' }, recorded_at: legAuth.now_iso }
    }).result;
    assert.equal(completed.ok, true);
  }

  const finalPlan = plans.get({ actor: actorA, auth: authA, planId: createdPlan.body.plan.plan_id });
  assert.equal(finalPlan.ok, true);
  assert.equal(finalPlan.body.plan.status, 'completed');
  assert.equal(finalPlan.body.plan.receipt_ref, 'receipt_legacy_cycle_plan');

  const anonReceipt = plans.receipt({ actor: null, auth: {}, planId: createdPlan.body.plan.plan_id });
  assert.equal(anonReceipt.ok, true);
  assert.equal(anonReceipt.body.receipt.id, 'receipt_legacy_cycle_plan');
});

test('execution plans support mixed blueprint plus cash flow and mint signed receipts when all legs complete', () => {
  const store = createStore();
  const market = new MarketService({ store });
  const blueprints = new MarketBlueprintService({ store });
  const candidates = new MarketCandidateService({ store });
  const plans = new MarketExecutionPlanService({ store });
  const seller = actor('plan_blueprint_seller');
  const buyer = actor('plan_blueprint_buyer');
  const sellerAuth = auth();
  const buyerAuth = auth();

  assert.equal(blueprints.create({
    actor: seller,
    auth: sellerAuth,
    idempotencyKey: 'plan-bp-create',
    request: {
      recorded_at: sellerAuth.now_iso,
      blueprint: {
        blueprint_id: 'bp_exec_plan_1',
        workspace_id: 'plan_blueprint_market',
        title: 'Deploy agent blueprint',
        category: 'agent_template',
        artifact_ref: 'https://example.com/deploy-agent.tgz',
        artifact_format: 'tarball',
        delivery_mode: 'download',
        pricing_model: 'one_time',
        valuation_hint: { usd_amount: 35 }
      }
    }
  }).result.ok, true);
  assert.equal(blueprints.publish({ actor: seller, auth: sellerAuth, blueprintId: 'bp_exec_plan_1', idempotencyKey: 'plan-bp-publish', request: { recorded_at: sellerAuth.now_iso } }).result.ok, true);

  assert.equal(market.createListing({
    actor: buyer,
    auth: buyerAuth,
    idempotencyKey: 'plan-want-create',
    request: {
      recorded_at: buyerAuth.now_iso,
      listing: {
        listing_id: 'plan_want_1',
        workspace_id: 'plan_blueprint_market',
        kind: 'want',
        title: 'Need deploy blueprint',
        want_spec: { type: 'set', any_of: [{ type: 'category', category: 'blueprint:agent_template' }] },
        budget: { amount: 35, currency: 'USD' }
      }
    }
  }).result.ok, true);

  const computed = candidates.compute({
    actor: buyer,
    auth: buyerAuth,
    idempotencyKey: 'plan-bp-candidate-compute',
    request: {
      workspace_id: 'plan_blueprint_market',
      max_cycle_length: 3,
      max_candidates: 10,
      recorded_at: buyerAuth.now_iso
    }
  }).result;
  assert.equal(computed.ok, true);
  const mixedCandidate = computed.body.candidates.find(row => row.candidate_type === 'mixed');
  assert.ok(mixedCandidate);

  const createdPlan = plans.createFromCandidate({
    actor: buyer,
    auth: buyerAuth,
    candidateId: mixedCandidate.candidate_id,
    idempotencyKey: 'plan-bp-create-plan',
    request: { recorded_at: buyerAuth.now_iso }
  }).result;
  assert.equal(createdPlan.ok, true);

  assert.equal(plans.accept({ actor: buyer, auth: buyerAuth, planId: createdPlan.body.plan.plan_id, idempotencyKey: 'plan-bp-accept-buyer', request: { recorded_at: buyerAuth.now_iso } }).result.ok, true);
  const ready = plans.accept({ actor: seller, auth: sellerAuth, planId: createdPlan.body.plan.plan_id, idempotencyKey: 'plan-bp-accept-seller', request: { recorded_at: sellerAuth.now_iso } }).result;
  assert.equal(ready.ok, true);
  assert.equal(ready.body.plan.status, 'ready_for_settlement');

  const started = plans.startSettlement({
    actor: buyer,
    auth: buyerAuth,
    planId: createdPlan.body.plan.plan_id,
    idempotencyKey: 'plan-bp-start',
    request: { settlement_mode: 'external_payment_proof', recorded_at: buyerAuth.now_iso }
  }).result;
  assert.equal(started.ok, true);
  assert.equal(started.body.plan.execution_graph.status, 'settlement_in_progress');

  const blueprintLeg = started.body.plan.transfer_legs.find(row => row.leg_type === 'blueprint_delivery');
  const cashLeg = started.body.plan.transfer_legs.find(row => row.leg_type === 'cash_payment');
  assert.ok(blueprintLeg);
  assert.ok(cashLeg);
  assert.equal(started.body.plan.obligation_graph.obligations.length, 2);
  assert.equal(started.body.plan.execution_graph.steps.length, 2);

  assert.equal(plans.completeLeg({
    actor: blueprintLeg.from_actor,
    auth: sellerAuth,
    planId: createdPlan.body.plan.plan_id,
    legId: blueprintLeg.leg_id,
    idempotencyKey: 'plan-bp-complete-blueprint',
    request: { verification_result: { artifact_delivered: true }, recorded_at: sellerAuth.now_iso }
  }).result.ok, true);
  const partial = plans.get({ actor: buyer, auth: buyerAuth, planId: createdPlan.body.plan.plan_id });
  assert.equal(partial.ok, true);
  assert.equal(partial.body.plan.status, 'partially_complete');

  const completed = plans.completeLeg({
    actor: cashLeg.from_actor,
    auth: buyerAuth,
    planId: createdPlan.body.plan.plan_id,
    legId: cashLeg.leg_id,
    idempotencyKey: 'plan-bp-complete-cash',
    request: { verification_result: { payment_confirmed: true }, recorded_at: buyerAuth.now_iso }
  }).result;
  assert.equal(completed.ok, true);
  assert.equal(completed.body.plan.status, 'completed');
  assert.ok(completed.body.plan.receipt_ref);

  const receipt = plans.receipt({ actor: buyer, auth: buyerAuth, planId: createdPlan.body.plan.plan_id });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.body.receipt.transparency.market_execution_plan_id, createdPlan.body.plan.plan_id);
});

test('execution plans fail closed when a participant fails a blocking leg', () => {
  const store = createStore();
  const market = new MarketService({ store });
  const blueprints = new MarketBlueprintService({ store });
  const candidates = new MarketCandidateService({ store });
  const plans = new MarketExecutionPlanService({ store });
  const seller = actor('plan_fail_seller');
  const buyer = actor('plan_fail_buyer');
  const sellerAuth = auth();
  const buyerAuth = auth();

  assert.equal(blueprints.create({
    actor: seller,
    auth: sellerAuth,
    idempotencyKey: 'plan-fail-blueprint',
    request: {
      recorded_at: sellerAuth.now_iso,
      blueprint: {
        blueprint_id: 'bp_fail_plan',
        workspace_id: 'plan_fail_market',
        title: 'Failure blueprint',
        category: 'workflow',
        artifact_ref: 'https://example.com/failure-blueprint.tgz',
        artifact_format: 'tarball',
        delivery_mode: 'download',
        pricing_model: 'one_time',
        valuation_hint: { usd_amount: 20 }
      }
    }
  }).result.ok, true);
  assert.equal(blueprints.publish({
    actor: seller,
    auth: sellerAuth,
    blueprintId: 'bp_fail_plan',
    idempotencyKey: 'plan-fail-blueprint-publish',
    request: { recorded_at: sellerAuth.now_iso }
  }).result.ok, true);
  assert.equal(market.createListing({
    actor: buyer,
    auth: buyerAuth,
    idempotencyKey: 'plan-fail-want',
    request: {
      recorded_at: buyerAuth.now_iso,
      listing: {
        listing_id: 'plan_fail_want',
        workspace_id: 'plan_fail_market',
        kind: 'want',
        title: 'Buyer wants failure blueprint',
        want_spec: { type: 'set', any_of: [{ type: 'category', category: 'blueprint:workflow' }] },
        budget: { amount: 20, currency: 'USD' }
      }
    }
  }).result.ok, true);

  const computed = candidates.compute({
    actor: buyer,
    auth: buyerAuth,
    idempotencyKey: 'plan-fail-candidate',
    request: {
      workspace_id: 'plan_fail_market',
      max_cycle_length: 3,
      max_candidates: 10,
      recorded_at: buyerAuth.now_iso
    }
  }).result;
  assert.equal(computed.ok, true);
  const candidate = computed.body.candidates.find(row => row.legs_preview.some(leg => leg.leg_type === 'blueprint_delivery'));
  assert.ok(candidate);

  const createdPlan = plans.createFromCandidate({
    actor: buyer,
    auth: buyerAuth,
    candidateId: candidate.candidate_id,
    idempotencyKey: 'plan-fail-create',
    request: { recorded_at: buyerAuth.now_iso }
  }).result;
  assert.equal(createdPlan.ok, true);

  assert.equal(plans.accept({ actor: buyer, auth: buyerAuth, planId: createdPlan.body.plan.plan_id, idempotencyKey: 'plan-fail-accept-buyer', request: { recorded_at: buyerAuth.now_iso } }).result.ok, true);
  assert.equal(plans.accept({ actor: seller, auth: sellerAuth, planId: createdPlan.body.plan.plan_id, idempotencyKey: 'plan-fail-accept-seller', request: { recorded_at: sellerAuth.now_iso } }).result.ok, true);
  assert.equal(plans.startSettlement({ actor: buyer, auth: buyerAuth, planId: createdPlan.body.plan.plan_id, idempotencyKey: 'plan-fail-start', request: { settlement_mode: 'external_payment_proof', recorded_at: buyerAuth.now_iso } }).result.ok, true);

  const leg = plans.get({ actor: buyer, auth: buyerAuth, planId: createdPlan.body.plan.plan_id }).body.plan.transfer_legs[0];
  const failed = plans.failLeg({
    actor: leg.from_actor,
    auth: actorEquals(leg.from_actor, seller) ? sellerAuth : buyerAuth,
    planId: createdPlan.body.plan.plan_id,
    legId: leg.leg_id,
    idempotencyKey: 'plan-fail-leg',
    request: { failure_reason: 'counterparty_unreachable', recorded_at: buyerAuth.now_iso }
  }).result;
  assert.equal(failed.ok, true);
  assert.equal(failed.body.plan.status, 'failed');
  assert.equal(failed.body.plan.transfer_legs[0].status, 'failed');

  const receipt = plans.receipt({ actor: buyer, auth: buyerAuth, planId: createdPlan.body.plan.plan_id });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.body.error.details.reason_code, 'market_receipt_not_found');
});

test('execution plans unwind and compensate reversible legs after partial completion failure', () => {
  const store = createStore();
  const market = new MarketService({ store });
  const blueprints = new MarketBlueprintService({ store });
  const candidates = new MarketCandidateService({ store });
  const plans = new MarketExecutionPlanService({ store });
  const seller = actor('plan_unwind_seller');
  const buyer = actor('plan_unwind_buyer');
  const sellerAuth = auth();
  const buyerAuth = auth();

  assert.equal(blueprints.create({
    actor: seller,
    auth: sellerAuth,
    idempotencyKey: 'plan-unwind-blueprint',
    request: {
      recorded_at: sellerAuth.now_iso,
      blueprint: {
        blueprint_id: 'bp_unwind_plan',
        workspace_id: 'plan_unwind_market',
        title: 'Unwind blueprint',
        category: 'workflow',
        artifact_ref: 'https://example.com/unwind-blueprint.tgz',
        artifact_format: 'tarball',
        delivery_mode: 'download',
        pricing_model: 'one_time',
        valuation_hint: { usd_amount: 20 }
      }
    }
  }).result.ok, true);
  assert.equal(blueprints.publish({
    actor: seller,
    auth: sellerAuth,
    blueprintId: 'bp_unwind_plan',
    idempotencyKey: 'plan-unwind-blueprint-publish',
    request: { recorded_at: sellerAuth.now_iso }
  }).result.ok, true);
  assert.equal(market.createListing({
    actor: buyer,
    auth: buyerAuth,
    idempotencyKey: 'plan-unwind-want',
    request: {
      recorded_at: buyerAuth.now_iso,
      listing: {
        listing_id: 'plan_unwind_want',
        workspace_id: 'plan_unwind_market',
        kind: 'want',
        title: 'Buyer wants unwind blueprint',
        want_spec: { type: 'set', any_of: [{ type: 'category', category: 'blueprint:workflow' }] },
        budget: { amount: 20, currency: 'USD' }
      }
    }
  }).result.ok, true);

  const computed = candidates.compute({
    actor: buyer,
    auth: buyerAuth,
    idempotencyKey: 'plan-unwind-candidate',
    request: {
      workspace_id: 'plan_unwind_market',
      max_cycle_length: 3,
      max_candidates: 10,
      recorded_at: buyerAuth.now_iso
    }
  }).result;
  const candidate = computed.body.candidates.find(row => row.legs_preview.some(leg => leg.leg_type === 'blueprint_delivery'));
  assert.ok(candidate);

  const createdPlan = plans.createFromCandidate({
    actor: buyer,
    auth: buyerAuth,
    candidateId: candidate.candidate_id,
    idempotencyKey: 'plan-unwind-create',
    request: { recorded_at: buyerAuth.now_iso }
  }).result;
  assert.equal(createdPlan.ok, true);
  assert.equal(plans.accept({ actor: buyer, auth: buyerAuth, planId: createdPlan.body.plan.plan_id, idempotencyKey: 'plan-unwind-accept-buyer', request: { recorded_at: buyerAuth.now_iso } }).result.ok, true);
  assert.equal(plans.accept({ actor: seller, auth: sellerAuth, planId: createdPlan.body.plan.plan_id, idempotencyKey: 'plan-unwind-accept-seller', request: { recorded_at: sellerAuth.now_iso } }).result.ok, true);
  assert.equal(plans.startSettlement({ actor: buyer, auth: buyerAuth, planId: createdPlan.body.plan.plan_id, idempotencyKey: 'plan-unwind-start', request: { settlement_mode: 'external_payment_proof', recorded_at: buyerAuth.now_iso } }).result.ok, true);

  const current = plans.get({ actor: buyer, auth: buyerAuth, planId: createdPlan.body.plan.plan_id }).body.plan;
  const cashLeg = current.transfer_legs.find(row => row.leg_type === 'cash_payment');
  const blueprintLeg = current.transfer_legs.find(row => row.leg_type === 'blueprint_delivery');
  assert.ok(cashLeg);
  assert.ok(blueprintLeg);

  assert.equal(plans.completeLeg({
    actor: cashLeg.from_actor,
    auth: buyerAuth,
    planId: current.plan_id,
    legId: cashLeg.leg_id,
    idempotencyKey: 'plan-unwind-complete-cash',
    request: { verification_result: { payment_confirmed: true }, recorded_at: buyerAuth.now_iso }
  }).result.ok, true);

  const unwound = plans.failLeg({
    actor: blueprintLeg.from_actor,
    auth: sellerAuth,
    planId: current.plan_id,
    legId: blueprintLeg.leg_id,
    idempotencyKey: 'plan-unwind-fail-blueprint',
    request: { failure_reason: 'artifact_unavailable', recorded_at: sellerAuth.now_iso }
  }).result;
  assert.equal(unwound.ok, true);
  assert.equal(unwound.body.plan.status, 'unwound');
  assert.equal(unwound.body.plan.failure_summary.state, 'unwound');
  const compensatedCashLeg = unwound.body.plan.transfer_legs.find(row => row.leg_id === cashLeg.leg_id);
  assert.equal(compensatedCashLeg.status, 'compensated');

  const receipt = plans.receipt({ actor: buyer, auth: buyerAuth, planId: current.plan_id });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.body.receipt.final_state, 'unwound');
});

test('execution plans can resolve a failed leg by substitution and still complete', () => {
  const store = createStore();
  const market = new MarketService({ store });
  const blueprints = new MarketBlueprintService({ store });
  const candidates = new MarketCandidateService({ store });
  const plans = new MarketExecutionPlanService({ store });
  const seller = actor('plan_sub_seller');
  const buyer = actor('plan_sub_buyer');
  const sellerAuth = auth();
  const buyerAuth = auth();

  assert.equal(blueprints.create({
    actor: seller,
    auth: sellerAuth,
    idempotencyKey: 'plan-sub-blueprint',
    request: {
      recorded_at: sellerAuth.now_iso,
      blueprint: {
        blueprint_id: 'bp_sub_plan',
        workspace_id: 'plan_sub_market',
        title: 'Sub blueprint',
        category: 'workflow',
        artifact_ref: 'https://example.com/sub-blueprint.tgz',
        artifact_format: 'tarball',
        delivery_mode: 'download',
        pricing_model: 'one_time',
        valuation_hint: { usd_amount: 20 }
      }
    }
  }).result.ok, true);
  assert.equal(blueprints.publish({
    actor: seller,
    auth: sellerAuth,
    blueprintId: 'bp_sub_plan',
    idempotencyKey: 'plan-sub-blueprint-publish',
    request: { recorded_at: sellerAuth.now_iso }
  }).result.ok, true);
  assert.equal(market.createListing({
    actor: buyer,
    auth: buyerAuth,
    idempotencyKey: 'plan-sub-want',
    request: {
      recorded_at: buyerAuth.now_iso,
      listing: {
        listing_id: 'plan_sub_want',
        workspace_id: 'plan_sub_market',
        kind: 'want',
        title: 'Buyer wants sub blueprint',
        want_spec: { type: 'set', any_of: [{ type: 'category', category: 'blueprint:workflow' }] },
        budget: { amount: 20, currency: 'USD' }
      }
    }
  }).result.ok, true);

  const computed = candidates.compute({
    actor: buyer,
    auth: buyerAuth,
    idempotencyKey: 'plan-sub-candidate',
    request: {
      workspace_id: 'plan_sub_market',
      max_cycle_length: 3,
      max_candidates: 10,
      recorded_at: buyerAuth.now_iso
    }
  }).result;
  const candidate = computed.body.candidates.find(row => row.legs_preview.some(leg => leg.leg_type === 'blueprint_delivery'));
  assert.ok(candidate);

  const createdPlan = plans.createFromCandidate({
    actor: buyer,
    auth: buyerAuth,
    candidateId: candidate.candidate_id,
    idempotencyKey: 'plan-sub-create',
    request: { recorded_at: buyerAuth.now_iso }
  }).result;
  assert.equal(createdPlan.ok, true);
  assert.equal(plans.accept({ actor: buyer, auth: buyerAuth, planId: createdPlan.body.plan.plan_id, idempotencyKey: 'plan-sub-accept-buyer', request: { recorded_at: buyerAuth.now_iso } }).result.ok, true);
  assert.equal(plans.accept({ actor: seller, auth: sellerAuth, planId: createdPlan.body.plan.plan_id, idempotencyKey: 'plan-sub-accept-seller', request: { recorded_at: sellerAuth.now_iso } }).result.ok, true);
  assert.equal(plans.startSettlement({ actor: buyer, auth: buyerAuth, planId: createdPlan.body.plan.plan_id, idempotencyKey: 'plan-sub-start', request: { settlement_mode: 'external_payment_proof', recorded_at: buyerAuth.now_iso } }).result.ok, true);

  const current = plans.get({ actor: buyer, auth: buyerAuth, planId: createdPlan.body.plan.plan_id }).body.plan;
  const blueprintLeg = current.transfer_legs.find(row => row.leg_type === 'blueprint_delivery');
  const cashLeg = current.transfer_legs.find(row => row.leg_type === 'cash_payment');
  assert.ok(blueprintLeg);
  assert.ok(cashLeg);

  assert.equal(plans.completeLeg({
    actor: cashLeg.from_actor,
    auth: buyerAuth,
    planId: current.plan_id,
    legId: cashLeg.leg_id,
    idempotencyKey: 'plan-sub-complete-cash',
    request: { verification_result: { payment_confirmed: true }, recorded_at: buyerAuth.now_iso }
  }).result.ok, true);

  const substituted = plans.failLeg({
    actor: blueprintLeg.from_actor,
    auth: sellerAuth,
    planId: current.plan_id,
    legId: blueprintLeg.leg_id,
    idempotencyKey: 'plan-sub-fail-blueprint',
    request: {
      failure_reason: 'primary_artifact_missing',
      resolution: 'substituted',
      substitution_result: { replacement_artifact_ref: 'https://example.com/substitute-blueprint.tgz' },
      recorded_at: sellerAuth.now_iso
    }
  }).result;
  assert.equal(substituted.ok, true);
  assert.equal(substituted.body.plan.status, 'completed');
  const substitutedLeg = substituted.body.plan.transfer_legs.find(row => row.leg_id === blueprintLeg.leg_id);
  assert.equal(substitutedLeg.status, 'substituted');
  assert.equal(substituted.body.plan.failure_summary.state, 'completed_with_substitution');

  const receipt = plans.receipt({ actor: buyer, auth: buyerAuth, planId: current.plan_id });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.body.receipt.final_state, 'completed');
});

function actorEquals(a, b) {
  return (a?.type ?? null) === (b?.type ?? null) && (a?.id ?? null) === (b?.id ?? null);
}
