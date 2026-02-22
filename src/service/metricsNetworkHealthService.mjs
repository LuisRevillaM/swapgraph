import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { buildSignedPolicyAuditExportPayload } from '../crypto/policyIntegritySigning.mjs';

const ALLOWED_BUCKETS = new Set(['hour', 'day', 'week']);
const FRAUD_SIGNAL_PREFIX = 'fraud_';

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseIsoMs(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function parseLimit(value, fallback = 50) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, 200);
}

function errorResponse(correlationIdValue, code, message, details = {}) {
  return {
    correlation_id: correlationIdValue,
    error: {
      code,
      message,
      details
    }
  };
}

function ensureState(store) {
  store.state.metrics_network_health_export_checkpoints ||= {};
}

function inWindow(ms, fromMs, toMs) {
  return Number.isFinite(ms) && ms >= fromMs && ms < toMs;
}

function toBps(numerator, denominator) {
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.round((Number(numerator) * 10000) / Number(denominator));
}

function perThousand(numerator, denominator) {
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.round((Number(numerator) * 1000) / Number(denominator));
}

function ratioRounded(numerator, denominator, digits = 4) {
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  const scale = 10 ** digits;
  return Math.round((Number(numerator) / Number(denominator)) * scale) / scale;
}

function actorScopeKey(actor) {
  return `${actor?.type ?? 'unknown'}:${actor?.id ?? 'unknown'}`;
}

function eventCycleId(event) {
  const payloadCycleId = normalizeOptionalString(event?.payload?.cycle_id);
  if (payloadCycleId) return payloadCycleId;

  const correlation = normalizeOptionalString(event?.correlation_id);
  if (correlation && correlation.startsWith('corr_')) {
    const maybe = correlation.slice('corr_'.length);
    if (maybe && !maybe.startsWith('swap_intents_') && !maybe.startsWith('trust_safety_')) {
      return maybe;
    }
  }

  return null;
}

function floorBucketStartMs(ms, bucket) {
  const d = new Date(ms);

  if (bucket === 'hour') {
    d.setUTCMinutes(0, 0, 0);
    return d.getTime();
  }

  if (bucket === 'day') {
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }

  d.setUTCHours(0, 0, 0, 0);
  const weekday = d.getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return d.getTime();
}

function addBucketMs(ms, bucket) {
  const d = new Date(ms);

  if (bucket === 'hour') {
    d.setUTCHours(d.getUTCHours() + 1);
    return d.getTime();
  }

  if (bucket === 'day') {
    d.setUTCDate(d.getUTCDate() + 1);
    return d.getTime();
  }

  d.setUTCDate(d.getUTCDate() + 7);
  return d.getTime();
}

function bucketCursorKey(entry) {
  return `${entry.bucket_start_iso}|${entry.bucket_end_iso}`;
}

function hashQueryContext(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function parseWindowQuery(query) {
  const fromIso = normalizeOptionalString(query?.from_iso);
  const toIso = normalizeOptionalString(query?.to_iso);
  const bucket = normalizeOptionalString(query?.bucket) ?? 'day';

  if (!fromIso || !toIso) {
    return {
      ok: false,
      reason_code: 'metrics_query_invalid',
      details: {
        from_iso: fromIso,
        to_iso: toIso
      }
    };
  }

  const fromMs = parseIsoMs(fromIso);
  const toMs = parseIsoMs(toIso);
  if (fromMs === null || toMs === null) {
    return {
      ok: false,
      reason_code: 'metrics_query_invalid',
      details: {
        from_iso: fromIso,
        to_iso: toIso
      }
    };
  }

  if (toMs <= fromMs) {
    return {
      ok: false,
      reason_code: 'metrics_window_invalid',
      details: {
        from_iso: fromIso,
        to_iso: toIso
      }
    };
  }

  if (!ALLOWED_BUCKETS.has(bucket)) {
    return {
      ok: false,
      reason_code: 'metrics_bucket_invalid',
      details: {
        bucket,
        allowed: Array.from(ALLOWED_BUCKETS).sort()
      }
    };
  }

  return {
    ok: true,
    from_iso: new Date(fromMs).toISOString(),
    to_iso: new Date(toMs).toISOString(),
    from_ms: fromMs,
    to_ms: toMs,
    bucket
  };
}

function resolvePartnerScope({ actor, query }) {
  if (actor?.type !== 'partner' || !normalizeOptionalString(actor?.id)) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      message: 'only partner can read metrics surfaces',
      details: {
        actor
      }
    };
  }

  const partnerFilter = normalizeOptionalString(query?.partner_id);
  if (partnerFilter && partnerFilter !== actor.id) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      message: 'partner cannot read metrics for another tenant',
      details: {
        actor,
        partner_id: partnerFilter
      }
    };
  }

  return {
    ok: true,
    partner_id: actor.id
  };
}

