import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildIntentPayload,
  requestJson,
  startRuntimeHarness,
  token
} from '../../../scripts/web-m1/runtimeHarness.mjs';

test('swap-intent create endpoint replays and rejects payload mismatches by idempotency key', async () => {
  const runtime = await startRuntimeHarness();

  try {
    const actor = { type: 'user', id: token('idem_user') };
    const idempotencyKey = token('idem');
    const payload = buildIntentPayload({
      intentId: token('idem_intent'),
      actorId: actor.id,
      offerAssetId: token('offer'),
      wantAssetId: token('want'),
      valueUsd: 99
    });

    const first = await requestJson({
      baseUrl: runtime.baseUrl,
      method: 'POST',
      path: '/swap-intents',
      actor,
      scopes: ['swap_intents:write'],
      idempotencyKey,
      body: payload
    });

    const replay = await requestJson({
      baseUrl: runtime.baseUrl,
      method: 'POST',
      path: '/swap-intents',
      actor,
      scopes: ['swap_intents:write'],
      idempotencyKey,
      body: payload
    });

    const mismatchPayload = buildIntentPayload({
      intentId: token('idem_intent_alt'),
      actorId: actor.id,
      offerAssetId: token('offer_alt'),
      wantAssetId: token('want_alt'),
      valueUsd: 150
    });

    const mismatch = await requestJson({
      baseUrl: runtime.baseUrl,
      method: 'POST',
      path: '/swap-intents',
      actor,
      scopes: ['swap_intents:write'],
      idempotencyKey,
      body: mismatchPayload
    });

    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.equal(first.body.intent.id, replay.body.intent.id);

    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.error.code, 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH');
  } finally {
    await runtime.close();
  }
});
