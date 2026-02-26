import test from 'node:test';
import assert from 'node:assert/strict';

import { MarketplaceApiClient } from '../../../client/marketplace/src/api/apiClient.mjs';

function okResponse(body, status = 200) {
  return {
    ok: true,
    status,
    headers: new Headers({ 'x-correlation-id': 'corr_settlement' }),
    text: async () => JSON.stringify(body)
  };
}

function sampleTimeline(state = 'escrow.pending') {
  return {
    cycle_id: 'cycle_1',
    state,
    updated_at: '2026-02-24T10:00:00.000Z',
    legs: [
      {
        leg_id: 'leg_1',
        intent_id: 'intent_1',
        from_actor: { type: 'user', id: 'user_1' },
        to_actor: { type: 'user', id: 'user_2' },
        assets: [
          {
            platform: 'steam',
            app_id: 730,
            context_id: 2,
            asset_id: 'asset_1',
            class_id: 'class_1',
            instance_id: '0',
            metadata: { value_usd: 120 }
          }
        ],
        status: 'pending',
        deposit_deadline_at: '2026-02-24T18:00:00.000Z',
        deposit_mode: 'deposit'
      }
    ]
  };
}

test('confirmDeposit sends settlement scope + idempotency key and maps timeline', async () => {
  const calls = [];
  const client = new MarketplaceApiClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return okResponse({ timeline: sampleTimeline('escrow.ready') });
    },
    getActorContext: () => ({ actorType: 'user', actorId: 'user_1', scopes: ['settlement:write'] })
  });

  const out = await client.confirmDeposit({
    cycleId: 'cycle_1',
    depositRef: 'dep_ref_1',
    idempotencyKey: 'idem_dep_1'
  });

  assert.equal(out.timeline.cycleId, 'cycle_1');
  assert.equal(out.timeline.state, 'escrow.ready');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.endsWith('/settlement/cycle_1/deposit-confirmed'), true);
  assert.equal(calls[0].init.headers['x-auth-scopes'], 'settlement:write');
  assert.equal(calls[0].init.headers['idempotency-key'], 'idem_dep_1');

  const parsedBody = JSON.parse(calls[0].init.body);
  assert.deepEqual(parsedBody, { deposit_ref: 'dep_ref_1' });
});

test('beginExecution sends idempotency key and maps timeline response', async () => {
  const calls = [];
  const client = new MarketplaceApiClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return okResponse({ timeline: sampleTimeline('executing') });
    },
    getActorContext: () => ({ actorType: 'partner', actorId: 'partner_demo', scopes: ['settlement:write'] })
  });

  const out = await client.beginExecution({
    cycleId: 'cycle_1',
    idempotencyKey: 'idem_begin_1'
  });

  assert.equal(out.timeline.state, 'executing');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.endsWith('/settlement/cycle_1/begin-execution'), true);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['idempotency-key'], 'idem_begin_1');
  assert.equal(calls[0].init.body, '{}');
});

test('completeSettlement maps timeline + receipt response envelope', async () => {
  const calls = [];
  const client = new MarketplaceApiClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return okResponse({
        timeline: sampleTimeline('completed'),
        receipt: {
          id: 'receipt_1',
          cycle_id: 'cycle_1',
          final_state: 'completed',
          created_at: '2026-02-24T10:30:00.000Z',
          intent_ids: ['intent_1'],
          asset_ids: ['asset_1'],
          fees: [{ actor: { type: 'user', id: 'user_1' }, fee_usd: 1.1 }],
          liquidity_provider_summary: [{
            provider: {
              provider_id: 'lp_1',
              provider_type: 'partner_lp',
              owner_actor: { type: 'partner', id: 'partner_1' },
              is_automated: true,
              is_house_inventory: false,
              label_required: true,
              display_label: 'Partner LP',
              disclosure_text: 'lp disclosure',
              active: true,
              created_at: '2026-02-24T10:00:00.000Z',
              updated_at: '2026-02-24T10:00:00.000Z'
            },
            participant_count: 2,
            counterparty_intent_ids: ['intent_2']
          }],
          transparency: { reason_code: 'none' },
          signature: { key_id: 'key_1', alg: 'ed25519', sig: 'sig' }
        }
      });
    },
    getActorContext: () => ({ actorType: 'partner', actorId: 'partner_demo', scopes: ['settlement:write'] })
  });

  const out = await client.completeSettlement({
    cycleId: 'cycle_1',
    idempotencyKey: 'idem_complete_1'
  });

  assert.equal(out.timeline.state, 'completed');
  assert.equal(out.receipt.id, 'receipt_1');
  assert.equal(out.receipt.cycleId, 'cycle_1');
  assert.equal(out.receipt.fees[0].feeUsd, 1.1);
  assert.equal(out.receipt.liquidityProviderSummary[0].provider.providerId, 'lp_1');
  assert.equal(out.receipt.transparency.reason_code, 'none');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.endsWith('/settlement/cycle_1/complete'), true);
  assert.equal(calls[0].init.headers['idempotency-key'], 'idem_complete_1');
});