function intentTimestampMs(intent, fallbackMs) {
  return parseIsoMs(intent?.created_at)
    ?? parseIsoMs(intent?.updated_at)
    ?? parseIsoMs(intent?.occurred_at)
    ?? fallbackMs
    ?? null;
}

function proposalTimestampMs(proposal, fallbackMs) {
  return parseIsoMs(proposal?.created_at)
    ?? parseIsoMs(proposal?.updated_at)
    ?? parseIsoMs(proposal?.published_at)
    ?? fallbackMs
    ?? null;
}

function normalizeWebhookAttemptTimestamp(row) {
  return parseIsoMs(row?.last_attempt_at)
    ?? parseIsoMs(row?.first_attempt_at)
    ?? null;
}

function collectPartnerContext(store, partnerId) {
  const cycleIds = new Set();

  for (const [cycleId, scoped] of Object.entries(store.state?.tenancy?.cycles ?? {})) {
    if (scoped?.partner_id === partnerId) cycleIds.add(cycleId);
  }

  for (const [cycleId, scoped] of Object.entries(store.state?.tenancy?.proposals ?? {})) {
    if (scoped?.partner_id === partnerId) cycleIds.add(cycleId);
  }

  const proposalsByCycle = new Map();
  const partnerIntentIds = new Set();
  for (const cycleId of cycleIds) {
    const proposal = store.state?.proposals?.[cycleId] ?? null;
    if (!proposal) continue;
    proposalsByCycle.set(cycleId, proposal);

    for (const participant of proposal.participants ?? []) {
      const intentId = normalizeOptionalString(participant?.intent_id);
      if (intentId) partnerIntentIds.add(intentId);
    }
  }

  const events = [];
  const firstProposedEventMsByCycle = new Map();
  const firstReservedEventMsByIntent = new Map();

  for (const event of store.state?.events ?? []) {
    const cycleId = eventCycleId(event);
    if (!cycleId || !cycleIds.has(cycleId)) continue;

    const occurredMs = parseIsoMs(event?.occurred_at);
    if (occurredMs === null) continue;

    const normalized = {
      type: normalizeOptionalString(event?.type),
      cycle_id: cycleId,
      occurred_ms: occurredMs,
      occurred_at: new Date(occurredMs).toISOString(),
      payload: event?.payload && typeof event.payload === 'object' ? event.payload : {}
    };
    events.push(normalized);

    if (normalized.type === 'cycle.state_changed' && normalized.payload?.from_state === 'proposed') {
      const prior = firstProposedEventMsByCycle.get(cycleId);
      if (prior === undefined || occurredMs < prior) firstProposedEventMsByCycle.set(cycleId, occurredMs);
    }

    if (normalized.type === 'intent.reserved') {
      const intentId = normalizeOptionalString(normalized.payload?.intent_id);
      if (intentId) {
        const prior = firstReservedEventMsByIntent.get(intentId);
        if (prior === undefined || occurredMs < prior) firstReservedEventMsByIntent.set(intentId, occurredMs);
      }
    }
  }

  events.sort((a, b) => {
    if (a.occurred_ms !== b.occurred_ms) return a.occurred_ms - b.occurred_ms;
    return `${a.cycle_id}|${a.type ?? ''}`.localeCompare(`${b.cycle_id}|${b.type ?? ''}`);
  });

  const receipts = [];
  for (const [cycleId, receipt] of Object.entries(store.state?.receipts ?? {})) {
    if (!cycleIds.has(cycleId)) continue;
    const ms = parseIsoMs(receipt?.created_at);
    if (ms === null) continue;
    receipts.push({
      cycle_id: cycleId,
      created_ms: ms,
      created_at: new Date(ms).toISOString(),
      final_state: normalizeOptionalString(receipt?.final_state),
      receipt
    });
  }

  receipts.sort((a, b) => {
    if (a.created_ms !== b.created_ms) return a.created_ms - b.created_ms;
    return String(a.cycle_id).localeCompare(String(b.cycle_id));
  });

  const commits = [];
  for (const commit of Object.values(store.state?.commits ?? {})) {
    const cycleId = normalizeOptionalString(commit?.cycle_id);
    if (!cycleId || !cycleIds.has(cycleId)) continue;
    const updatedMs = parseIsoMs(commit?.updated_at);
    if (updatedMs === null) continue;
    commits.push({
      cycle_id: cycleId,
      phase: normalizeOptionalString(commit?.phase),
      updated_ms: updatedMs
    });
  }

  const intentsById = new Map();
  for (const intentId of partnerIntentIds) {
    const intent = store.state?.intents?.[intentId] ?? null;
    if (!intent) continue;
    intentsById.set(intentId, intent);
  }

  const proposals = [];
  for (const cycleId of cycleIds) {
    const proposal = proposalsByCycle.get(cycleId) ?? null;
    if (!proposal) continue;
    const ms = proposalTimestampMs(proposal, firstProposedEventMsByCycle.get(cycleId));
    proposals.push({
      cycle_id: cycleId,
      proposal,
      timestamp_ms: ms
    });
  }

  const connections = Object.values(store.state?.platform_connections?.[actorScopeKey({ type: 'partner', id: partnerId })] ?? {});
  const snapshots = store.state?.inventory_snapshots?.[partnerId] ?? [];
  const webhookAttempts = (store.state?.partner_program_webhook_delivery_attempts ?? []).filter(row => row?.partner_id === partnerId);

  const trustSignals = Object.values(store.state?.trust_safety_signals ?? {}).filter(signal => {
    const recordedByPartner = signal?.recorded_by?.type === 'partner' && signal?.recorded_by?.id === partnerId;
    const partnerSubject = signal?.subject_actor_type === 'partner' && signal?.subject_actor_id === partnerId;
    return recordedByPartner || partnerSubject;
  });

  const trustDecisions = Object.values(store.state?.trust_safety_decisions ?? {}).filter(decision => {
    const recordedByPartner = decision?.recorded_by?.type === 'partner' && decision?.recorded_by?.id === partnerId;
    const partnerSubject = decision?.subject_actor_type === 'partner' && decision?.subject_actor_id === partnerId;
    return recordedByPartner || partnerSubject;
  });

  return {
    cycle_ids: cycleIds,
    proposals,
    proposals_by_cycle: proposalsByCycle,
    partner_intent_ids: partnerIntentIds,
    first_reserved_event_ms_by_intent: firstReservedEventMsByIntent,
    events,
    receipts,
    commits,
    intents_by_id: intentsById,
    connections,
    snapshots,
    webhook_attempts: webhookAttempts,
    trust_signals: trustSignals,
    trust_decisions: trustDecisions
  };
}

