import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyCacheSnapshotToStore,
  createCacheSnapshot,
  hasCachedReadSurface,
  staleBannerCopy
} from '../../../client/marketplace/src/features/offline/cacheSnapshot.mjs';
import { createMarketplaceStore } from '../../../client/marketplace/src/state/store.mjs';

function seedStore() {
  const store = createMarketplaceStore();
  store.setSingletonCache('inventoryAwakening', {
    swappabilitySummary: { activeIntents: 2, cycleOpportunities: 3, averageConfidenceBps: 9200 }
  });
  store.setCollectionCache('intents', [{ id: 'intent_1' }]);
  store.setCollectionCache('proposals', [{ id: 'proposal_1' }]);
  store.setEntityCache('timeline', 'cycle_1', { cycleId: 'cycle_1', state: 'executing', legs: [] });
  store.setEntityCache('receipts', 'cycle_1', { id: 'receipt_1', cycleId: 'cycle_1', finalState: 'completed' });
  return store;
}

test('create/apply cache snapshot preserves core read surfaces', () => {
  const source = seedStore();
  const snapshot = createCacheSnapshot(source.getState());
  const restored = createMarketplaceStore();

  const applied = applyCacheSnapshotToStore(restored, snapshot);
  assert.equal(applied, true);

  const restoredState = restored.getState();
  assert.equal(restoredState.caches.intents.items.length, 1);
  assert.equal(restoredState.caches.proposals.items.length, 1);
  assert.equal(restoredState.caches.timeline.cycle_1.value.state, 'executing');
  assert.equal(restoredState.caches.receipts.cycle_1.value.id, 'receipt_1');
});

test('hasCachedReadSurface reports continuity coverage for core tabs', () => {
  const snapshot = seedStore().getState();

  assert.equal(hasCachedReadSurface(snapshot, 'items', {}), true);
  assert.equal(hasCachedReadSurface(snapshot, 'intents', {}), true);
  assert.equal(hasCachedReadSurface(snapshot, 'inbox', {}), true);
  assert.equal(hasCachedReadSurface(snapshot, 'active', { cycleId: 'cycle_1' }), true);
  assert.equal(hasCachedReadSurface(snapshot, 'receipts', { receiptId: 'cycle_1' }), true);
});

test('staleBannerCopy reflects offline stale signaling states', () => {
  const offlineHit = staleBannerCopy({
    tab: 'inbox',
    offline: true,
    hasCache: true,
    savedAtMs: Date.parse('2026-02-24T12:00:00.000Z')
  });
  assert.equal(offlineHit.tone, 'caution');
  assert.match(offlineHit.message, /stale/i);

  const offlineMiss = staleBannerCopy({
    tab: 'active',
    offline: true,
    hasCache: false
  });
  assert.equal(offlineMiss.tone, 'caution');
  assert.match(offlineMiss.message, /No cached active data/i);
});

