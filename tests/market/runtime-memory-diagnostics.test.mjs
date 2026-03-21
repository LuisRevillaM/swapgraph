import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hotPathLabel,
  memoryDelta,
  parseRuntimeMemoryOptions,
  shouldRejectForMemoryGuard,
  snapshotRuntimeMemory
} from '../../src/server/runtimeMemoryDiagnostics.mjs';

test('runtime memory options parse diagnostics and guard settings', () => {
  const options = parseRuntimeMemoryOptions({
    MARKET_RUNTIME_MEMORY_DIAGNOSTICS: '1',
    MARKET_RUNTIME_MEMORY_GUARD_RSS_MB: '640',
    MARKET_RUNTIME_MEMORY_LOG_THRESHOLD_MS: '850'
  });

  assert.deepEqual(options, {
    diagnosticsEnabled: true,
    rssGuardMb: 640,
    logThresholdMs: 850
  });
});

test('hot path labels identify compute-heavy market routes', () => {
  assert.equal(hotPathLabel('POST', '/market/candidates/compute'), 'market_candidates_compute');
  assert.equal(hotPathLabel('POST', '/market/execution-plans/from-candidate/candidate_123'), 'market_execution_plan_create');
  assert.equal(hotPathLabel('POST', '/market/deals/from-edge/edge_123'), 'market_deal_create');
  assert.equal(hotPathLabel('GET', '/market/stats'), null);
});

test('memory snapshots and guard decisions are deterministic', () => {
  const before = snapshotRuntimeMemory({
    rss: 500 * 1024 * 1024,
    heapTotal: 200 * 1024 * 1024,
    heapUsed: 150 * 1024 * 1024,
    external: 10 * 1024 * 1024,
    arrayBuffers: 2 * 1024 * 1024
  });
  const after = snapshotRuntimeMemory({
    rss: 560 * 1024 * 1024,
    heapTotal: 210 * 1024 * 1024,
    heapUsed: 175 * 1024 * 1024,
    external: 12 * 1024 * 1024,
    arrayBuffers: 2 * 1024 * 1024
  });

  assert.equal(before.rss_mb, 500);
  assert.equal(after.heap_used_mb, 175);
  assert.deepEqual(memoryDelta(before, after), {
    rss_mb: 60,
    heap_used_mb: 25,
    external_mb: 2
  });
  assert.equal(shouldRejectForMemoryGuard({ rssMb: before.rss_mb, rssGuardMb: 480 }), true);
  assert.equal(shouldRejectForMemoryGuard({ rssMb: before.rss_mb, rssGuardMb: 640 }), false);
});