function collectWindowMetrics({ context, fromMs, toMs }) {
  const eventsWindow = context.events.filter(event => inWindow(event.occurred_ms, fromMs, toMs));
  const stateEvents = eventsWindow.filter(event => event.type === 'cycle.state_changed');

  const proposalViewedCycles = new Set(stateEvents.filter(event => event.payload?.from_state === 'proposed').map(event => event.cycle_id));
  const acceptedCycles = new Set(stateEvents.filter(event => event.payload?.to_state === 'accepted').map(event => event.cycle_id));
  const depositedCycles = new Set(stateEvents.filter(event => event.payload?.to_state === 'escrow.ready').map(event => event.cycle_id));

  const receiptsWindow = context.receipts.filter(receipt => inWindow(receipt.created_ms, fromMs, toMs));
  const completedReceipts = receiptsWindow.filter(receipt => receipt.final_state === 'completed');
  const failedReceipts = receiptsWindow.filter(receipt => receipt.final_state === 'failed');

  const completedCycleIds = new Set(completedReceipts.map(receipt => receipt.cycle_id));

  const intentIdsWindow = [];
  for (const intentId of context.partner_intent_ids) {
    const intent = context.intents_by_id.get(intentId) ?? null;
    if (!intent) continue;

    const ts = intentTimestampMs(intent, context.first_reserved_event_ms_by_intent.get(intentId));
    if (!inWindow(ts, fromMs, toMs)) continue;

    intentIdsWindow.push(intentId);
  }

  const connectedCount = context.connections
    .filter(row => row?.status === 'connected')
    .filter(row => inWindow(parseIsoMs(row?.connected_at) ?? parseIsoMs(row?.updated_at), fromMs, toMs)).length;

  const syncCount = context.snapshots
    .filter(row => inWindow(parseIsoMs(row?.captured_at), fromMs, toMs)).length;

  const webhookWindow = context.webhook_attempts
    .map(row => ({ ...row, timestamp_ms: normalizeWebhookAttemptTimestamp(row) }))
    .filter(row => inWindow(row.timestamp_ms, fromMs, toMs));

  const webhookDelivered = webhookWindow.filter(row => row?.last_status === 'delivered').length;
  const webhookDeadLettered = webhookWindow.filter(row => row?.dead_lettered === true).length;

  const proposalWebhookWindow = webhookWindow.filter(row => String(row?.event_type ?? '').startsWith('proposal.'));
  const proposalDeliveryAttempts = proposalWebhookWindow.length > 0
    ? proposalWebhookWindow.length
    : context.proposals.filter(row => inWindow(row.timestamp_ms, fromMs, toMs)).length;
  const proposalDeliverySuccess = proposalWebhookWindow.length > 0
    ? proposalWebhookWindow.filter(row => row?.last_status === 'delivered').length
    : proposalDeliveryAttempts;

  const signalWindow = context.trust_signals.filter(signal => inWindow(parseIsoMs(signal?.recorded_at), fromMs, toMs));
  const decisionWindow = context.trust_decisions.filter(decision => inWindow(parseIsoMs(decision?.recorded_at), fromMs, toMs));

  const fraudFlags = signalWindow.filter(signal => String(signal?.category ?? '').startsWith(FRAUD_SIGNAL_PREFIX)).length;
  const confirmedAbuse = decisionWindow.filter(decision => decision?.decision === 'block').length;
  const allowDecisions = decisionWindow.filter(decision => decision?.decision === 'allow').length;

  return {
    connect_count: connectedCount,
    sync_count: syncCount,
    intent_count: intentIdsWindow.length,
    proposal_viewed_count: proposalViewedCycles.size,
    accepted_count: acceptedCycles.size,
    deposited_count: depositedCycles.size,
    completed_count: completedCycleIds.size,

    terminal_count: completedReceipts.length + failedReceipts.length,
    failed_terminal_count: failedReceipts.length,

    proposal_delivery_attempts: proposalDeliveryAttempts,
    proposal_delivery_success: proposalDeliverySuccess,
    webhook_total: webhookWindow.length,
    webhook_delivered: webhookDelivered,
    webhook_dead_lettered: webhookDeadLettered,

    fraud_flags_count: fraudFlags,
    confirmed_abuse_count: confirmedAbuse,
    allow_decisions_count: allowDecisions,
    decisions_count: decisionWindow.length
  };
}

