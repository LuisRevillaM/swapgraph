import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { JsonStateStore } from '../../src/store/jsonStateStore.mjs';

function createFilePath() {
  return `/tmp/swapgraph-json-state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
}

test('json state store recovers from empty persisted state by resetting and backing it up', () => {
  const filePath = createFilePath();
  writeFileSync(filePath, '');

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(String(message));

  try {
    const store = new JsonStateStore({ filePath });
    store.load();

    assert.deepEqual(store.state.market_listings, {});
    assert.deepEqual(store.state.market_candidates, {});
    assert.equal(store.state.market_listing_counter, 0);

    const repaired = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.deepEqual(repaired.market_listings, {});
    assert.equal(repaired.market_listing_counter, 0);

    const backupPath = warnings
      .map(message => message.match(/backup written to ([^;]+);/))
      .find(Boolean)?.[1];
    assert.ok(backupPath, 'expected corrupt backup path in warning');
    assert.equal(existsSync(backupPath), true);
    assert.equal(readFileSync(backupPath, 'utf8'), '');
  } finally {
    console.warn = originalWarn;
  }
});
