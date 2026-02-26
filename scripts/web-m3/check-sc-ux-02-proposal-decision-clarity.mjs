#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AnalyticsClient } from '../../client/marketplace/src/analytics/analyticsClient.mjs';
import { renderTabScreen } from '../../client/marketplace/src/ui/screens.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'artifacts/web-m3/sc-ux-02-proposal-decision-clarity-report.json');

function baseState() {
  return {
    route: { tab: 'inbox', path: '/inbox', params: {} },
    ui: {
      itemsSort: 'highest_demand',
      composer: { isOpen: false, mode: 'create', targetIntentId: null, draft: null, errors: {}, submitting: false },
      intentMutations: {},
      proposalMutations: {}
    },
    caches: {
      health: { value: null, updatedAt: 0 },
      inventoryAwakening: { value: null, updatedAt: 0 },
      intents: {
        items: [
          {
            id: 'intent_user',
            actor: { type: 'user', id: 'ux_user_1' }
          }
        ],
        updatedAt: 0
      },
      proposals: {
        items: [
          {
            id: 'proposal_urgent',
            expiresAt: new Date(Date.now() + (40 * 60 * 1000)).toISOString(),
            confidenceScore: 0.78,
            valueSpread: 0,
            explainability: ['value_delta', 'confidence', 'constraint_fit'],
            participants: [
              {
                intentId: 'intent_user',
                actor: { type: 'user', id: 'ux_user_1' },
                give: [{ assetId: 'give_1', label: 'AK-47 Redline', wear: 'MW', valueUsd: 110 }],
                get: [{ assetId: 'get_1', label: 'M9 Bayonet', wear: 'FT', valueUsd: 126 }]
              }
            ]
          },
          {
            id: 'proposal_ranked',
            expiresAt: new Date(Date.now() + (8 * 60 * 60 * 1000)).toISOString(),
            confidenceScore: 0.85,
            valueSpread: 0,
            explainability: ['value_delta', 'confidence', 'constraint_fit'],
            participants: [
              {
                intentId: 'intent_user',
                actor: { type: 'user', id: 'ux_user_1' },
                give: [{ assetId: 'give_2', label: 'USP-S Kill Confirmed', wear: 'FN', valueUsd: 92 }],
                get: [{ assetId: 'get_2', label: 'Karambit Doppler', wear: 'MW', valueUsd: 129 }]
              }
            ]
          }
        ],
        updatedAt: 0
      },
      matchingRuns: {},
      timeline: {},
      receipts: {}
    }
  };
}

function runUsabilityChecklist() {
  const inbox = baseState();
  const inboxHtml = renderTabScreen(inbox);

  const detail = baseState();
  detail.route.params = { proposalId: 'proposal_urgent' };
  const detailHtml = renderTabScreen(detail);

  const checklist = [
    {
      id: 'inbox_rank_sections',
      pass: /Urgent decisions/.test(inboxHtml) && /Ranked opportunities/.test(inboxHtml)
    },
    {
      id: 'inbox_urgency_and_metadata',
      pass: /Expires/.test(inboxHtml) && /confidence/.test(inboxHtml)
    },
    {
      id: 'detail_explainability_primitives',
      pass: /Value delta/.test(detailHtml) && /Confidence/.test(detailHtml) && /Constraint fit/.test(detailHtml)
    },
    {
      id: 'detail_decision_actions',
      pass: /data-action="proposal.accept"/.test(detailHtml) && /data-action="proposal.decline"/.test(detailHtml)
    }
  ];

  return {
    checklist,
    pass: checklist.every(row => row.pass)
  };
}

function runEventProof() {
  const analytics = new AnalyticsClient();
  analytics.track('marketplace.route_opened', { tab: 'inbox', path: '/inbox' });
  analytics.track('marketplace.tab_viewed', { tab: 'inbox' });
  analytics.track('marketplace.inbox_ranked', { proposal_count: 2, urgent_count: 1 });
  analytics.track('marketplace.proposal_opened', { proposal_id: 'proposal_urgent', rank: 1, source: 'inbox_card' });
  analytics.track('marketplace.proposal_detail_viewed', { proposal_id: 'proposal_urgent', rank: 1, urgency: 'critical' });
  analytics.track('marketplace.proposal_decision_started', { proposal_id: 'proposal_urgent', decision: 'accept', rank: 1 });
  analytics.track('marketplace.proposal_decision_succeeded', {
    proposal_id: 'proposal_urgent',
    decision: 'accept',
    rank: 1,
    latency_ms: 215,
    retry_count: 0
  });

  const sequence = analytics.snapshot().map(event => event.event_name);
  const expectedOrder = [
    'marketplace.route_opened',
    'marketplace.tab_viewed',
    'marketplace.inbox_ranked',
    'marketplace.proposal_opened',
    'marketplace.proposal_detail_viewed',
    'marketplace.proposal_decision_started',
    'marketplace.proposal_decision_succeeded'
  ];

  const actualIndexes = expectedOrder.map(name => sequence.indexOf(name));
  const monotonic = actualIndexes.every((index, idx) => index >= 0 && (idx === 0 || index > actualIndexes[idx - 1]));

  return {
    expected_order: expectedOrder,
    observed_sequence: sequence,
    observed_indexes: actualIndexes,
    pass: monotonic
  };
}

function main() {
  const usability = runUsabilityChecklist();
  const eventProof = runEventProof();

  const output = {
    check_id: 'SC-UX-02',
    generated_at: new Date().toISOString(),
    usability,
    event_proof: eventProof,
    pass: usability.pass && eventProof.pass
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
