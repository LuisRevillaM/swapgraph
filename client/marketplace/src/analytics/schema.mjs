const TAB_VALUES = ['items', 'intents', 'inbox', 'active', 'receipts'];
const SORT_VALUES = ['highest_demand', 'also_tradable'];
const COMPOSER_MODE_VALUES = ['create', 'edit'];
const DECISION_VALUES = ['accept', 'decline'];
const PROPOSAL_OPEN_SOURCE_VALUES = ['inbox_card', 'deep_link'];
const URGENCY_VALUES = ['normal', 'soon', 'critical', 'expired'];
const ACTIVE_ACTION_VALUES = ['confirm_deposit', 'begin_execution', 'complete_settlement', 'open_receipt', 'refresh_cycle'];
const SETTLEMENT_STATE_VALUES = ['proposed', 'accepted', 'escrow.pending', 'escrow.ready', 'executing', 'completed', 'failed'];
const RECEIPT_FINAL_STATE_VALUES = ['completed', 'failed', 'unknown'];
const RECEIPT_OPEN_SOURCE_VALUES = ['receipts_list', 'active_timeline', 'deep_link', 'notification'];
const RECEIPT_VERIFICATION_VALUES = ['verified', 'missing_signature', 'partial_signature', 'unavailable'];
const PUSH_KIND_VALUES = ['proposal', 'active', 'receipt'];
const PUSH_CHANNEL_VALUES = ['proposal', 'active', 'receipt'];
const PUSH_SOURCE_VALUES = ['window_event', 'service_worker', 'simulated'];
const PUSH_SUPPRESSION_REASON_VALUES = ['quiet_hours', 'channel_disabled'];
const PREF_SOURCE_VALUES = ['ui'];
const OFFLINE_REASON_VALUES = ['navigator_offline', 'cache_miss', 'network_error_fallback', 'offline_event', 'initial_offline'];
const OFFLINE_SOURCE_VALUES = ['navigator'];
const WAIT_REASON_VALUES = [
  'your_deposit_required',
  'awaiting_counterparty_deposit',
  'deposit_reconciliation',
  'awaiting_execution_start',
  'execution_in_progress',
  'receipt_available',
  'counterparty_timeout_refund',
  'cycle_failed',
  'awaiting_deposit_window',
  'cycle_proposed'
];

