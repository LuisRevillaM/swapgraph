import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTabScreen } from '../../../client/marketplace/src/ui/screens.mjs';

function baseState() {
  return {
    route: { tab: 'items', params: {} },
    ui: {
      itemsSort: 'highest_demand',
      composer: { isOpen: false, mode: 'create', draft: null, errors: {}, submitting: false },
      intentMutations: {}
    },
    caches: {
      inventoryAwakening: {
        value: {
          swappabilitySummary: {
            intentsTotal: 1,
            activeIntents: 1,
            cycleOpportunities: 2,
            averageConfidenceBps: 9000
          },
          recommendedFirstIntents: [
            {
              recommendationId: 'rec_1',
              cycleId: 'cycle_1',
              suggestedGiveAssetId: 'asset_a',
              suggestedGetAssetId: 'asset_b',
              confidenceBps: 9200,
              rationale: 'fit'
            }
          ]
        }
      },
      intents: {
        items: [
          {
            id: 'intent_1',
            status: 'active',
            offer: [{ assetId: 'asset_a', valueUsd: 120, wear: 'MW', label: 'Asset A' }],
            wantSpec: { anyOf: [{ type: 'category', category: 'knife' }] },
            valueBand: { minUsd: 80, maxUsd: 160 },
            trustConstraints: { maxCycleLength: 3 },
            settlementPreferences: { requireEscrow: true }
          }
        ]
      },
      proposals: {
        items: [
          { id: 'p1', participants: [{ intentId: 'intent_1' }] }
        ]
      },
      health: { value: null },
      matchingRuns: {},
      timeline: {},
      receipts: {}
    }
  };
}

test('items screen renders demand banner, sort controls, and item cards', () => {
  const state = baseState();
  state.route.tab = 'items';

  const html = renderTabScreen(state);
  assert.match(html, /Inventory Awakening/);
  assert.match(html, /data-action="items.openInbox"/);
  assert.match(html, /data-action="items.sort"/);
  assert.match(html, /Asset A/);
});

test('intents screen renders explicit matched state and composer overlay', () => {
  const state = baseState();
  state.route.tab = 'intents';
  state.ui.composer = {
    isOpen: true,
    mode: 'create',
    draft: {
      offeringAssetId: 'asset_a',
      offerValueUsd: 120,
      wantCategory: 'knife',
      acceptableWear: ['MW'],
      valueToleranceUsd: 50,
      maxCycleLength: 3
    },
    errors: { wantCategory: 'Want target is required.' },
    submitting: false
  };

  const html = renderTabScreen(state);
  assert.match(html, /Matched · 1 proposal waiting/);
  assert.match(html, /data-form="intent-composer"/);
  assert.match(html, /Want target is required/);
});