function activeTraderCount7d({ context, fromMs, toMs }) {
  const cycleIds = new Set();

  for (const event of context.events) {
    if (inWindow(event.occurred_ms, fromMs, toMs)) cycleIds.add(event.cycle_id);
  }

  for (const receipt of context.receipts) {
    if (inWindow(receipt.created_ms, fromMs, toMs)) cycleIds.add(receipt.cycle_id);
  }

  for (const commit of context.commits) {
    if (inWindow(commit.updated_ms, fromMs, toMs)) cycleIds.add(commit.cycle_id);
  }

  const users = new Set();
  for (const cycleId of cycleIds) {
    const proposal = context.proposals_by_cycle.get(cycleId) ?? null;
    if (!proposal) continue;

    for (const participant of proposal.participants ?? []) {
      if (participant?.actor?.type === 'user' && normalizeOptionalString(participant?.actor?.id)) {
        users.add(participant.actor.id);
      }
    }
  }

  if (users.size === 0) {
    for (const intentId of context.partner_intent_ids) {
      const intent = context.intents_by_id.get(intentId) ?? null;
      if (!intent) continue;
      const ts = intentTimestampMs(intent, context.first_reserved_event_ms_by_intent.get(intentId));
      if (!inWindow(ts, fromMs, toMs)) continue;

      const actor = intent?.actor;
      if (actor?.type === 'user' && normalizeOptionalString(actor?.id)) users.add(actor.id);
    }
  }

  return users.size;
}

function floorMetricsFromCounts({ counts, completed7d, terminal7d, activeTraders7d }) {
  return {
    weekly_successful_swaps_per_active_trader: ratioRounded(completed7d, activeTraders7d, 4),
    fill_rate_7d_bps: toBps(completed7d, terminal7d),
    proposal_to_accept_bps: toBps(counts.accepted_count, counts.proposal_viewed_count),
    accept_to_complete_bps: toBps(counts.completed_count, counts.accepted_count),
    webhook_delivery_success_bps: toBps(counts.webhook_delivered, counts.webhook_total),
    fraud_flags_per_1000_intents: perThousand(counts.fraud_flags_count, counts.intent_count),
    unwind_rate_bps: toBps(counts.failed_terminal_count, counts.terminal_count)
  };
}

