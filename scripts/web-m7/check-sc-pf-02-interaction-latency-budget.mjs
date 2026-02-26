#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildActiveTimelineModel } from '../../client/marketplace/src/features/active/timeline.mjs';
import { rankInboxCards } from '../../client/marketplace/src/features/inbox/proposals.mjs';
import { interactionBudgetResult } from '../../client/marketplace/src/features/performance/budgets.mjs';
import { renderTabScreen } from '../../client/marketplace/src/ui/screens.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'artifacts/web-m7/sc-pf-02-interaction-latency-budget-report.json');

function measureSamples(fn, iterations = 30) {
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  return samples;
}

function makeProposal(index) {
  return {
    id: `proposal_${index}`,
    expiresAt: `2026-02-24T${String(10 + (index % 10)).padStart(2, '0')}:00:00.000Z`,
    confidenceScore: 0.5 + ((index % 40) / 100),
    valueSpread: (index % 12) - 4,
    explainability: ['value_delta', 'confidence', 'constraint_fit'],
    participants: [
      {
        intentId: 'intent_user',
        actor: { type: 'user', id: 'user_1' },
        give: [{ assetId: `give_${index}`, label: `Give ${index}`, wear: 'MW', valueUsd: 100 + index }],
        get: [{ assetId: `get_${index}`, label: `Get ${index}`, wear: 'FT', valueUsd: 102 + index }]
      }
    ]
  };
}

function baseTimeline() {
  return {
    cycleId: 'cycle_bench',
    state: 'escrow.pending',
    updatedAt: '2026-02-24T11:00:00.000Z',
    legs: [
      {
        legId: 'leg_1',
        intentId: 'intent_user',
        fromActor: { type: 'user', id: 'user_1' },
        toActor: { type: 'user', id: 'user_2' },
        assets: [{ assetId: 'asset_1', valueUsd: 120 }],
        status: 'pending',
        depositDeadlineAt: '2026-02-24T18:00:00.000Z',
        depositMode: 'deposit'
      }
    ]
  };
}

function baseRenderState(proposals, intents) {
  return {
    network: { online: true },
    route: { tab: 'inbox', params: {} },
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
      intents: { items: intents, updatedAt: 0 },
      proposals: { items: proposals, updatedAt: 0 },
      matchingRuns: {},
      timeline: {},
      receipts: {}
    }
  };
}

function summarize(name, samples) {
  const budget = interactionBudgetResult(samples);
  return {
    operation: name,
    sample_count: budget.sampleCount,
    p95_ms: Number(budget.p95Ms.toFixed(2)),
    max_ms: Number(Math.max(...samples).toFixed(2)),
    min_ms: Number(Math.min(...samples).toFixed(2)),
    pass: budget.pass
  };
}

function main() {
  const intents = Array.from({ length: 80 }, (_, index) => ({
    id: index === 0 ? 'intent_user' : `intent_${index}`,
    actor: { type: 'user', id: index === 0 ? 'user_1' : `user_${index + 1}` }
  }));
  const proposals = Array.from({ length: 160 }, (_, index) => makeProposal(index + 1));

  const rankSamples = measureSamples(() => {
    rankInboxCards({
      proposals,
      intents,
      nowMs: Date.parse('2026-02-24T12:00:00.000Z')
    });
  }, 35);

  const timelineSamples = measureSamples(() => {
    buildActiveTimelineModel({
      timeline: baseTimeline(),
      intents,
      viewerActorIdHint: 'user_1'
    });
  }, 35);

  const renderState = baseRenderState(proposals, intents);
  const renderSamples = measureSamples(() => {
    renderTabScreen(renderState);
  }, 25);

  const rows = [
    summarize('rank_inbox_cards', rankSamples),
    summarize('build_active_timeline_model', timelineSamples),
    summarize('render_inbox_screen', renderSamples)
  ];

  const output = {
    check_id: 'SC-PF-02',
    generated_at: new Date().toISOString(),
    rows,
    pass: rows.every(row => row.pass)
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
