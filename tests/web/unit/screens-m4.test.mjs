import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTabScreen } from '../../../client/marketplace/src/ui/screens.mjs';

function baseTimeline(state = 'escrow.pending') {
  return {
    cycleId: 'cycle_1',
    state,
    updatedAt: '2026-02-24T10:00:00.000Z',
    legs: [
      {
        legId: 'leg_user',
        intentId: 'intent_1',
        fromActor: { type: 'user', id: 'user_1' },
        toActor: { type: 'user', id: 'user_2' },
        assets: [{ assetId: 'asset_1', valueUsd: 110 }],
        status: state === 'completed' ? 'released' : 'pending',
        depositDeadlineAt: '2026-02-24T18:00:00.000Z',
        depositMode: 'deposit'
      },
      {
        legId: 'leg_other',
        intentId: 'intent_2',
        fromActor: { type: 'user', id: 'user_2' },
        toActor: { type: 'user', id: 'user_1' },
        assets: [{ assetId: 'asset_2', valueUsd: 109 }],
        status: state === 'completed' ? 'released' : 'pending',
        depositDeadlineAt: '2026-02-24T18:00:00.000Z',
        depositMode: 'deposit'
      }
    ]
  };
}

function baseState() {
  return {
    session: { actorId: 'user_1' },
    route: { tab: 'active', params: { cycleId: 'cycle_1' } },
    ui: {
      itemsSort: 'highest_demand',
      composer: { isOpen: false, mode: 'create', draft: null, errors: {}, submitting: false },
      intentMutations: {},
      proposalMutations: {},
      activeMutations: {}
    },
    caches: {
      inventoryAwakening: { value: null },
      intents: { items: [{ id: 'intent_1', actor: { type: 'user', id: 'user_1' } }] },
      proposals: { items: [] },
      health: { value: null },
      matchingRuns: {},
      timeline: {
        cycle_1: {
          value: baseTimeline('escrow.pending')
        }
      },
      receipts: {}
    }
  };
}

test('active screen renders status/progress/actions/timeline for selected cycle', () => {
  const html = renderTabScreen(baseState());

  assert.match(html, /Settlement Timeline/);
  assert.match(html, /Your deposit is required/);
  assert.match(html, /data-action="active\.confirmDeposit"/);
  assert.match(html, /data-cycle-id="cycle_1"/);
  assert.match(html, /Timeline events/);
});

test('active screen renders fallback when no cycle is selected or cached', () => {
  const noCycle = baseState();
  noCycle.route.params = {};
  const noCycleHtml = renderTabScreen(noCycle);
  assert.match(noCycleHtml, /No active cycle selected/);

  const noTimeline = baseState();
  noTimeline.caches.timeline = {};
  const noTimelineHtml = renderTabScreen(noTimeline);
  assert.match(noTimelineHtml, /Timeline unavailable/);
  assert.match(noTimelineHtml, /data-action="active\.refreshCycle"/);
});

test('active screen reflects action mutation progress and error state copy', () => {
  const pendingState = baseState();
  pendingState.ui.activeMutations.cycle_1 = {
    pending: true,
    action: 'confirm_deposit',
    error: null
  };

  const pendingHtml = renderTabScreen(pendingState);
  assert.match(pendingHtml, /Confirming deposit\.\.\./);
  assert.match(pendingHtml, /Submitting action\.\.\./);

  const failedState = baseState();
  failedState.ui.activeMutations.cycle_1 = {
    pending: false,
    action: 'confirm_deposit',
    error: 'FORBIDDEN'
  };

  const failedHtml = renderTabScreen(failedState);
  assert.match(failedHtml, /Last attempt failed: FORBIDDEN/);
});
