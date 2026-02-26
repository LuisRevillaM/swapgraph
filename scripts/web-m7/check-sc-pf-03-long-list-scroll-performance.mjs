#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LONG_LIST_RENDER_LIMIT } from '../../client/marketplace/src/features/performance/listBudget.mjs';
import { longListBudgetResult } from '../../client/marketplace/src/features/performance/budgets.mjs';
import { renderTabScreen } from '../../client/marketplace/src/ui/screens.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'artifacts/web-m7/sc-pf-03-long-list-scroll-performance-report.json');

function longListState(receiptCount = 500) {
  const receipts = {};
  for (let index = 0; index < receiptCount; index += 1) {
    const cycleId = `cycle_${index + 1}`;
    receipts[cycleId] = {
      value: {
        id: `receipt_${index + 1}`,
        cycleId,
        finalState: index % 3 === 0 ? 'failed' : 'completed',
        createdAt: '2026-02-24T12:00:00.000Z',
        intentIds: [],
        assetIds: [],
        fees: [],
        liquidityProviderSummary: [],
        transparency: index % 3 === 0 ? { reasonCode: 'deposit_timeout' } : {},
        signature: {
          keyId: 'k1',
          algorithm: 'ed25519',
          signature: 'sig'
        }
      },
      updatedAt: Date.now() - index
    };
  }

  return {
    session: { actorId: 'user_1' },
    network: { online: true },
    route: { tab: 'receipts', params: {} },
    ui: {
      itemsSort: 'highest_demand',
      composer: { isOpen: false, mode: 'create', draft: null, errors: {}, submitting: false },
      notificationPrefs: {
        isOpen: false,
        values: {
          channels: { proposal: true, active: true, receipt: true },
          quietHours: { enabled: false, startHour: 22, endHour: 7 }
        }
      },
      intentMutations: {},
      proposalMutations: {},
      activeMutations: {}
    },
    caches: {
      health: { value: null, updatedAt: 0 },
      inventoryAwakening: { value: null, updatedAt: 0 },
      intents: { items: [], updatedAt: 0 },
      proposals: { items: [], updatedAt: 0 },
      matchingRuns: {},
      timeline: {},
      receipts
    }
  };
}

function main() {
  const state = longListState(500);
  const started = performance.now();
  const html = renderTabScreen(state);
  const durationMs = performance.now() - started;
  const budget = longListBudgetResult(durationMs);

  const renderedCardCount = (html.match(/data-action="receipts\.openReceipt"/g) ?? []).length;
  const checklist = [
    {
      id: 'render_is_clamped_for_long_lists',
      pass: renderedCardCount <= LONG_LIST_RENDER_LIMIT
    },
    {
      id: 'truncation_notice_present',
      pass: /Showing first/.test(html)
    },
    {
      id: 'long_list_render_duration_within_budget',
      pass: budget.pass
    }
  ];

  const output = {
    check_id: 'SC-PF-03',
    generated_at: new Date().toISOString(),
    long_list_size: 500,
    rendered_cards: renderedCardCount,
    render_limit: LONG_LIST_RENDER_LIMIT,
    duration_ms: Number(durationMs.toFixed(2)),
    budget,
    checklist,
    pass: checklist.every(row => row.pass)
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
