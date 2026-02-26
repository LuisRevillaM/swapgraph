#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyCacheSnapshotToStore,
  createCacheSnapshot,
  hasCachedReadSurface
} from '../../client/marketplace/src/features/offline/cacheSnapshot.mjs';
import { createMarketplaceStore } from '../../client/marketplace/src/state/store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'artifacts/web-m6/sc-rl-01-offline-read-continuity-report.json');

function seedStore() {
  const store = createMarketplaceStore();

  store.setSingletonCache('inventoryAwakening', {
    swappabilitySummary: {
      intentsTotal: 3,
      activeIntents: 2,
      cycleOpportunities: 4,
      averageConfidenceBps: 9200
    }
  });
  store.setCollectionCache('intents', [{ id: 'intent_1' }, { id: 'intent_2' }]);
  store.setCollectionCache('proposals', [{ id: 'proposal_1' }]);
  store.setEntityCache('timeline', 'cycle_1', {
    cycleId: 'cycle_1',
    state: 'executing',
    updatedAt: '2026-02-24T15:00:00.000Z',
    legs: []
  });
  store.setEntityCache('receipts', 'cycle_1', {
    id: 'receipt_1',
    cycleId: 'cycle_1',
    finalState: 'completed',
    createdAt: '2026-02-24T16:00:00.000Z',
    signature: { keyId: 'dev-k1', algorithm: 'ed25519', signature: 'abc' }
  });

  return store;
}

function checkServiceWorker() {
  const swPath = path.join(repoRoot, 'client/marketplace/sw.js');
  const source = readFileSync(swPath, 'utf8');
  return {
    file: 'client/marketplace/sw.js',
    has_install_handler: /addEventListener\('install'/.test(source),
    has_activate_handler: /addEventListener\('activate'/.test(source),
    has_fetch_handler: /addEventListener\('fetch'/.test(source),
    has_precache_manifest: /PRECACHE_URLS/.test(source)
  };
}

function main() {
  const sourceStore = seedStore();
  const snapshot = createCacheSnapshot(sourceStore.getState());

  const restoredStore = createMarketplaceStore();
  const applied = applyCacheSnapshotToStore(restoredStore, snapshot);
  const restoredState = restoredStore.getState();

  const tabChecks = [
    { tab: 'items', params: {}, pass: hasCachedReadSurface(restoredState, 'items', {}) },
    { tab: 'intents', params: {}, pass: hasCachedReadSurface(restoredState, 'intents', {}) },
    { tab: 'inbox', params: {}, pass: hasCachedReadSurface(restoredState, 'inbox', {}) },
    { tab: 'active', params: { cycleId: 'cycle_1' }, pass: hasCachedReadSurface(restoredState, 'active', { cycleId: 'cycle_1' }) },
    { tab: 'receipts', params: { receiptId: 'cycle_1' }, pass: hasCachedReadSurface(restoredState, 'receipts', { receiptId: 'cycle_1' }) }
  ];

  const swCheck = checkServiceWorker();
  const swPass = swCheck.has_install_handler
    && swCheck.has_activate_handler
    && swCheck.has_fetch_handler
    && swCheck.has_precache_manifest;

  const output = {
    check_id: 'SC-RL-01',
    generated_at: new Date().toISOString(),
    snapshot_applied: applied,
    core_tab_checks: tabChecks,
    service_worker: swCheck,
    pass: applied && tabChecks.every(row => row.pass) && swPass
  };

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');

  if (!output.pass) {
    process.stderr.write(JSON.stringify(output, null, 2) + '\n');
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main();
