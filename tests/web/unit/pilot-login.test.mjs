import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveActivePilotActorId } from '../../../client/marketplace/src/session/pilotLogin.mjs';
import { SESSION_ACTOR_STORAGE_KEY } from '../../../client/marketplace/src/session/actorIdentity.mjs';

function createMemoryStorage(initial = {}) {
  const state = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return state.has(key) ? state.get(key) : null;
    },
    setItem(key, value) {
      state.set(key, String(value));
    },
    removeItem(key) {
      state.delete(key);
    }
  };
}

test('resolveActivePilotActorId prioritizes valid query actor and persists it', () => {
  const storage = createMemoryStorage({ [SESSION_ACTOR_STORAGE_KEY]: 'u5' });
  const actorId = resolveActivePilotActorId({
    storage,
    locationSearch: '?actor_id=u2'
  });
  assert.equal(actorId, 'u2');
  assert.equal(storage.getItem(SESSION_ACTOR_STORAGE_KEY), 'u2');
});

test('resolveActivePilotActorId reuses valid stored actor', () => {
  const storage = createMemoryStorage({ [SESSION_ACTOR_STORAGE_KEY]: 'u4' });
  const actorId = resolveActivePilotActorId({
    storage,
    locationSearch: ''
  });
  assert.equal(actorId, 'u4');
});

test('resolveActivePilotActorId clears non-pilot actors and requires login', () => {
  const storage = createMemoryStorage({ [SESSION_ACTOR_STORAGE_KEY]: 'web_user_123' });
  const actorId = resolveActivePilotActorId({
    storage,
    locationSearch: '?actor_id=web_user_123'
  });
  assert.equal(actorId, null);
  assert.equal(storage.getItem(SESSION_ACTOR_STORAGE_KEY), null);
});

