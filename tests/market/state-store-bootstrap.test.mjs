import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { JsonStateStore } from '../../src/store/jsonStateStore.mjs';
import { createStateStore } from '../../src/store/createStateStore.mjs';
import { maybeBootstrapStateMigration } from '../../src/store/stateStoreBootstrap.mjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'swapgraph-bootstrap-'));
}

test('bootstrap migration skips when disabled', () => {
  const tmp = makeTempDir();
  const targetPath = path.join(tmp, 'runtime-api-state.sqlite');
  const result = maybeBootstrapStateMigration({
    env: {},
    rootDir: tmp,
    stateBackend: 'sqlite',
    storePath: targetPath
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'bootstrap_disabled');
});

test('bootstrap migration skips for non-sqlite target', () => {
  const tmp = makeTempDir();
  const targetPath = path.join(tmp, 'runtime-api-state.json');
  const result = maybeBootstrapStateMigration({
    env: { STATE_BOOTSTRAP_MIGRATION: '1' },
    rootDir: tmp,
    stateBackend: 'json',
    storePath: targetPath
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'target_backend_not_sqlite');
});

test('bootstrap migration copies json state into sqlite when enabled', (t) => {
  const tmp = makeTempDir();
  const jsonPath = path.join(tmp, 'runtime-api-state.json');
  const sqlitePath = path.join(tmp, 'runtime-api-state.sqlite');

  const jsonStore = new JsonStateStore({ filePath: jsonPath });
  jsonStore.state.receipts.receipt_001 = {
    receipt_id: 'receipt_001',
    state: 'completed'
  };
  jsonStore.state.events.push({ event_id: 'evt_001' });
  jsonStore.save();

  let result;
  try {
    result = maybeBootstrapStateMigration({
      env: {
        STATE_BOOTSTRAP_MIGRATION: '1',
        STATE_BOOTSTRAP_FROM_BACKEND: 'json',
        STATE_BOOTSTRAP_FROM_STATE_FILE: jsonPath
      },
      rootDir: tmp,
      stateBackend: 'sqlite',
      storePath: sqlitePath
    });
  } catch (error) {
    if (error?.code === 'sqlite_unavailable') {
      t.skip('sqlite backend unavailable in this Node runtime');
      return;
    }
    throw error;
  }

  const sqliteStore = createStateStore({ backend: 'sqlite', filePath: sqlitePath });
  sqliteStore.load();
  assert.equal(result.skipped, false);
  assert.equal(sqliteStore.state.receipts.receipt_001.state, 'completed');
  assert.equal(sqliteStore.state.events.length, 1);
  if (typeof sqliteStore.close === 'function') sqliteStore.close();
});

test('bootstrap migration skips when target already exists', () => {
  const tmp = makeTempDir();
  const sqlitePath = path.join(tmp, 'runtime-api-state.sqlite');
  fs.writeFileSync(sqlitePath, '');
  const result = maybeBootstrapStateMigration({
    env: { STATE_BOOTSTRAP_MIGRATION: '1' },
    rootDir: tmp,
    stateBackend: 'sqlite',
    storePath: sqlitePath
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'target_exists');
});
