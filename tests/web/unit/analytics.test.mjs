import test from 'node:test';
import assert from 'node:assert/strict';

import { AnalyticsClient } from '../../../client/marketplace/src/analytics/analyticsClient.mjs';
import { validateAnalyticsEvent } from '../../../client/marketplace/src/analytics/events.mjs';

test('validateAnalyticsEvent guards schema and enum values', () => {
  assert.equal(validateAnalyticsEvent('marketplace.tab_viewed', { tab: 'items' }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.tab_viewed', { tab: 'unknown' }).ok, false);
  assert.equal(validateAnalyticsEvent('marketplace.api_retry', { attempt: 1 }).ok, false);
  assert.equal(validateAnalyticsEvent('marketplace.items_sort_changed', { sort: 'highest_demand' }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.items_sort_changed', { sort: 'invalid_sort' }).ok, false);
  assert.equal(validateAnalyticsEvent('marketplace.intent_submit_succeeded', {
    mode: 'create',
    intent_id: 'intent_1',
    latency_ms: 22
  }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.inbox_ranked', {
    proposal_count: 4,
    urgent_count: 1
  }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.proposal_opened', {
    proposal_id: 'proposal_1',
    rank: 1,
    source: 'inbox_card'
  }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.proposal_detail_viewed', {
    proposal_id: 'proposal_1',
    rank: 1,
    urgency: 'critical'
  }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.proposal_decision_succeeded', {
    proposal_id: 'proposal_1',
    decision: 'accept',
    rank: 1,
    latency_ms: 210,
    retry_count: 0
  }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.proposal_decision_failed', {
    proposal_id: 'proposal_1',
    decision: 'decline',
    rank: 2,
    code: 'NETWORK_ERROR',
    status: 0
  }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.notification_preferences_opened', {
    source: 'ui'
  }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.notification_preferences_saved', {
    proposal_enabled: true,
    active_enabled: true,
    receipt_enabled: false,
    quiet_hours_enabled: true,
    quiet_hours_start: 22,
    quiet_hours_end: 7
  }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.push_received', {
    kind: 'proposal',
    channel: 'proposal',
    source: 'window_event'
  }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.push_routed', {
    kind: 'active',
    channel: 'active',
    source: 'service_worker',
    tab: 'active',
    quiet_hours_active: false,
    channel_enabled: true
  }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.push_suppressed', {
    kind: 'receipt',
    channel: 'receipt',
    source: 'window_event',
    reason: 'quiet_hours'
  }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.offline_state_changed', {
    online: false,
    source: 'navigator'
  }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.offline_cache_used', {
    tab: 'inbox',
    reason: 'navigator_offline',
    cache_hit: true
  }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.receipts_list_viewed', {
    receipt_count: 2,
    completed_count: 1,
    failed_count: 1
  }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.receipt_opened', {
    receipt_id: 'receipt_1',
    cycle_id: 'cycle_1',
    source: 'notification'
  }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.receipt_detail_viewed', {
    receipt_id: 'receipt_1',
    cycle_id: 'cycle_1',
    final_state: 'completed',
    verification_status: 'verified',
    has_value_context: true
  }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.active_timeline_viewed', {
    cycle_id: 'cycle_1',
    state: 'escrow.pending',
    wait_reason: 'your_deposit_required'
  }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.active_action_tapped', {
    cycle_id: 'cycle_1',
    action: 'confirm_deposit',
    state: 'escrow.pending',
    enabled: true
  }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.active_action_succeeded', {
    cycle_id: 'cycle_1',
    action: 'confirm_deposit',
    state: 'escrow.ready',
    latency_ms: 160
  }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.active_action_failed', {
    cycle_id: 'cycle_1',
    action: 'complete_settlement',
    state: 'executing',
    code: 'FORBIDDEN',
    status: 403
  }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.active_receipt_opened', {
    cycle_id: 'cycle_1'
  }).ok, true);
  assert.equal(validateAnalyticsEvent('marketplace.proposal_opened', {
    proposal_id: 'proposal_1',
    rank: 1,
    source: 'invalid_source'
  }).ok, false);
  assert.equal(validateAnalyticsEvent('marketplace.active_action_tapped', {
    cycle_id: 'cycle_1',
    action: 'unsupported',
    state: 'escrow.pending',
    enabled: true
  }).ok, false);
  assert.equal(validateAnalyticsEvent('marketplace.receipt_opened', {
    receipt_id: 'receipt_1',
    cycle_id: 'cycle_1',
    source: 'invalid_source'
  }).ok, false);
});

test('AnalyticsClient rejects invalid event payloads', () => {
  const client = new AnalyticsClient();
  client.track('marketplace.api_request', {
    operation: 'health.read',
    method: 'GET',
    status: 200
  });

  assert.equal(client.snapshot().length, 1);
  assert.throws(() => {
    client.track('marketplace.tab_viewed', { tab: 'not_a_tab' });
  }, /analytics schema guard failed/);
});
