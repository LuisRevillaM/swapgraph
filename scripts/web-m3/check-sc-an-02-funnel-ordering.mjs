#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AnalyticsClient } from '../../client/marketplace/src/analytics/analyticsClient.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'artifacts/web-m3/sc-an-02-funnel-ordering-report.json');

const PREFIX = [
  'marketplace.route_opened',
  'marketplace.tab_viewed',
  'marketplace.inbox_ranked',
  'marketplace.proposal_opened',
  'marketplace.proposal_detail_viewed',
  'marketplace.proposal_decision_started'
];

function ordered(sequence, expected) {
  const indexes = expected.map(name => sequence.indexOf(name));
  const pass = indexes.every((index, idx) => index >= 0 && (idx === 0 || index > indexes[idx - 1]));
  return { indexes, pass };
}

function runSuccessScenario() {
  const analytics = new AnalyticsClient();
  analytics.track('marketplace.route_opened', { tab: 'inbox', path: '/inbox' });
  analytics.track('marketplace.tab_viewed', { tab: 'inbox' });
  analytics.track('marketplace.inbox_ranked', { proposal_count: 3, urgent_count: 1 });
  analytics.track('marketplace.proposal_opened', { proposal_id: 'proposal_1', rank: 1, source: 'inbox_card' });
  analytics.track('marketplace.proposal_detail_viewed', { proposal_id: 'proposal_1', rank: 1, urgency: 'critical' });
  analytics.track('marketplace.proposal_decision_started', { proposal_id: 'proposal_1', decision: 'accept', rank: 1 });
  analytics.track('marketplace.proposal_decision_succeeded', {
    proposal_id: 'proposal_1',
    decision: 'accept',
    rank: 1,
    latency_ms: 180,
    retry_count: 0
  });

  const sequence = analytics.snapshot().map(event => event.event_name);
  const expected = [...PREFIX, 'marketplace.proposal_decision_succeeded'];
  const order = ordered(sequence, expected);
  return {
    id: 'decision_success_path',
    expected_order: expected,
    observed_sequence: sequence,
    observed_indexes: order.indexes,
    pass: order.pass
  };
}

function runFailureScenario() {
  const analytics = new AnalyticsClient();
  analytics.track('marketplace.route_opened', { tab: 'inbox', path: '/inbox' });
  analytics.track('marketplace.tab_viewed', { tab: 'inbox' });
  analytics.track('marketplace.inbox_ranked', { proposal_count: 3, urgent_count: 1 });
  analytics.track('marketplace.proposal_opened', { proposal_id: 'proposal_2', rank: 2, source: 'deep_link' });
  analytics.track('marketplace.proposal_detail_viewed', { proposal_id: 'proposal_2', rank: 2, urgency: 'normal' });
  analytics.track('marketplace.proposal_decision_started', { proposal_id: 'proposal_2', decision: 'decline', rank: 2 });
  analytics.track('marketplace.proposal_decision_failed', {
    proposal_id: 'proposal_2',
    decision: 'decline',
    rank: 2,
    code: 'NETWORK_ERROR',
    status: 0
  });

  const sequence = analytics.snapshot().map(event => event.event_name);
  const expected = [...PREFIX, 'marketplace.proposal_decision_failed'];
  const order = ordered(sequence, expected);
  return {
    id: 'decision_failure_path',
    expected_order: expected,
    observed_sequence: sequence,
    observed_indexes: order.indexes,
    pass: order.pass
  };
}

function main() {
  const scenarios = [
    runSuccessScenario(),
    runFailureScenario()
  ];

  const output = {
    check_id: 'SC-AN-02',
    generated_at: new Date().toISOString(),
    scenario_count: scenarios.length,
    scenarios,
    pass: scenarios.every(row => row.pass)
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
