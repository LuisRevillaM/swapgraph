import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mapInventoryAwakeningProjection,
  mapIntentDto,
  mapMatchingRunDto,
  mapProposalDto,
  mapReceiptDto,
  mapTimelineDto
} from '../../../client/marketplace/src/domain/mappers.mjs';

test('domain mappers normalize api dto shapes', () => {
  const intent = mapIntentDto({ id: 'i1', actor: { type: 'user', id: 'u1' }, offer: [], want_spec: {}, value_band: {}, trust_constraints: {}, time_constraints: {}, settlement_preferences: {} });
  assert.equal(intent.id, 'i1');
  assert.equal(intent.actor.id, 'u1');

  const proposal = mapProposalDto({ id: 'p1', participants: [{ intent_id: 'i1', actor: { type: 'user', id: 'u1' }, give: [], get: [] }], confidence_score: 0.7, value_spread: 0.1, explainability: ['value_delta'] });
  assert.equal(proposal.id, 'p1');

  const run = mapMatchingRunDto({ run_id: 'r1', requested_by: { type: 'partner', id: 'p' }, recorded_at: '2026-01-01T00:00:00.000Z', stats: {} });
  assert.equal(run.runId, 'r1');

  const timeline = mapTimelineDto({ cycle_id: 'c1', state: 'accepted', legs: [], updated_at: '2026-01-01T00:00:00.000Z' });
  assert.equal(timeline.cycleId, 'c1');

  const receipt = mapReceiptDto({
    id: 'rc1',
    cycle_id: 'c1',
    final_state: 'completed',
    created_at: '2026-01-01T00:00:00.000Z',
    fees: [{ actor: { type: 'user', id: 'u1' }, fee_usd: 1.25 }],
    liquidity_provider_summary: [{
      provider: {
        provider_id: 'lp_1',
        provider_type: 'partner_lp',
        owner_actor: { type: 'partner', id: 'partner_1' },
        is_automated: true,
        is_house_inventory: false,
        label_required: true,
        display_label: 'Partner LP',
        disclosure_text: 'provided via lp',
        active: true,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z'
      },
      participant_count: 2,
      counterparty_intent_ids: ['intent_a']
    }],
    transparency: { reason_code: 'none' },
    signature: { key_id: 'k', alg: 'ed25519', sig: 'abc' }
  });
  assert.equal(receipt.id, 'rc1');
  assert.equal(receipt.fees[0].feeUsd, 1.25);
  assert.equal(receipt.liquidityProviderSummary[0].provider.providerId, 'lp_1');
  assert.equal(receipt.transparency.reason_code, 'none');

  const projection = mapInventoryAwakeningProjection({
    projection: {
      swappability_summary: {
        intents_total: 2,
        active_intents: 2,
        cycle_opportunities: 1,
        average_confidence_bps: 9100
      },
      recommended_first_intents: [
        {
          recommendation_id: 'rec_1',
          cycle_id: 'cycle_1',
          suggested_give_asset_id: 'asset_a',
          suggested_get_asset_id: 'asset_b',
          confidence_bps: 9200,
          rationale: 'fit'
        }
      ]
    }
  });
  assert.equal(projection.swappabilitySummary.cycleOpportunities, 1);
  assert.equal(projection.recommendedFirstIntents[0].suggestedGiveAssetId, 'asset_a');
});
