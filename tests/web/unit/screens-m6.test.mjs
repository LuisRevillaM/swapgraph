import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTabScreen } from '../../../client/marketplace/src/ui/screens.mjs';

function baseState() {
  return {
    network: { online: true },
    route: { tab: 'items', params: {} },
    ui: {
      itemsSort: 'highest_demand',
      composer: { isOpen: false, mode: 'create', draft: null, errors: {}, submitting: false },
      notificationPrefs: {
        isOpen: false,
        values: {
          channels: { proposal: true, active: true, receipt: true },
          quietHours: { enabled: true, startHour: 22, endHour: 7 }
        }
      },
      intentMutations: {},
      proposalMutations: {},
      activeMutations: {}
    },
    caches: {
      inventoryAwakening: {
        value: {
          swappabilitySummary: {
            intentsTotal: 3,
            activeIntents: 2,
            cycleOpportunities: 5,
            averageConfidenceBps: 9100
          }
        }
      },
      intents: { items: [{ id: 'intent_1', offer: [{ assetId: 'asset_a', valueUsd: 100 }] }] },
      proposals: { items: [] },
      health: { value: null },
      matchingRuns: {},
      timeline: {},
      receipts: {}
    }
  };
}

test('items screen shows notification controls summary', () => {
  const html = renderTabScreen(baseState());
  assert.match(html, /Notification controls/);
  assert.match(html, /quiet hours/i);
  assert.match(html, /data-action=\"notifications.openPrefs\"/);
});

test('notification preferences overlay renders channel and quiet-hour controls', () => {
  const state = baseState();
  state.ui.notificationPrefs.isOpen = true;

  const html = renderTabScreen(state);
  assert.match(html, /Notification preferences/);
  assert.match(html, /data-form=\"notification-preferences\"/);
  assert.match(html, /channel_proposal/);
  assert.match(html, /quiet_start_hour/);
  assert.match(html, /data-action=\"notifications.closePrefs\"/);
});

