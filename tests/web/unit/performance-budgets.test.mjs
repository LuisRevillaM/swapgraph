import test from 'node:test';
import assert from 'node:assert/strict';

import {
  interactionBudgetResult,
  longListBudgetResult,
  percentile,
  startupBudgetResult
} from '../../../client/marketplace/src/features/performance/budgets.mjs';
import { LONG_LIST_RENDER_LIMIT, clampListForRender } from '../../../client/marketplace/src/features/performance/listBudget.mjs';

test('performance budget helpers evaluate startup/interaction/long-list constraints', () => {
  const startup = startupBudgetResult({
    scriptBytes: 120_000,
    styleBytes: 21_000,
    totalBytes: 180_000
  });
  assert.equal(startup.pass, true);

  const interaction = interactionBudgetResult([11, 12, 14, 19, 21, 35]);
  assert.equal(interaction.pass, true);
  assert.equal(interaction.sampleCount, 6);

  const longList = longListBudgetResult(44);
  assert.equal(longList.pass, true);
});

test('percentile and list clamping preserve deterministic limits', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 95), 5);

  const rows = Array.from({ length: LONG_LIST_RENDER_LIMIT + 8 }, (_, index) => index);
  const clipped = clampListForRender(rows);
  assert.equal(clipped.rows.length, LONG_LIST_RENDER_LIMIT);
  assert.equal(clipped.truncatedCount, 8);
  assert.equal(clipped.totalCount, LONG_LIST_RENDER_LIMIT + 8);
});
