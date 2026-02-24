import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildItemCards,
  demandBannerModel,
  humanizeAssetId
} from '../../../client/marketplace/src/features/items/cards.mjs';

test('buildItemCards derives demand-first and tradable-first orderings', () => {
  const intents = [
    {
      id: 'intent_1',
      status: 'active',
      offer: [{ assetId: 'ak47_vulcan_mw', valueUsd: 210, wear: 'MW', label: 'AK-47 Vulcan' }]
    },
    {
      id: 'intent_2',
      status: 'active',
      offer: [{ assetId: 'm4a4_howl_ft', valueUsd: 1840, wear: 'FT', label: 'M4A4 Howl' }]
    }
  ];

  const projection = {
    swappabilitySummary: {
      intentsTotal: 2,
      activeIntents: 2,
      cycleOpportunities: 3,
      averageConfidenceBps: 9200
    },
    recommendedFirstIntents: [
      { suggestedGiveAssetId: 'm4a4_howl_ft' },
      { suggestedGiveAssetId: 'm4a4_howl_ft' },
      { suggestedGiveAssetId: 'ak47_vulcan_mw' }
    ]
  };

  const highest = buildItemCards({ intents, projection, sort: 'highest_demand' });
  assert.equal(highest.cards[0].assetId, 'm4a4_howl_ft');
  assert.equal(highest.cards[0].demandCount, 2);

  const tradable = buildItemCards({ intents, projection, sort: 'also_tradable' });
  assert.equal(tradable.cards[0].assetId, 'ak47_vulcan_mw');
  assert.equal(tradable.cards[0].demandCount, 1);
});

test('demand banner visibility follows cycle opportunities', () => {
  assert.equal(demandBannerModel({ swappabilitySummary: { cycleOpportunities: 2 } }).visible, true);
  assert.equal(demandBannerModel({ swappabilitySummary: { cycleOpportunities: 0 } }).visible, false);
});

test('humanizeAssetId normalizes ids into readable labels', () => {
  assert.equal(humanizeAssetId('steam:ak47_vulcan_mw'), 'Ak47 Vulcan Mw');
  assert.equal(humanizeAssetId('assetA'), 'Prompt Forge License');
});
