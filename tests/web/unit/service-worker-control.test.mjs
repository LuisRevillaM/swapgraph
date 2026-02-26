import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SW_MODE_STORAGE_KEY,
  disableServiceWorkerForRollback,
  serviceWorkerMode
} from '../../../client/marketplace/src/app/serviceWorkerControl.mjs';

test('serviceWorkerMode prioritizes query override then storage mode', () => {
  const byQuery = serviceWorkerMode({
    location: { search: '?sw=off' },
    localStorage: { getItem: () => 'on' }
  });
  assert.equal(byQuery, 'off');

  const byStorage = serviceWorkerMode({
    location: { search: '' },
    localStorage: { getItem: key => (key === SW_MODE_STORAGE_KEY ? 'off' : null) }
  });
  assert.equal(byStorage, 'off');

  const defaultMode = serviceWorkerMode({
    location: { search: '' },
    localStorage: { getItem: () => null }
  });
  assert.equal(defaultMode, 'on');
});

test('disableServiceWorkerForRollback unregisters workers and clears shell caches', async () => {
  const state = {
    registrations: 0,
    deleted: []
  };

  const out = await disableServiceWorkerForRollback({
    navigator: {
      serviceWorker: {
        getRegistrations: async () => [
          { unregister: async () => { state.registrations += 1; return true; } },
          { unregister: async () => false }
        ]
      }
    },
    caches: {
      keys: async () => ['swapgraph-marketplace-shell-v1', 'other-cache'],
      delete: async key => {
        state.deleted.push(key);
        return true;
      }
    }
  });

  assert.equal(out.mode, 'off');
  assert.equal(out.unregistered, 1);
  assert.equal(out.cachesCleared, 1);
  assert.deepEqual(state.deleted, ['swapgraph-marketplace-shell-v1']);
});
