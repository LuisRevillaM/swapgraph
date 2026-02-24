import test from 'node:test';
import assert from 'node:assert/strict';

import {
  actorIdFromLocationSearch,
  loadOrCreateActorId
} from '../../../client/marketplace/src/session/actorIdentity.mjs';

function createMemoryStorage(initial = {}) {
  const state = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return state.has(key) ? state.get(key) : null;
    },
    setItem(key, value) {
      state.set(key, String(value));
    }
  };
}

test('actor id query parser accepts actor_id and actor aliases', () => {
  assert.equal(actorIdFromLocationSearch('?actor_id=u1'), 'u1');
  assert.equal(actorIdFromLocationSearch('?actor=u2'), 'u2');
  assert.equal(actorIdFromLocationSearch('?actor_id=bad%20id'), null);
});

test('query actor id overrides storage and is persisted', () => {
  const storage = createMemoryStorage({
    'swapgraph.marketplace.actor_id': 'web_user_saved'
  });

  const actorId = loadOrCreateActorId({
    storage,
    locationSearch: '?actor_id=u3'
  });

  assert.equal(actorId, 'u3');
  assert.equal(storage.getItem('swapgraph.marketplace.actor_id'), 'u3');
});

test('stored actor id is reused when query is missing', () => {
  const storage = createMemoryStorage({
    'swapgraph.marketplace.actor_id': 'u4'
  });

  const actorId = loadOrCreateActorId({
    storage,
    locationSearch: ''
  });

  assert.equal(actorId, 'u4');
});

test('invalid query id falls back to generated actor id', () => {
  const storage = createMemoryStorage();
  const actorId = loadOrCreateActorId({
    storage,
    locationSearch: '?actor_id=bad%20id'
  });

  assert.match(actorId, /^web_user_/);
  assert.equal(storage.getItem('swapgraph.marketplace.actor_id'), actorId);
});