function buildSummary({ counts, floor }) {
  return {
    ...floor,
    weekly_successful_swaps_count_7d: counts.completed_7d_count,
    active_trader_count_7d: counts.active_trader_count_7d,
    fill_rate_7d_numerator_completed: counts.completed_7d_count,
    fill_rate_7d_denominator_terminal: counts.terminal_7d_count,
    proposal_to_accept_numerator: counts.accepted_count,
    proposal_to_accept_denominator: counts.proposal_viewed_count,
    accept_to_complete_numerator: counts.completed_count,
    accept_to_complete_denominator: counts.accepted_count,
    webhook_delivery_success_numerator: counts.webhook_delivered,
    webhook_delivery_success_denominator: counts.webhook_total,
    fraud_flags_numerator: counts.fraud_flags_count,
    fraud_flags_denominator_intents: counts.intent_count,
    unwind_numerator: counts.failed_terminal_count,
    unwind_denominator_terminal: counts.terminal_count,
    primary_metric: 'weekly_successful_swaps_per_active_trader'
  };
}

function computeWindowPackage({ context, fromMs, toMs }) {
  const counts = collectWindowMetrics({ context, fromMs, toMs });

  const trailingFromMs = toMs - (7 * 24 * 60 * 60 * 1000);
  const receipts7d = context.receipts.filter(receipt => inWindow(receipt.created_ms, trailingFromMs, toMs));
  const completed7d = receipts7d.filter(receipt => receipt.final_state === 'completed').length;
  const terminal7d = receipts7d.filter(receipt => receipt.final_state === 'completed' || receipt.final_state === 'failed').length;
  const activeTraders7d = activeTraderCount7d({ context, fromMs: trailingFromMs, toMs });

  const floor = floorMetricsFromCounts({
    counts,
    completed7d,
    terminal7d,
    activeTraders7d
  });

  const enrichedCounts = {
    ...counts,
    completed_7d_count: completed7d,
    terminal_7d_count: terminal7d,
    active_trader_count_7d: activeTraders7d
  };

  const summary = buildSummary({ counts: enrichedCounts, floor });

  const funnel = {
    counts: {
      connect: counts.connect_count,
      sync: counts.sync_count,
      intent: counts.intent_count,
      proposal_viewed: counts.proposal_viewed_count,
      accepted: counts.accepted_count,
      deposited: counts.deposited_count,
      completed: counts.completed_count
    },
    conversions_bps: {
      connect_to_sync_bps: toBps(counts.sync_count, counts.connect_count),
      sync_to_intent_bps: toBps(counts.intent_count, counts.sync_count),
      intent_to_proposal_viewed_bps: toBps(counts.proposal_viewed_count, counts.intent_count),
      proposal_to_accept_bps: floor.proposal_to_accept_bps,
      accept_to_deposited_bps: toBps(counts.deposited_count, counts.accepted_count),
      deposited_to_completed_bps: toBps(counts.completed_count, counts.deposited_count)
    },
    denominators: {
      connect_to_sync_denominator: counts.connect_count,
      sync_to_intent_denominator: counts.sync_count,
      intent_to_proposal_viewed_denominator: counts.intent_count,
      proposal_to_accept_denominator: counts.proposal_viewed_count,
      accept_to_deposited_denominator: counts.accepted_count,
      deposited_to_completed_denominator: counts.deposited_count
    }
  };

  const partnerHealth = {
    proposal_delivery_success_bps: toBps(counts.proposal_delivery_success, counts.proposal_delivery_attempts),
    proposal_delivery_success_numerator: counts.proposal_delivery_success,
    proposal_delivery_success_denominator: counts.proposal_delivery_attempts,
    commit_to_completion_bps: toBps(counts.completed_count, counts.accepted_count),
    commit_to_completion_numerator: counts.completed_count,
    commit_to_completion_denominator: counts.accepted_count,
    webhook_delivery_success_bps: floor.webhook_delivery_success_bps,
    webhook_delivery_success_numerator: counts.webhook_delivered,
    webhook_delivery_success_denominator: counts.webhook_total,
    webhook_dead_letter_rate_bps: toBps(counts.webhook_dead_lettered, counts.webhook_total),
    webhook_dead_letter_numerator: counts.webhook_dead_lettered,
    webhook_dead_letter_denominator: counts.webhook_total
  };

  const safetyHealth = {
    fraud_flags_count: counts.fraud_flags_count,
    confirmed_abuse_count: counts.confirmed_abuse_count,
    unwind_rate_bps: floor.unwind_rate_bps,
    felt_safe_proxy_bps: toBps(counts.allow_decisions_count, counts.decisions_count),
    felt_safe_proxy_numerator: counts.allow_decisions_count,
    felt_safe_proxy_denominator: counts.decisions_count,
    fraud_flags_per_1000_intents: floor.fraud_flags_per_1000_intents,
    fraud_flags_per_1000_intents_numerator: counts.fraud_flags_count,
    fraud_flags_per_1000_intents_denominator: counts.intent_count
  };

  return {
    floor,
    summary,
    funnel,
    partner_health: partnerHealth,
    safety_health: safetyHealth
  };
}

