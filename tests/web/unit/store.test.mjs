import test from 'node:test';
import assert from 'node:assert/strict';

import { CACHE_BOUNDARIES, createMarketplaceStore } from '../../../client/marketplace/src/state/store.mjs';

test('store enforces cache boundaries and ttl freshness', () => {
  let nowMs = 1_000;
  const store = createMarketplaceStore({ now: () => nowMs });

  assert.ok(CACHE_BOUNDARIES.health);
  assert.ok(CACHE_BOUNDARIES.inventoryAwakening);
  assert.ok(CACHE_BOUNDARIES.intents);
  assert.ok(CACHE_BOUNDARIES.proposals);

  store.setSingletonCache('health', { ok: true });
  assert.deepEqual(store.getFreshSingleton('health'), { ok: true });

  store.setCollectionCache('intents', [{ id: 'intent_1' }]);
  assert.equal(store.getFreshCollection('intents').length, 1);

  store.setEntityCache('timeline', 'cycle_1', { cycleId: 'cycle_1', state: 'accepted' });
  assert.equal(store.getFreshEntity('timeline', 'cycle_1').state, 'accepted');

  nowMs += 20_000;
  assert.equal(store.getFreshSingleton('health'), null);
});

test('store rejects unknown tabs and unknown boundaries', () => {
  const store = createMarketplaceStore();

  assert.throws(() => store.setLoading('unknown', true), /unknown tab/);
  assert.throws(() => store.setCollectionCache('unknown', []), /unknown cache boundary/);
});

test('store tracks composer and intent mutation ui state for intents flow', () => {
  const store = createMarketplaceStore();
  store.setSessionActorId('user_1');
  assert.equal(store.getState().session.actorId, 'user_1');
  store.setNetworkOnline(false);
  assert.equal(store.getState().network.online, false);

  store.openNotificationPrefs();
  assert.equal(store.getState().ui.notificationPrefs.isOpen, true);
  store.setNotificationPrefs({
    channels: { proposal: false, active: true, receipt: true },
    quietHours: { enabled: true, startHour: 23, endHour: 6 }
  });
  assert.equal(store.getState().ui.notificationPrefs.values.channels.proposal, false);
  store.closeNotificationPrefs();
  assert.equal(store.getState().ui.notificationPrefs.isOpen, false);

  store.openComposer({ mode: 'create', draft: { offeringAssetId: 'asset_1' } });
  assert.equal(store.getState().ui.composer.isOpen, true);

  store.setComposerValidationErrors({ wantCategory: 'required' });
  assert.equal(store.getState().ui.composer.errors.wantCategory, 'required');

  store.setIntentMutation('intent_1', { pending: true, kind: 'create' });
  assert.equal(store.getState().ui.intentMutations.intent_1.pending, true);

  store.clearIntentMutation('intent_1');
  assert.equal(store.getState().ui.intentMutations.intent_1, undefined);

  store.setProposalMutation('proposal_1', { pending: true, decision: 'accept' });
  assert.equal(store.getState().ui.proposalMutations.proposal_1.pending, true);

  store.clearProposalMutation('proposal_1');
  assert.equal(store.getState().ui.proposalMutations.proposal_1, undefined);

  store.setActiveMutation('cycle_1', { pending: true, action: 'confirm_deposit' });
  assert.equal(store.getState().ui.activeMutations.cycle_1.pending, true);

  store.clearActiveMutation('cycle_1');
  assert.equal(store.getState().ui.activeMutations.cycle_1, undefined);

  store.closeComposer();
  assert.equal(store.getState().ui.composer.isOpen, false);
});
