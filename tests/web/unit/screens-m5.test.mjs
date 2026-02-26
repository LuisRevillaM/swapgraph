import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTabScreen } from '../../../client/marketplace/src/ui/screens.mjs';

function baseState() {
  return {
    session: { actorId: 'user_1' },
    route: { tab: 'receipts', params: {} },
    ui: {
      itemsSort: 'highest_demand',
      composer: { isOpen: false, mode: 'create', draft: null, errors: {}, submitting: false },
      intentMutations: {},
      proposalMutations: {},
      activeMutations: {}
    },
    caches: {
      inventoryAwakening: { value: null },
      intents: { items: [] },
      proposals: { items: [] },
      health: { value: null },
      matchingRuns: {},
      timeline: {
        cycle_completed: {
          value: {
            cycleId: 'cycle_completed',
            state: 'completed',
            updatedAt: '2026-02-24T11:00:00.000Z',
            legs: [
              {
                legId: 'leg_1',
                fromActor: { type: 'user', id: 'user_1' },
                toActor: { type: 'user', id: 'user_2' },
                assets: [{ assetId: 'asset_1', valueUsd: 120 }]
              },
              {
                legId: 'leg_2',
                fromActor: { type: 'user', id: 'user_2' },
                toActor: { type: 'user', id: 'user_1' },
                assets: [{ assetId: 'asset_2', valueUsd: 132 }]
              }
            ]
          }
        },
        cycle_unwound: {
          value: {
            cycleId: 'cycle_unwound',
            state: 'failed',
            updatedAt: '2026-02-24T12:00:00.000Z',
            legs: [
              {
                legId: 'leg_3',
                fromActor: { type: 'user', id: 'user_1' },
                toActor: { type: 'user', id: 'user_3' },
                assets: [{ assetId: 'asset_3', valueUsd: 95 }]
              },
              {
                legId: 'leg_4',
                fromActor: { type: 'user', id: 'user_3' },
                toActor: { type: 'user', id: 'user_1' },
                assets: [{ assetId: 'asset_4', valueUsd: 95 }]
              }
            ]
          }
        }
      },
      receipts: {
        cycle_completed: {
          value: {
            id: 'receipt_completed',
            cycleId: 'cycle_completed',
            finalState: 'completed',
            createdAt: '2026-02-24T11:00:00.000Z',
            intentIds: ['intent_1', 'intent_2'],
            assetIds: ['asset_1', 'asset_2'],
            fees: [{ actor: { type: 'user', id: 'user_1' }, feeUsd: 1 }],
            liquidityProviderSummary: [],
            signature: { keyId: 'dev-k1', algorithm: 'ed25519', signature: 'abc123' },
            transparency: {}
          },
          updatedAt: Date.now()
        },
        cycle_unwound: {
          value: {
            id: 'receipt_unwound',
            cycleId: 'cycle_unwound',
            finalState: 'failed',
            createdAt: '2026-02-24T12:00:00.000Z',
            intentIds: ['intent_3', 'intent_4'],
            assetIds: ['asset_3', 'asset_4'],
            fees: [],
            liquidityProviderSummary: [],
            signature: { keyId: 'dev-k1', algorithm: 'ed25519', signature: 'def456' },
            transparency: { reasonCode: 'deposit_timeout' }
          },
          updatedAt: Date.now()
        },
        cycle_failed: {
          value: {
            id: 'receipt_failed',
            cycleId: 'cycle_failed',
            finalState: 'failed',
            createdAt: '2026-02-24T10:00:00.000Z',
            intentIds: ['intent_5'],
            assetIds: ['asset_5'],
            fees: [],
            liquidityProviderSummary: [],
            signature: { keyId: '', algorithm: '', signature: '' },
            transparency: { reasonCode: 'execution_error' }
          },
          updatedAt: Date.now()
        }
      }
    }
  };
}

test('receipts list renders status variants and metadata columns', () => {
  const html = renderTabScreen(baseState());
  assert.match(html, /Verified Records/);
  assert.match(html, /Completed/);
  assert.match(html, /Unwound/);
  assert.match(html, /Failed/);
  assert.match(html, /Type/);
  assert.match(html, /Verification/);
  assert.match(html, /Value delta/);
  assert.match(html, /data-action="receipts.openReceipt"/);
});

test('receipt detail renders verification and value outcome context', () => {
  const state = baseState();
  state.route.params = { receiptId: 'cycle_unwound' };

  const html = renderTabScreen(state);
  assert.match(html, /Verification metadata/);
  assert.match(html, /Value outcome context/);
  assert.match(html, /deposit_timeout/);
  assert.match(html, /data-action="receipt.backToList"/);
});

test('receipt detail fallback renders when selected receipt is missing', () => {
  const state = baseState();
  state.route.params = { receiptId: 'missing_cycle' };

  const html = renderTabScreen(state);
  assert.match(html, /Receipt unavailable/);
  assert.match(html, /Receipt not found/);
});
