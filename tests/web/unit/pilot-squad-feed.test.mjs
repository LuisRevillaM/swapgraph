import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTabScreen } from '../../../client/marketplace/src/ui/screens.mjs';

function baseState(viewerActorId = 'u1') {
  return {
    route: { tab: 'items', params: {} },
    session: { actorId: viewerActorId },
    ui: {
      itemsSort: 'highest_demand',
      composer: { isOpen: false, mode: 'create', draft: null, errors: {}, submitting: false },
      notificationPrefs: {
        values: {
          channels: { proposal: true, active: true, receipt: true },
          quietHours: { enabled: true, startHour: 22, endHour: 7 }
        }
      }
    },
    caches: {
      inventoryAwakening: {
        value: {
          swappabilitySummary: {
            intentsTotal: 0,
            activeIntents: 0,
            cycleOpportunities: 0,
            averageConfidenceBps: 0
          },
          recommendedFirstIntents: []
        }
      },
      intents: { items: [] },
      proposals: { items: [] },
      health: { value: null },
      matchingRuns: {},
      timeline: {},
      receipts: {}
    }
  };
}

test('pilot squad feed shows everyone else items for selected account', () => {
  const html = renderTabScreen(baseState('u1'));
  assert.match(html, /Everyone else's items/);
  assert.match(html, /From Jesus/);
  assert.match(html, /From Edgar/);
  assert.match(html, /From Gabo/);
  assert.match(html, /From Luis/);
  assert.doesNotMatch(html, /From Javier/);
});
