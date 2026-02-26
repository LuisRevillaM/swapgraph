#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AnalyticsClient } from '../../client/marketplace/src/analytics/analyticsClient.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'artifacts/web-m4/sc-an-02-funnel-ordering-report.json');

const PREFIX = [
  'marketplace.route_opened',
  'marketplace.tab_viewed',
  'marketplace.active_timeline_viewed',
  'marketplace.active_action_tapped'
];

function ordered(sequence, expected) {
  const indexes = expected.map(name => sequence.indexOf(name));
  const pass = indexes.every((index, idx) => index >= 0 && (idx === 0 || index > indexes[idx - 1]));
  return { indexes, pass };
}

function runSuccessScenario() {
  const analytics = new AnalyticsClient();
  analytics.track('marketplace.route_opened', { tab: 'active', path: '/active/cycle/cycle_1' });
  analytics.track('marketplace.tab_viewed', { tab: 'active' });
  analytics.track('marketplace.active_timeline_viewed', {
    cycle_id: 'cycle_1',
    state: 'escrow.pending',
    wait_reason: 'your_deposit_required'
  });
  analytics.track('marketplace.active_action_tapped', {
    cycle_id: 'cycle_1',
    action: 'confirm_deposit',
    state: 'escrow.pending',
    enabled: true
  });
  analytics.track('marketplace.active_action_succeeded', {
    cycle_id: 'cycle_1',
    action: 'confirm_deposit',
    state: 'escrow.ready',
    latency_ms: 230
  });
  analytics.track('marketplace.active_action_tapped', {
    cycle_id: 'cycle_1',
    action: 'open_receipt',
    state: 'completed',
    enabled: true
  });
  analytics.track('marketplace.active_receipt_opened', {
    cycle_id: 'cycle_1'
  });

  const sequence = analytics.snapshot().map(event => event.event_name);
  const expected = [...PREFIX, 'marketplace.active_action_succeeded', 'marketplace.active_receipt_opened'];
  const order = ordered(sequence, expected);

  return {
    id: 'active_success_to_receipt',
    expected_order: expected,
    observed_sequence: sequence,
    observed_indexes: order.indexes,
    pass: order.pass
  };
}

function runFailureScenario() {
  const analytics = new AnalyticsClient();
  analytics.track('marketplace.route_opened', { tab: 'active', path: '/active/cycle/cycle_2' });
  analytics.track('marketplace.tab_viewed', { tab: 'active' });
  analytics.track('marketplace.active_timeline_viewed', {
    cycle_id: 'cycle_2',
    state: 'executing',
    wait_reason: 'execution_in_progress'
  });
  analytics.track('marketplace.active_action_tapped', {
    cycle_id: 'cycle_2',
    action: 'complete_settlement',
    state: 'executing',
    enabled: true
  });
  analytics.track('marketplace.active_action_failed', {
    cycle_id: 'cycle_2',
    action: 'complete_settlement',
    state: 'executing',
    code: 'FORBIDDEN',
    status: 403
  });

  const sequence = analytics.snapshot().map(event => event.event_name);
  const expected = [...PREFIX, 'marketplace.active_action_failed'];
  const order = ordered(sequence, expected);

  return {
    id: 'active_failure_path',
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
