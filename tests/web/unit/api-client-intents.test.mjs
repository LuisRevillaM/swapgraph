import test from 'node:test';
import assert from 'node:assert/strict';

import { MarketplaceApiClient } from '../../../client/marketplace/src/api/apiClient.mjs';

function okResponse(body, status = 200) {
  return {
    ok: true,
    status,
    headers: new Headers({ 'x-correlation-id': 'corr_test' }),
    text: async () => JSON.stringify(body)
  };
}

function sampleIntent(id) {
  return {
    id,
    actor: { type: 'user', id: 'u1' },
    offer: [{ platform: 'steam', app_id: 730, context_id: 2, asset_id: 'asset_1', metadata: { value_usd: 100 } }],
    want_spec: {
      type: 'set',
      any_of: [{ type: 'category', platform: 'steam', app_id: 730, category: 'knife', constraints: { acceptable_wear: ['MW'] } }]
    },
    value_band: { min_usd: 80, max_usd: 120, pricing_source: 'market_median' },
    trust_constraints: { max_cycle_length: 3, min_counterparty_reliability: 0 },
    time_constraints: { expires_at: '2027-12-31T00:00:00.000Z', urgency: 'normal' },
    settlement_preferences: { require_escrow: true }
  };
}

test('updateIntent sends PATCH with idempotency key and request body', async () => {
  const calls = [];
  const client = new MarketplaceApiClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return okResponse({ intent: sampleIntent('intent_1') });
    },
    getActorContext: () => ({ actorType: 'user', actorId: 'u1', scopes: ['swap_intents:write'] })
  });

  const out = await client.updateIntent({ id: 'intent_1', intent: sampleIntent('intent_1'), idempotencyKey: 'idem_update_1' });
  assert.equal(out.intent.id, 'intent_1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.endsWith('/swap-intents/intent_1'), true);
  assert.equal(calls[0].init.method, 'PATCH');
  assert.equal(calls[0].init.headers['idempotency-key'], 'idem_update_1');

  const parsedBody = JSON.parse(calls[0].init.body);
  assert.equal(parsedBody.intent.id, 'intent_1');
});

test('cancelIntent sends POST cancel payload and returns cancellation status', async () => {
  const calls = [];
  const client = new MarketplaceApiClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return okResponse({ id: 'intent_9', status: 'cancelled' });
    },
    getActorContext: () => ({ actorType: 'user', actorId: 'u1', scopes: ['swap_intents:write'] })
  });

  const out = await client.cancelIntent({ id: 'intent_9', idempotencyKey: 'idem_cancel_1' });
  assert.equal(out.cancel.status, 'cancelled');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.endsWith('/swap-intents/intent_9/cancel'), true);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['idempotency-key'], 'idem_cancel_1');

  const parsedBody = JSON.parse(calls[0].init.body);
  assert.equal(parsedBody.id, 'intent_9');
});

test('getInventoryAwakeningProjection maps projection envelope', async () => {
  const client = new MarketplaceApiClient({
    fetchImpl: async () => okResponse({
      projection: {
        swappability_summary: {
          intents_total: 2,
          active_intents: 2,
          cycle_opportunities: 3,
          average_confidence_bps: 9100
        },
        recommended_first_intents: [
          {
            recommendation_id: 'rec_1',
            cycle_id: 'cycle_1',
            suggested_give_asset_id: 'asset_1',
            suggested_get_asset_id: 'asset_2',
            confidence_bps: 9200,
            rationale: 'good fit'
          }
        ]
      }
    }),
    getActorContext: () => ({ actorType: 'user', actorId: 'u1', scopes: ['settlement:read'] })
  });

  const out = await client.getInventoryAwakeningProjection();
  assert.equal(out.projection.swappabilitySummary.cycleOpportunities, 3);
  assert.equal(out.projection.recommendedFirstIntents[0].cycleId, 'cycle_1');
});

test('api client enforces scope boundaries and forwards csrf token on mutations', async () => {
  const calls = [];
  const client = new MarketplaceApiClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return okResponse({ intent: sampleIntent('intent_2') });
    },
    getActorContext: () => ({ actorType: 'user', actorId: 'u1', scopes: ['swap_intents:write'] }),
    getCsrfToken: () => 'csrf_test_token'
  });

  const out = await client.createIntent({
    intent: sampleIntent('intent_2'),
    idempotencyKey: 'idem_create_2'
  });
  assert.equal(out.intent.id, 'intent_2');
  assert.equal(calls[0].init.headers['x-csrf-token'], 'csrf_test_token');

  const denied = new MarketplaceApiClient({
    fetchImpl: async () => {
      throw new Error('request should not reach fetch when scope is missing');
    },
    getActorContext: () => ({ actorType: 'user', actorId: 'u1', scopes: ['swap_intents:read'] })
  });

  await assert.rejects(
    () => denied.createIntent({
      intent: sampleIntent('intent_3'),
      idempotencyKey: 'idem_create_3'
    }),
    error => error?.code === 'AUTH_SCOPE_MISSING'
  );
});

test('api client calls fetch with global context to avoid illegal invocation', async () => {
  function contextSensitiveFetch() {
    if (this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    return okResponse({ ok: true });
  }

  const client = new MarketplaceApiClient({
    fetchImpl: contextSensitiveFetch,
    getActorContext: () => ({ actorType: 'user', actorId: 'u1', scopes: ['swap_intents:read'] })
  });

  const out = await client.getHealth();
  assert.equal(out.status, 200);
});
