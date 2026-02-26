import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildIntentFromComposerDraft,
  composerDraftFromIntent,
  defaultComposerDraft,
  validateComposerDraft
} from '../../../client/marketplace/src/features/intents/composer.mjs';

test('validateComposerDraft enforces structured fields', () => {
  const invalid = validateComposerDraft({
    offeringAssetId: '',
    offerValueUsd: -1,
    wantCategory: '',
    acceptableWear: [],
    valueToleranceUsd: 15,
    maxCycleLength: 7
  });

  assert.equal(invalid.ok, false);
  assert.equal(Boolean(invalid.errors.offeringAssetId), true);
  assert.equal(Boolean(invalid.errors.acceptableWear), true);
  assert.equal(Boolean(invalid.errors.valueToleranceUsd), true);
});

test('buildIntentFromComposerDraft returns api-ready intent payload', () => {
  const built = buildIntentFromComposerDraft({
    input: {
      offeringAssetId: 'ak47_vulcan_mw_1',
      offerValueUsd: 210,
      wantCategory: 'any cs2 knife',
      acceptableWear: ['MW', 'FT'],
      valueToleranceUsd: 50,
      maxCycleLength: 3
    },
    actorId: 'web_user_123',
    now: () => Date.parse('2026-02-24T00:00:00.000Z')
  });

  assert.equal(built.ok, true);
  assert.equal(built.intent.actor.id, 'web_user_123');
  assert.equal(built.intent.offer[0].asset_id, 'ak47_vulcan_mw_1');
  assert.equal(built.intent.value_band.min_usd, 160);
  assert.equal(built.intent.value_band.max_usd, 260);
  assert.equal(built.intent.trust_constraints.max_cycle_length, 3);
  assert.equal(Array.isArray(built.intent.want_spec.any_of), true);
});

test('composerDraftFromIntent derives editable defaults from mapped intent', () => {
  const mappedIntent = {
    id: 'intent_a',
    offer: [{ assetId: 'butterfly_fade_fn', valueUsd: 620, wear: 'FN' }],
    wantSpec: {
      anyOf: [
        {
          type: 'category',
          category: 'karambit',
          constraints: { acceptable_wear: ['FN', 'MW'] }
        }
      ]
    },
    valueBand: { minUsd: 540, maxUsd: 700 },
    trustConstraints: { maxCycleLength: 4 },
    settlementPreferences: { requireEscrow: true }
  };

  const draft = composerDraftFromIntent(mappedIntent);
  assert.equal(draft.offeringAssetId, 'butterfly_fade_fn');
  assert.equal(draft.wantCategory, 'karambit');
  assert.equal(draft.maxCycleLength, 4);
  assert.deepEqual(defaultComposerDraft({ acceptableWear: draft.acceptableWear }).acceptableWear, ['FN', 'MW']);
});