function normalizeExportQueryForSigning({
  fromIso,
  toIso,
  bucket,
  partnerId,
  limit,
  cursorAfter,
  attestationAfter,
  checkpointAfter,
  nowIso,
  exportedAt
}) {
  const out = {
    from_iso: fromIso,
    to_iso: toIso,
    limit,
    now_iso: nowIso,
    // Kept in signed query via normalizeExportQuery supported field.
    operation_id: `metrics_network_health_export_${bucket}`,
    delegation_id: partnerId,
    exported_at_iso: exportedAt
  };

  if (cursorAfter) out.cursor_after = cursorAfter;
  if (attestationAfter) out.attestation_after = attestationAfter;
  if (checkpointAfter) out.checkpoint_after = checkpointAfter;

  return out;
}

function buildQueryContextFingerprint({ actor, partnerId, fromIso, toIso, bucket, limit }) {
  return hashQueryContext({
    actor_type: actor?.type ?? null,
    actor_id: actor?.id ?? null,
    partner_id: partnerId,
    from_iso: fromIso,
    to_iso: toIso,
    bucket,
    limit
  });
}

function parsePositiveInt(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

function checkpointRetentionDays() {
  const env = parsePositiveInt(process.env.METRICS_EXPORT_CHECKPOINT_RETENTION_DAYS);
  if (env !== null) return Math.min(env, 3650);
  return 180;
}

function pruneExpiredCheckpoints({ checkpointState, nowMs }) {
  const retentionMs = checkpointRetentionDays() * 24 * 60 * 60 * 1000;

  for (const [checkpointHash, checkpoint] of Object.entries(checkpointState)) {
    const exportedAtMs = parseIsoMs(checkpoint?.exported_at);
    if (exportedAtMs === null || nowMs > exportedAtMs + retentionMs) {
      delete checkpointState[checkpointHash];
    }
  }
}

export class MetricsNetworkHealthService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureState(this.store);
  }

  _authorize({ operationId, actor, auth, correlationIdValue }) {
    const authz = authorizeApiOperation({ operationId, actor, auth, store: this.store });
    if (!authz.ok) {
      return {
        ok: false,
        result: errorResponse(correlationIdValue, authz.error.code, authz.error.message, authz.error.details)
      };
    }
    return { ok: true };
  }

  _resolveReadContext({ operationId, actor, auth, query }) {
    const corr = correlationId(operationId);

    const authz = this._authorize({ operationId, actor, auth, correlationIdValue: corr });
    if (!authz.ok) return { ok: false, response: { ok: false, body: authz.result } };

    const partner = resolvePartnerScope({ actor, query });
    if (!partner.ok) {
      return {
        ok: false,
        response: {
          ok: false,
          body: errorResponse(corr, partner.code, partner.message, partner.details)
        }
      };
    }

    const window = parseWindowQuery(query);
    if (!window.ok) {
      return {
        ok: false,
        response: {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid metrics query', {
            reason_code: window.reason_code,
            ...window.details
          })
        }
      };
    }

    const context = collectPartnerContext(this.store, partner.partner_id);

    return {
      ok: true,
      correlation_id: corr,
      partner_id: partner.partner_id,
      window,
      context
    };
  }

  getNorthStar({ actor, auth, query }) {
    const op = 'metrics.north_star.get';
    const resolved = this._resolveReadContext({ operationId: op, actor, auth, query });
    if (!resolved.ok) return resolved.response;

    const metrics = computeWindowPackage({
      context: resolved.context,
      fromMs: resolved.window.from_ms,
      toMs: resolved.window.to_ms
    });

    return {
      ok: true,
      body: {
        correlation_id: resolved.correlation_id,
        partner_id: resolved.partner_id,
        window: {
          from_iso: resolved.window.from_iso,
          to_iso: resolved.window.to_iso,
          bucket: resolved.window.bucket
        },
        summary: metrics.summary
      }
    };
  }

  getMarketplaceFunnel({ actor, auth, query }) {
    const op = 'metrics.marketplace_funnel.get';
    const resolved = this._resolveReadContext({ operationId: op, actor, auth, query });
    if (!resolved.ok) return resolved.response;

    const metrics = computeWindowPackage({
      context: resolved.context,
      fromMs: resolved.window.from_ms,
      toMs: resolved.window.to_ms
    });

    return {
      ok: true,
      body: {
        correlation_id: resolved.correlation_id,
        partner_id: resolved.partner_id,
        window: {
          from_iso: resolved.window.from_iso,
          to_iso: resolved.window.to_iso,
          bucket: resolved.window.bucket
        },
        funnel: metrics.funnel
      }
    };
  }

  getPartnerHealth({ actor, auth, query }) {
    const op = 'metrics.partner_health.get';
    const resolved = this._resolveReadContext({ operationId: op, actor, auth, query });
    if (!resolved.ok) return resolved.response;

    const metrics = computeWindowPackage({
      context: resolved.context,
      fromMs: resolved.window.from_ms,
      toMs: resolved.window.to_ms
    });

    return {
      ok: true,
      body: {
        correlation_id: resolved.correlation_id,
        partner_id: resolved.partner_id,
        window: {
          from_iso: resolved.window.from_iso,
          to_iso: resolved.window.to_iso,
          bucket: resolved.window.bucket
        },
        partner_health: metrics.partner_health
      }
    };
  }

  getSafetyHealth({ actor, auth, query }) {
    const op = 'metrics.safety_health.get';
    const resolved = this._resolveReadContext({ operationId: op, actor, auth, query });
    if (!resolved.ok) return resolved.response;

    const metrics = computeWindowPackage({
      context: resolved.context,
      fromMs: resolved.window.from_ms,
      toMs: resolved.window.to_ms
    });

    return {
      ok: true,
      body: {
        correlation_id: resolved.correlation_id,
        partner_id: resolved.partner_id,
        window: {
          from_iso: resolved.window.from_iso,
          to_iso: resolved.window.to_iso,
          bucket: resolved.window.bucket
        },
        safety_health: metrics.safety_health
      }
    };
  }

  exportNetworkHealth({ actor, auth, query }) {
    const op = 'metrics.network_health.export';
    const resolved = this._resolveReadContext({ operationId: op, actor, auth, query });
    if (!resolved.ok) return resolved.response;

    const corr = resolved.correlation_id;
    const nowIso = normalizeOptionalString(query?.now_iso)
      ?? auth?.now_iso
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const nowMs = parseIsoMs(nowIso);
    if (nowMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid metrics export query', {
          reason_code: 'metrics_export_query_invalid',
          now_iso: query?.now_iso ?? null
        })
      };
    }

    const limit = parseLimit(query?.limit, 50);
    if (limit === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid metrics export query', {
          reason_code: 'metrics_export_query_invalid',
          limit: query?.limit ?? null
        })
      };
    }

    const cursorAfter = normalizeOptionalString(query?.cursor_after);
    const attestationAfter = normalizeOptionalString(query?.attestation_after);
    const checkpointAfter = normalizeOptionalString(query?.checkpoint_after);

    if (cursorAfter && !checkpointAfter) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'checkpoint_after is required for metrics export continuation', {
          reason_code: 'metrics_export_checkpoint_required',
          cursor_after: cursorAfter,
          checkpoint_after: checkpointAfter
        })
      };
    }

    if (cursorAfter && !attestationAfter) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid metrics export query', {
          reason_code: 'metrics_export_query_invalid',
          cursor_after: cursorAfter,
          attestation_after: attestationAfter
        })
      };
    }

    if (!cursorAfter && (attestationAfter || checkpointAfter)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid metrics export query', {
          reason_code: 'metrics_export_query_invalid',
          cursor_after: cursorAfter,
          attestation_after: attestationAfter,
          checkpoint_after: checkpointAfter
        })
      };
    }

    const entriesAll = [];
    let bucketBaseMs = floorBucketStartMs(resolved.window.from_ms, resolved.window.bucket);

    while (bucketBaseMs < resolved.window.to_ms) {
      const nextBaseMs = addBucketMs(bucketBaseMs, resolved.window.bucket);
      const bucketFromMs = Math.max(bucketBaseMs, resolved.window.from_ms);
      const bucketToMs = Math.min(nextBaseMs, resolved.window.to_ms);

      if (bucketToMs > bucketFromMs) {
        const metrics = computeWindowPackage({
          context: resolved.context,
          fromMs: bucketFromMs,
          toMs: bucketToMs
        });

        entriesAll.push({
          bucket_start_iso: new Date(bucketFromMs).toISOString(),
          bucket_end_iso: new Date(bucketToMs).toISOString(),
          ...metrics.floor
        });
      }

      bucketBaseMs = nextBaseMs;
    }

    let startIndex = 0;
    if (cursorAfter) {
      const index = entriesAll.findIndex(entry => bucketCursorKey(entry) === cursorAfter);
      if (index < 0) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cursor_after not found for metrics export', {
            reason_code: 'metrics_export_cursor_not_found',
            cursor_after: cursorAfter
          })
        };
      }
      startIndex = index + 1;
    }

    const filteredAfterCursor = entriesAll.slice(startIndex);
    const totalFiltered = filteredAfterCursor.length;
    const page = filteredAfterCursor.slice(0, limit);

    const nextCursor = filteredAfterCursor.length > limit
      ? bucketCursorKey(page[page.length - 1])
      : null;

    const checkpointState = this.store.state.metrics_network_health_export_checkpoints;
    pruneExpiredCheckpoints({ checkpointState, nowMs });

    const contextFingerprint = buildQueryContextFingerprint({
      actor,
      partnerId: resolved.partner_id,
      fromIso: resolved.window.from_iso,
      toIso: resolved.window.to_iso,
      bucket: resolved.window.bucket,
      limit
    });

    if (cursorAfter) {
      const prior = checkpointState[checkpointAfter] ?? null;
      if (!prior) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'metrics export checkpoint mismatch', {
            reason_code: 'metrics_export_checkpoint_mismatch',
            checkpoint_after: checkpointAfter
          })
        };
      }

      if (prior.next_cursor !== cursorAfter
        || prior.attestation_chain_hash !== attestationAfter
        || prior.query_context_fingerprint !== contextFingerprint) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'metrics export checkpoint mismatch', {
            reason_code: 'metrics_export_checkpoint_mismatch',
            checkpoint_after: checkpointAfter,
            cursor_after: cursorAfter,
            attestation_after: attestationAfter
          })
        };
      }
    }

    const exportedAtRaw = normalizeOptionalString(query?.exported_at_iso)
      ?? normalizeOptionalString(query?.now_iso)
      ?? auth?.now_iso
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const exportedAtMs = parseIsoMs(exportedAtRaw);
    if (exportedAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid metrics export query', {
          reason_code: 'metrics_export_query_invalid',
          exported_at_iso: query?.exported_at_iso ?? null
        })
      };
    }

    const exportedAt = new Date(exportedAtMs).toISOString();
    const overallPackage = computeWindowPackage({
      context: resolved.context,
      fromMs: resolved.window.from_ms,
      toMs: resolved.window.to_ms
    });

    const signedPayload = buildSignedPolicyAuditExportPayload({
      exportedAt,
      query: normalizeExportQueryForSigning({
        fromIso: resolved.window.from_iso,
        toIso: resolved.window.to_iso,
        bucket: resolved.window.bucket,
        partnerId: resolved.partner_id,
        limit,
        cursorAfter,
        attestationAfter,
        checkpointAfter,
        nowIso,
        exportedAt
      }),
      entries: page,
      totalFiltered,
      nextCursor,
      withAttestation: true,
      withCheckpoint: true
    });

    if (signedPayload?.checkpoint?.checkpoint_hash) {
      checkpointState[signedPayload.checkpoint.checkpoint_hash] = {
        checkpoint_hash: signedPayload.checkpoint.checkpoint_hash,
        next_cursor: signedPayload.checkpoint.next_cursor ?? null,
        attestation_chain_hash: signedPayload.attestation?.chain_hash ?? null,
        query_context_fingerprint: contextFingerprint,
        exported_at: signedPayload.exported_at
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        partner_id: resolved.partner_id,
        bucket: resolved.window.bucket,
        window: {
          from_iso: resolved.window.from_iso,
          to_iso: resolved.window.to_iso,
          bucket: resolved.window.bucket
        },
        summary: overallPackage.summary,
        ...signedPayload
      }
    };
  }
}