export const ANALYTICS_EVENT_SCHEMAS = Object.freeze({
  'marketplace.tab_viewed': {
    required: { tab: 'string' },
    enums: { tab: TAB_VALUES }
  },
  'marketplace.route_opened': {
    required: { tab: 'string', path: 'string' },
    enums: { tab: TAB_VALUES }
  },
  'marketplace.api_request': {
    required: { operation: 'string', method: 'string', status: 'number' }
  },
  'marketplace.api_retry': {
    required: { operation: 'string', attempt: 'number', delay_ms: 'number' }
  },
  'marketplace.api_error': {
    required: { operation: 'string', code: 'string', status: 'number' }
  },
  'marketplace.items_demand_banner_tapped': {
    required: { opportunity_count: 'number' }
  },
  'marketplace.items_sort_changed': {
    required: { sort: 'string' },
    enums: { sort: SORT_VALUES }
  },
  'marketplace.intent_composer_opened': {
    required: { mode: 'string' },
    enums: { mode: COMPOSER_MODE_VALUES }
  },
  'marketplace.intent_validation_failed': {
    required: { mode: 'string', field_count: 'number' },
    enums: { mode: COMPOSER_MODE_VALUES }
  },
  'marketplace.intent_submit_started': {
    required: { mode: 'string', intent_id: 'string' },
    enums: { mode: COMPOSER_MODE_VALUES }
  },
  'marketplace.intent_submit_succeeded': {
    required: { mode: 'string', intent_id: 'string', latency_ms: 'number' },
    enums: { mode: COMPOSER_MODE_VALUES }
  },
  'marketplace.intent_submit_failed': {
    required: { mode: 'string', intent_id: 'string', code: 'string', status: 'number' },
    enums: { mode: COMPOSER_MODE_VALUES }
  },
  'marketplace.intent_cancel_started': {
    required: { intent_id: 'string' }
  },
  'marketplace.intent_cancel_succeeded': {
    required: { intent_id: 'string', latency_ms: 'number' }
  },
  'marketplace.intent_cancel_failed': {
    required: { intent_id: 'string', code: 'string', status: 'number' }
  },
  'marketplace.notification_preferences_opened': {
    required: { source: 'string' },
    enums: { source: PREF_SOURCE_VALUES }
  },
  'marketplace.notification_preferences_saved': {
    required: {
      proposal_enabled: 'boolean',
      active_enabled: 'boolean',
      receipt_enabled: 'boolean',
      quiet_hours_enabled: 'boolean',
      quiet_hours_start: 'number',
      quiet_hours_end: 'number'
    }
  },
  'marketplace.push_received': {
    required: { kind: 'string', channel: 'string', source: 'string' },
    enums: { kind: PUSH_KIND_VALUES, channel: PUSH_CHANNEL_VALUES, source: PUSH_SOURCE_VALUES }
  },
  'marketplace.push_routed': {
    required: {
      kind: 'string',
      channel: 'string',
      source: 'string',
      tab: 'string',
      quiet_hours_active: 'boolean',
      channel_enabled: 'boolean'
    },
    enums: { kind: PUSH_KIND_VALUES, channel: PUSH_CHANNEL_VALUES, source: PUSH_SOURCE_VALUES, tab: TAB_VALUES }
  },
  'marketplace.push_suppressed': {
    required: { kind: 'string', channel: 'string', source: 'string', reason: 'string' },
    enums: {
      kind: PUSH_KIND_VALUES,
      channel: PUSH_CHANNEL_VALUES,
      source: PUSH_SOURCE_VALUES,
      reason: PUSH_SUPPRESSION_REASON_VALUES
    }
  },
  'marketplace.offline_state_changed': {
    required: { online: 'boolean', source: 'string' },
    enums: { source: OFFLINE_SOURCE_VALUES }
  },
  'marketplace.offline_cache_used': {
    required: { tab: 'string', reason: 'string', cache_hit: 'boolean' },
    enums: { tab: TAB_VALUES, reason: OFFLINE_REASON_VALUES }
  },
  'marketplace.inbox_ranked': {
    required: { proposal_count: 'number', urgent_count: 'number' }
  },
  'marketplace.proposal_opened': {
    required: { proposal_id: 'string', rank: 'number', source: 'string' },
    enums: { source: PROPOSAL_OPEN_SOURCE_VALUES }
  },
  'marketplace.proposal_detail_viewed': {
    required: { proposal_id: 'string', rank: 'number', urgency: 'string' },
    enums: { urgency: URGENCY_VALUES }
  },
  'marketplace.proposal_decision_started': {
    required: { proposal_id: 'string', decision: 'string', rank: 'number' },
    enums: { decision: DECISION_VALUES }
  },
  'marketplace.proposal_decision_succeeded': {
    required: { proposal_id: 'string', decision: 'string', rank: 'number', latency_ms: 'number', retry_count: 'number' },
    enums: { decision: DECISION_VALUES }
  },
  'marketplace.proposal_decision_failed': {
    required: { proposal_id: 'string', decision: 'string', rank: 'number', code: 'string', status: 'number' },
    enums: { decision: DECISION_VALUES }
  },
  'marketplace.receipts_list_viewed': {
    required: { receipt_count: 'number', completed_count: 'number', failed_count: 'number' }
  },
  'marketplace.receipt_opened': {
    required: { receipt_id: 'string', cycle_id: 'string', source: 'string' },
    enums: { source: RECEIPT_OPEN_SOURCE_VALUES }
  },
  'marketplace.receipt_detail_viewed': {
    required: {
      receipt_id: 'string',
      cycle_id: 'string',
      final_state: 'string',
      verification_status: 'string',
      has_value_context: 'boolean'
    },
    enums: {
      final_state: RECEIPT_FINAL_STATE_VALUES,
      verification_status: RECEIPT_VERIFICATION_VALUES
    }
  },
  'marketplace.active_timeline_viewed': {
    required: { cycle_id: 'string', state: 'string', wait_reason: 'string' },
    enums: { state: SETTLEMENT_STATE_VALUES, wait_reason: WAIT_REASON_VALUES }
  },
  'marketplace.active_action_tapped': {
    required: { cycle_id: 'string', action: 'string', state: 'string', enabled: 'boolean' },
    enums: { action: ACTIVE_ACTION_VALUES, state: SETTLEMENT_STATE_VALUES }
  },
  'marketplace.active_action_succeeded': {
    required: { cycle_id: 'string', action: 'string', state: 'string', latency_ms: 'number' },
    enums: { action: ACTIVE_ACTION_VALUES, state: SETTLEMENT_STATE_VALUES }
  },
  'marketplace.active_action_failed': {
    required: { cycle_id: 'string', action: 'string', state: 'string', code: 'string', status: 'number' },
    enums: { action: ACTIVE_ACTION_VALUES, state: SETTLEMENT_STATE_VALUES }
  },
  'marketplace.active_receipt_opened': {
    required: { cycle_id: 'string' }
  }
});

function typeMatches(value, expectedType) {
  if (expectedType === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expectedType === 'array') return Array.isArray(value);
  return typeof value === expectedType;
}

export function validateAnalyticsEvent(eventName, payload) {
  const schema = ANALYTICS_EVENT_SCHEMAS[eventName];
  if (!schema) {
    return {
      ok: false,
      error: `unknown event: ${eventName}`
    };
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      ok: false,
      error: `payload for ${eventName} must be an object`
    };
  }

  for (const [fieldName, fieldType] of Object.entries(schema.required ?? {})) {
    if (!typeMatches(payload[fieldName], fieldType)) {
      return {
        ok: false,
        error: `field ${fieldName} must be ${fieldType}`
      };
    }
  }

  for (const [fieldName, allowedValues] of Object.entries(schema.enums ?? {})) {
    if (payload[fieldName] === undefined) continue;
    if (!allowedValues.includes(payload[fieldName])) {
      return {
        ok: false,
        error: `field ${fieldName} has unsupported value ${String(payload[fieldName])}`
      };
    }
  }

  return { ok: true };
}
