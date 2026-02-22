import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';

const NOTIFICATION_TYPES = [
  'proposal.created',
  'proposal.expiring',
  'settlement.deposit_required',
  'settlement.deposit_deadline_approaching',
  'cycle.executing',
  'cycle.completed',
  'cycle.failed',
  'refund.completed',
  'intent.demand_signal'
];

const NOTIFICATION_TYPE_SET = new Set(NOTIFICATION_TYPES);
const URGENCY_LEVELS = new Set(['low', 'normal', 'high', 'critical']);
const URGENCY_RANK = {
  low: 1,
  normal: 2,
  high: 3,
  critical: 4
};

const PARTNER_UI_SURFACES = new Map([
  ['intent-composer', {
    surface: 'intent-composer',
    version: '1.0.0',
    required_operations: ['swapIntents.create', 'swapIntents.update'],
    title: 'Intent Composer',
    description: 'Compose and refine swap intents with policy-aware defaults.'
  }],
  ['cycle-proposal-cards', {
    surface: 'cycle-proposal-cards',
    version: '1.0.0',
    required_operations: ['productProjection.cycle_inbox.list', 'cycleProposals.get'],
    title: 'Cycle Proposal Cards',
    description: 'Render proposal cards with confidence, explainability, and fee context.'
  }],
  ['settlement-checklist', {
    surface: 'settlement-checklist',
    version: '1.0.0',
    required_operations: ['productProjection.settlement_timeline.get', 'settlement.instructions', 'settlement.status'],
    title: 'Settlement Checklist',
    description: 'Guide users through deposit, execution, and completion tasks.'
  }],
  ['receipt-renderer', {
    surface: 'receipt-renderer',
    version: '1.0.0',
    required_operations: ['productProjection.receipt_share.get', 'receipts.get'],
    title: 'Receipt Renderer',
    description: 'Render public-safe receipt cards with privacy toggles.'
  }]
]);

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

function actorScopeKey(actor) {
  return `${actor?.type ?? 'unknown'}:${actor?.id ?? 'unknown'}`;
}

function stableId(prefix, value) {
  const digest = createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 16);
  return `${prefix}_${digest}`;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function defaultCategoryOptIn() {
  const out = {};
  for (const type of NOTIFICATION_TYPES) out[type] = true;
  return out;
}

function parseQuietHours(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const enabled = value.enabled;
  const start = Number.parseInt(String(value.start_hour_utc ?? ''), 10);
  const end = Number.parseInt(String(value.end_hour_utc ?? ''), 10);

  if (typeof enabled !== 'boolean' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > 23 || end < 0 || end > 23) {
    return null;
  }

  return {
    enabled,
    start_hour_utc: start,
    end_hour_utc: end
  };
}

function parseCategoryOptIn(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const out = {};
  for (const type of NOTIFICATION_TYPES) {
    if (typeof value[type] !== 'boolean') return null;
    out[type] = value[type];
  }

  return out;
}

function defaultPreferences({ actor, nowIso }) {
  return {
    actor: {
      type: actor.type,
      id: actor.id
    },
    quiet_hours: {
      enabled: true,
      start_hour_utc: 22,
      end_hour_utc: 7
    },
    urgency_threshold: 'normal',
    category_opt_in: defaultCategoryOptIn(),
    demand_signal_opt_in: false,
    updated_at: nowIso
  };
}

function normalizePreferenceRecord(record) {
  return {
    actor: {
      type: record.actor.type,
      id: record.actor.id
    },
    quiet_hours: {
      enabled: record.quiet_hours.enabled === true,
      start_hour_utc: Number(record.quiet_hours.start_hour_utc),
      end_hour_utc: Number(record.quiet_hours.end_hour_utc)
    },
    urgency_threshold: record.urgency_threshold,
    category_opt_in: { ...record.category_opt_in },
    demand_signal_opt_in: record.demand_signal_opt_in === true,
    updated_at: record.updated_at
  };
}

function ensureState(store) {
  store.state.notification_preferences ||= {};
  store.state.idempotency ||= {};
}

function proposalPartnerId({ store, proposalId }) {
  return store?.state?.tenancy?.proposals?.[proposalId]?.partner_id
    ?? store?.state?.tenancy?.cycles?.[proposalId]?.partner_id
    ?? null;
}

function userParticipatesInProposal({ actor, proposal }) {
  if (actor?.type !== 'user') return false;
  return (proposal?.participants ?? []).some(participant => participant?.actor?.type === 'user' && participant?.actor?.id === actor.id);
}

function userParticipatesInTimeline({ actor, timeline }) {
  if (actor?.type !== 'user') return false;
  return (timeline?.legs ?? []).some(leg => leg?.from_actor?.type === 'user' && leg?.from_actor?.id === actor.id)
    || (timeline?.legs ?? []).some(leg => leg?.to_actor?.type === 'user' && leg?.to_actor?.id === actor.id);
}

function actorCanReadCycle({ store, actor, cycleId }) {
  if (!actor || !cycleId) return false;

  if (actor.type === 'partner') return proposalPartnerId({ store, proposalId: cycleId }) === actor.id;

  if (actor.type === 'user') {
    const proposal = store.state?.proposals?.[cycleId] ?? null;
    if (proposal && userParticipatesInProposal({ actor, proposal })) return true;

    const timeline = store.state?.timelines?.[cycleId] ?? null;
    if (timeline && userParticipatesInTimeline({ actor, timeline })) return true;
  }

  return false;
}

function visibleProposals({ store, actor }) {
  const proposals = Object.values(store.state?.proposals ?? {});

  if (actor?.type === 'partner') {
    return proposals.filter(proposal => proposalPartnerId({ store, proposalId: proposal.id }) === actor.id);
  }

  if (actor?.type === 'user') {
    return proposals.filter(proposal => userParticipatesInProposal({ actor, proposal }));
  }

  return [];
}

function visibleTimelines({ store, actor }) {
  const rows = Object.values(store.state?.timelines ?? {});

  if (actor?.type === 'partner') {
    return rows.filter(timeline => proposalPartnerId({ store, proposalId: timeline.cycle_id }) === actor.id);
  }

  if (actor?.type === 'user') {
    return rows.filter(timeline => userParticipatesInTimeline({ actor, timeline }));
  }

  return [];
}

function visibleReceipts({ store, actor }) {
  const receipts = Object.values(store.state?.receipts ?? {});
  return receipts.filter(receipt => actorCanReadCycle({ store, actor, cycleId: receipt?.cycle_id ?? null }));
}

function isInQuietHours({ occurredMs, quietHours }) {
  if (!quietHours?.enabled) return false;
  const hour = new Date(occurredMs).getUTCHours();
  const start = quietHours.start_hour_utc;
  const end = quietHours.end_hour_utc;

  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function urgencyPassesThreshold({ urgency, threshold }) {
  const urgencyRank = URGENCY_RANK[urgency] ?? 0;
  const thresholdRank = URGENCY_RANK[threshold] ?? URGENCY_RANK.normal;
  return urgencyRank >= thresholdRank;
}

function notificationFromProposalCreated({ actor, proposal }) {
  const occurredMs = parseIsoMs(proposal?.created_at) ?? parseIsoMs(proposal?.expires_at);
  if (occurredMs === null) return null;

  return {
    notification_id: stableId('notif', `${actorScopeKey(actor)}|proposal.created|${proposal.id}`),
    type: 'proposal.created',
    urgency: 'normal',
    occurred_at: new Date(occurredMs).toISOString(),
    title: 'New proposal available',
    body: `Cycle ${proposal.id} is ready for review.`,
    refs: {
      proposal_id: proposal.id,
      cycle_id: proposal.id
    }
  };
}

function notificationFromProposalExpiring({ actor, proposal, nowMs }) {
  const expiresMs = parseIsoMs(proposal?.expires_at);
  if (expiresMs === null || expiresMs <= nowMs || expiresMs > nowMs + (24 * 60 * 60 * 1000)) return null;

  return {
    notification_id: stableId('notif', `${actorScopeKey(actor)}|proposal.expiring|${proposal.id}`),
    type: 'proposal.expiring',
    urgency: 'high',
    occurred_at: new Date(expiresMs).toISOString(),
    title: 'Proposal expires soon',
    body: `Cycle ${proposal.id} requires action before expiry.`,
    refs: {
      proposal_id: proposal.id,
      cycle_id: proposal.id,
      deadline_at: proposal.expires_at
    }
  };
}

function notificationFromTimeline({ actor, timeline, nowMs }) {
  const out = [];
  const updatedMs = parseIsoMs(timeline?.updated_at) ?? nowMs;

  if (timeline?.state === 'escrow.pending') {
    out.push({
      notification_id: stableId('notif', `${actorScopeKey(actor)}|settlement.deposit_required|${timeline.cycle_id}`),
      type: 'settlement.deposit_required',
      urgency: 'high',
      occurred_at: new Date(updatedMs).toISOString(),
      title: 'Deposit required',
      body: `Cycle ${timeline.cycle_id} is waiting for deposit confirmation.`,
      refs: {
        cycle_id: timeline.cycle_id
      }
    });

    const pendingDeadlines = (timeline.legs ?? [])
      .map(leg => parseIsoMs(leg?.deposit_deadline_at))
      .filter(ms => ms !== null && ms > nowMs)
      .sort((a, b) => a - b);

    const deadlineMs = pendingDeadlines[0] ?? null;
    if (deadlineMs !== null && deadlineMs <= nowMs + (6 * 60 * 60 * 1000)) {
      out.push({
        notification_id: stableId('notif', `${actorScopeKey(actor)}|settlement.deposit_deadline_approaching|${timeline.cycle_id}`),
        type: 'settlement.deposit_deadline_approaching',
        urgency: 'high',
        occurred_at: new Date(deadlineMs).toISOString(),
        title: 'Deposit deadline approaching',
        body: `Cycle ${timeline.cycle_id} deposit deadline is approaching.`,
        refs: {
          cycle_id: timeline.cycle_id,
          deadline_at: new Date(deadlineMs).toISOString()
        }
      });
    }
  }

  if (timeline?.state === 'executing') {
    out.push({
      notification_id: stableId('notif', `${actorScopeKey(actor)}|cycle.executing|${timeline.cycle_id}`),
      type: 'cycle.executing',
      urgency: 'normal',
      occurred_at: new Date(updatedMs).toISOString(),
      title: 'Cycle executing',
      body: `Cycle ${timeline.cycle_id} is now executing.`,
      refs: {
        cycle_id: timeline.cycle_id
      }
    });
  }

  if (timeline?.state === 'completed') {
    out.push({
      notification_id: stableId('notif', `${actorScopeKey(actor)}|cycle.completed|${timeline.cycle_id}`),
      type: 'cycle.completed',
      urgency: 'low',
      occurred_at: new Date(updatedMs).toISOString(),
      title: 'Cycle completed',
      body: `Cycle ${timeline.cycle_id} completed successfully.`,
      refs: {
        cycle_id: timeline.cycle_id
      }
    });
  }

  if (timeline?.state === 'failed') {
    out.push({
      notification_id: stableId('notif', `${actorScopeKey(actor)}|cycle.failed|${timeline.cycle_id}`),
      type: 'cycle.failed',
      urgency: 'high',
      occurred_at: new Date(updatedMs).toISOString(),
      title: 'Cycle failed',
      body: `Cycle ${timeline.cycle_id} failed and may require remediation.`,
      refs: {
        cycle_id: timeline.cycle_id
      }
    });
  }

  return out;
}

function notificationFromReceiptRefund({ actor, receipt }) {
  if (receipt?.final_state !== 'failed') return null;
  const createdMs = parseIsoMs(receipt?.created_at);
  if (createdMs === null) return null;

  return {
    notification_id: stableId('notif', `${actorScopeKey(actor)}|refund.completed|${receipt.id}`),
    type: 'refund.completed',
    urgency: 'normal',
    occurred_at: new Date(createdMs).toISOString(),
    title: 'Refund completed',
    body: `Cycle ${receipt.cycle_id} settled as failed; refund processing completed.`,
    refs: {
      receipt_id: receipt.id,
      cycle_id: receipt.cycle_id
    }
  };
}

function notificationFromDemandSignal({ actor, intent }) {
  const intentId = normalizeOptionalString(intent?.id);
  if (!intentId) return null;
  if ((intent?.status ?? 'active') !== 'active') return null;

  const occurredMs = parseIsoMs(intent?.created_at) ?? parseIsoMs(intent?.updated_at) ?? Date.now();
  const actorId = actor?.type === 'user' ? actor.id : (intent?.actor?.id ?? 'unknown');

  return {
    notification_id: stableId('notif', `${actorScopeKey(actor)}|intent.demand_signal|${intentId}`),
    type: 'intent.demand_signal',
    urgency: 'low',
    occurred_at: new Date(occurredMs).toISOString(),
    title: 'Demand signal detected',
    body: `Potential demand signal for actor ${actorId}.`,
    refs: {
      intent_id: intentId
    }
  };
}

function buildNotifications({ store, actor, nowMs }) {
  const rows = [];

  const proposals = visibleProposals({ store, actor });
  for (const proposal of proposals) {
    const created = notificationFromProposalCreated({ actor, proposal });
    if (created) rows.push(created);

    const expiring = notificationFromProposalExpiring({ actor, proposal, nowMs });
    if (expiring) rows.push(expiring);
  }

  const timelines = visibleTimelines({ store, actor });
  for (const timeline of timelines) {
    rows.push(...notificationFromTimeline({ actor, timeline, nowMs }));
  }

  const receipts = visibleReceipts({ store, actor });
  for (const receipt of receipts) {
    const refund = notificationFromReceiptRefund({ actor, receipt });
    if (refund) rows.push(refund);
  }

  if (actor?.type === 'user') {
    for (const intent of Object.values(store.state?.intents ?? {})) {
      if (intent?.actor?.type !== 'user' || intent?.actor?.id !== actor.id) continue;
      const demand = notificationFromDemandSignal({ actor, intent });
      if (demand) rows.push(demand);
    }
  }

  if (actor?.type === 'partner') {
    const partnerIntentIds = new Set();
    for (const proposal of proposals) {
      for (const participant of proposal?.participants ?? []) {
        const intentId = normalizeOptionalString(participant?.intent_id);
        if (intentId) partnerIntentIds.add(intentId);
      }
    }

    for (const intentId of Array.from(partnerIntentIds).sort()) {
      const intent = store.state?.intents?.[intentId] ?? null;
      if (!intent) continue;
      const demand = notificationFromDemandSignal({ actor, intent });
      if (demand) rows.push(demand);
    }
  }

  return rows;
}

function normalizeProjectionQuery({ query, allowedKeys }) {
  for (const key of Object.keys(query ?? {})) {
    if (!allowedKeys.has(key)) {
      return { ok: false, key };
    }
  }
  return { ok: true };
}

function feeSummary(proposal) {
  const fees = Array.isArray(proposal?.fee_breakdown) ? proposal.fee_breakdown : [];
  const total = fees.reduce((acc, row) => acc + (Number.isFinite(row?.fee_usd) ? Number(row.fee_usd) : 0), 0);

  return {
    total_fee_usd: round2(total),
    participant_fee_count: fees.length
  };
}

function confidenceBps(proposal) {
  const score = Number(proposal?.confidence_score);
  if (!Number.isFinite(score) || score < 0) return 0;
  return Math.min(10000, Math.max(0, Math.round(score * 10000)));
}

function actorProposalAssets({ actor, proposal }) {
  if (actor?.type === 'user') {
    const participant = (proposal?.participants ?? []).find(row => row?.actor?.type === 'user' && row?.actor?.id === actor.id) ?? null;

    if (participant) {
      return {
        give_assets: (participant.give ?? []).map(asset => asset?.asset_id).filter(Boolean),
        get_assets: (participant.get ?? []).map(asset => asset?.asset_id).filter(Boolean)
      };
    }
  }

  const giveSet = new Set();
  const getSet = new Set();

  for (const participant of proposal?.participants ?? []) {
    for (const asset of participant?.give ?? []) {
      const id = normalizeOptionalString(asset?.asset_id);
      if (id) giveSet.add(id);
    }

    for (const asset of participant?.get ?? []) {
      const id = normalizeOptionalString(asset?.asset_id);
      if (id) getSet.add(id);
    }
  }

  return {
    give_assets: Array.from(giveSet).sort(),
    get_assets: Array.from(getSet).sort()
  };
}

function nextActionForTimeline(timeline) {
  if (timeline?.state === 'escrow.pending') return 'confirm_deposit';
  if (timeline?.state === 'escrow.ready') return 'begin_execution';
  if (timeline?.state === 'executing') return 'complete_settlement';
  return 'none';
}

function completedStepsForTimeline(timeline) {
  const out = [];
  const state = timeline?.state;

  if (state) out.push('cycle_started');

  const hasDeposits = (timeline?.legs ?? []).some(leg => ['deposited', 'released', 'refunded'].includes(leg?.status));
  if (hasDeposits) out.push('deposit_confirmed');

  if (state === 'executing' || state === 'completed') out.push('execution_started');
  if (state === 'completed' || state === 'failed') out.push('terminal_state_reached');

  return out;
}

export class ProductSurfaceReadinessService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureState(this.store);
  }

  _withIdempotency({ actor, operationId, idempotencyKey, requestBody, correlationId: correlationIdValue, handler }) {
    const scopeKey = idempotencyScopeKey({ actor, operationId, idempotencyKey });
    const requestHash = payloadHash(requestBody);

    const existing = this.store.state.idempotency[scopeKey];
    if (existing) {
      if (existing.payload_hash === requestHash) return { replayed: true, result: JSON.parse(JSON.stringify(existing.result)) };
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(
            correlationIdValue,
            'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH',
            'idempotency key reused with a different payload',
            { operation_id: operationId, idempotency_key: idempotencyKey }
          )
        }
      };
    }

    const result = handler();
    this.store.state.idempotency[scopeKey] = {
      payload_hash: requestHash,
      result: JSON.parse(JSON.stringify(result))
    };

    return { replayed: false, result };
  }

  _authorize({ operationId, actor, auth, corr }) {
    const authz = authorizeApiOperation({ operationId, actor, auth, store: this.store });
    if (!authz.ok) {
      return { ok: false, response: { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) } };
    }

    return { ok: true };
  }

  getNotificationPreferences({ actor, auth }) {
    const op = 'notifications.preferences.get';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, corr });
    if (!authz.ok) return authz.response;

    const nowIso = normalizeOptionalString(auth?.now_iso) ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
    const stored = this.store.state.notification_preferences[actorScopeKey(actor)] ?? defaultPreferences({ actor, nowIso });

    return {
      ok: true,
      body: {
        correlation_id: corr,
        preference: normalizePreferenceRecord(stored)
      }
    };
  }

  upsertNotificationPreferences({ actor, auth, idempotencyKey, request }) {
    const op = 'notifications.preferences.upsert';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, corr });
    if (!authz.ok) {
      return {
        replayed: false,
        result: authz.response
      };
    }

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const prefs = request?.preferences;
        if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid notification preferences payload', {
              reason_code: 'notification_preferences_invalid'
            })
          };
        }

        const quietHours = parseQuietHours(prefs.quiet_hours);
        const urgencyThreshold = normalizeOptionalString(prefs.urgency_threshold);
        const categoryOptIn = parseCategoryOptIn(prefs.category_opt_in);
        const demandSignalOptIn = prefs.demand_signal_opt_in;

        if (!quietHours || !urgencyThreshold || !URGENCY_LEVELS.has(urgencyThreshold) || !categoryOptIn || typeof demandSignalOptIn !== 'boolean') {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid notification preferences payload', {
              reason_code: 'notification_preferences_invalid'
            })
          };
        }

        const updatedAtRaw = normalizeOptionalString(request?.recorded_at)
          ?? normalizeOptionalString(auth?.now_iso)
          ?? process.env.AUTHZ_NOW_ISO
          ?? new Date().toISOString();
        const updatedAtMs = parseIsoMs(updatedAtRaw);

        if (updatedAtMs === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid notification preferences timestamp', {
              reason_code: 'notification_preferences_invalid_timestamp',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const row = {
          actor: {
            type: actor.type,
            id: actor.id
          },
          quiet_hours: quietHours,
          urgency_threshold: urgencyThreshold,
          category_opt_in: categoryOptIn,
          demand_signal_opt_in: demandSignalOptIn,
          updated_at: new Date(updatedAtMs).toISOString()
        };

        this.store.state.notification_preferences[actorScopeKey(actor)] = row;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            preference: normalizePreferenceRecord(row)
          }
        };
      }
    });
  }

  listNotificationInbox({ actor, auth, query }) {
    const op = 'notifications.inbox.list';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, corr });
    if (!authz.ok) return authz.response;

    const queryCheck = normalizeProjectionQuery({
      query,
      allowedKeys: new Set(['from_iso', 'to_iso', 'limit', 'category', 'now_iso'])
    });

    if (!queryCheck.ok) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid notification inbox query', {
          reason_code: 'notification_inbox_query_invalid',
          key: queryCheck.key
        })
      };
    }

    const fromIso = normalizeOptionalString(query?.from_iso);
    const toIso = normalizeOptionalString(query?.to_iso);
    const fromMs = fromIso ? parseIsoMs(fromIso) : null;
    const toMs = toIso ? parseIsoMs(toIso) : null;
    const limit = parseLimit(query?.limit, 50);
    const categoryFilter = normalizeOptionalString(query?.category);
    const nowIso = normalizeOptionalString(query?.now_iso)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const nowMs = parseIsoMs(nowIso);

    if ((fromIso && fromMs === null)
      || (toIso && toMs === null)
      || (fromMs !== null && toMs !== null && toMs <= fromMs)
      || limit === null
      || (categoryFilter && !NOTIFICATION_TYPE_SET.has(categoryFilter))
      || nowMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid notification inbox query', {
          reason_code: 'notification_inbox_query_invalid'
        })
      };
    }

    const prefs = this.store.state.notification_preferences[actorScopeKey(actor)] ?? defaultPreferences({ actor, nowIso: new Date(nowMs).toISOString() });

    const notifications = buildNotifications({ store: this.store, actor, nowMs })
      .filter(item => {
        const occurredMs = parseIsoMs(item?.occurred_at);
        if (occurredMs === null) return false;
        if (fromMs !== null && occurredMs < fromMs) return false;
        if (toMs !== null && occurredMs >= toMs) return false;
        if (categoryFilter && item.type !== categoryFilter) return false;

        if (prefs.category_opt_in?.[item.type] !== true) return false;
        if (item.type === 'intent.demand_signal' && prefs.demand_signal_opt_in !== true) return false;
        if (!urgencyPassesThreshold({ urgency: item.urgency, threshold: prefs.urgency_threshold })) return false;

        const quiet = isInQuietHours({ occurredMs, quietHours: prefs.quiet_hours });
        if (quiet && (URGENCY_RANK[item.urgency] ?? 0) < URGENCY_RANK.high) return false;

        return true;
      });

    notifications.sort((a, b) => {
      const aMs = parseIsoMs(a?.occurred_at) ?? 0;
      const bMs = parseIsoMs(b?.occurred_at) ?? 0;
      if (aMs !== bMs) return bMs - aMs;
      return String(a?.notification_id ?? '').localeCompare(String(b?.notification_id ?? ''));
    });

    const totalFiltered = notifications.length;
    const page = notifications.slice(0, limit).map(item => ({
      notification_id: item.notification_id,
      type: item.type,
      urgency: item.urgency,
      occurred_at: item.occurred_at,
      title: item.title,
      body: item.body,
      refs: item.refs ?? {}
    }));

    return {
      ok: true,
      body: {
        correlation_id: corr,
        notifications: page,
        total_filtered: totalFiltered,
        taxonomy: [...NOTIFICATION_TYPES]
      }
    };
  }

  getInventoryAwakeningProjection({ actor, auth, query }) {
    const op = 'productProjection.inventory_awakening.get';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, corr });
    if (!authz.ok) return authz.response;

    const queryCheck = normalizeProjectionQuery({ query, allowedKeys: new Set(['limit']) });
    const limit = parseLimit(query?.limit, 3);

    if (!queryCheck.ok || limit === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid product projection query', {
          reason_code: 'product_projection_query_invalid'
        })
      };
    }

    const proposals = visibleProposals({ store: this.store, actor });
    proposals.sort((a, b) => String(a?.id ?? '').localeCompare(String(b?.id ?? '')));

    const visibleIntentIds = new Set();
    for (const proposal of proposals) {
      for (const participant of proposal?.participants ?? []) {
        const intentId = normalizeOptionalString(participant?.intent_id);
        if (intentId) visibleIntentIds.add(intentId);
      }
    }

    const intents = [];
    if (actor?.type === 'user') {
      for (const intent of Object.values(this.store.state?.intents ?? {})) {
        if (intent?.actor?.type === 'user' && intent?.actor?.id === actor.id) intents.push(intent);
      }
    }

    if (actor?.type === 'partner') {
      for (const intentId of Array.from(visibleIntentIds).sort()) {
        const intent = this.store.state?.intents?.[intentId] ?? null;
        if (intent) intents.push(intent);
      }
    }

    const activeIntentCount = intents.filter(intent => (intent?.status ?? 'active') === 'active').length;
    const avgConfidenceBps = proposals.length > 0
      ? Math.round(proposals.reduce((acc, proposal) => acc + confidenceBps(proposal), 0) / proposals.length)
      : 0;

    const recommendations = proposals.slice(0, limit).map(proposal => {
      const assets = actorProposalAssets({ actor, proposal });
      const rationale = Array.isArray(proposal?.explainability) && proposal.explainability.length > 0
        ? String(proposal.explainability[0])
        : 'Use this proposal to bootstrap first-cycle participation.';

      return {
        recommendation_id: stableId('rec', `${actorScopeKey(actor)}|${proposal.id}`),
        cycle_id: proposal.id,
        suggested_give_asset_id: assets.give_assets[0] ?? null,
        suggested_get_asset_id: assets.get_assets[0] ?? null,
        confidence_bps: confidenceBps(proposal),
        rationale
      };
    });

    return {
      ok: true,
      body: {
        correlation_id: corr,
        projection: {
          swappability_summary: {
            intents_total: intents.length,
            active_intents: activeIntentCount,
            cycle_opportunities: proposals.length,
            average_confidence_bps: avgConfidenceBps
          },
          recommended_first_intents: recommendations
        }
      }
    };
  }

  listCycleInboxProjection({ actor, auth, query }) {
    const op = 'productProjection.cycle_inbox.list';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, corr });
    if (!authz.ok) return authz.response;

    const queryCheck = normalizeProjectionQuery({ query, allowedKeys: new Set(['limit']) });
    const limit = parseLimit(query?.limit, 50);

    if (!queryCheck.ok || limit === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid product projection query', {
          reason_code: 'product_projection_query_invalid'
        })
      };
    }

    const proposals = visibleProposals({ store: this.store, actor });
    proposals.sort((a, b) => String(a?.id ?? '').localeCompare(String(b?.id ?? '')));

    const cards = proposals.slice(0, limit).map(proposal => {
      const assets = actorProposalAssets({ actor, proposal });
      return {
        cycle_id: proposal.id,
        give_assets: assets.give_assets,
        get_assets: assets.get_assets,
        confidence_score_bps: confidenceBps(proposal),
        explainability: Array.isArray(proposal?.explainability) ? proposal.explainability.map(x => String(x)) : [],
        deadline_at: proposal?.expires_at ?? null,
        fee_summary: feeSummary(proposal)
      };
    });

    return {
      ok: true,
      body: {
        correlation_id: corr,
        cards,
        total_filtered: proposals.length
      }
    };
  }

  getSettlementTimelineProjection({ actor, auth, cycleId, query }) {
    const op = 'productProjection.settlement_timeline.get';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, corr });
    if (!authz.ok) return authz.response;

    const queryCheck = normalizeProjectionQuery({ query, allowedKeys: new Set([]) });
    if (!queryCheck.ok) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid product projection query', {
          reason_code: 'product_projection_query_invalid'
        })
      };
    }

    const normalizedCycleId = normalizeOptionalString(cycleId);
    const timeline = normalizedCycleId ? (this.store.state?.timelines?.[normalizedCycleId] ?? null) : null;

    if (!timeline) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'settlement timeline projection not found', {
          reason_code: 'settlement_timeline_not_found',
          cycle_id: normalizedCycleId
        })
      };
    }

    if (!actorCanReadCycle({ store: this.store, actor, cycleId: normalizedCycleId })) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'actor cannot access this settlement timeline', {
          cycle_id: normalizedCycleId,
          actor
        })
      };
    }

    const nextAction = nextActionForTimeline(timeline);
    const pendingDeadlineMs = (timeline.legs ?? [])
      .filter(leg => leg?.status === 'pending')
      .map(leg => parseIsoMs(leg?.deposit_deadline_at))
      .filter(ms => ms !== null)
      .sort((a, b) => a - b)[0] ?? null;

    const progress = {
      legs_total: (timeline.legs ?? []).length,
      legs_deposited: (timeline.legs ?? []).filter(leg => ['deposited', 'released', 'refunded'].includes(leg?.status)).length,
      legs_released: (timeline.legs ?? []).filter(leg => leg?.status === 'released').length,
      legs_refunded: (timeline.legs ?? []).filter(leg => leg?.status === 'refunded').length
    };

    return {
      ok: true,
      body: {
        correlation_id: corr,
        digest: {
          cycle_id: timeline.cycle_id,
          state: timeline.state,
          updated_at: timeline.updated_at,
          completed_steps: completedStepsForTimeline(timeline),
          next_required_action: nextAction,
          next_action_deadline_at: pendingDeadlineMs !== null ? new Date(pendingDeadlineMs).toISOString() : null,
          progress
        }
      }
    };
  }

  getReceiptShareProjection({ actor, auth, receiptId, query }) {
    const op = 'productProjection.receipt_share.get';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, corr });
    if (!authz.ok) return authz.response;

    const queryCheck = normalizeProjectionQuery({ query, allowedKeys: new Set([]) });
    if (!queryCheck.ok) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid product projection query', {
          reason_code: 'product_projection_query_invalid'
        })
      };
    }

    const normalizedReceiptId = normalizeOptionalString(receiptId);
    const receipt = Object.values(this.store.state?.receipts ?? {}).find(row => normalizeOptionalString(row?.id) === normalizedReceiptId) ?? null;

    if (!receipt) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'receipt share projection not found', {
          reason_code: 'receipt_share_not_found',
          receipt_id: normalizedReceiptId
        })
      };
    }

    if (!actorCanReadCycle({ store: this.store, actor, cycleId: receipt.cycle_id })) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'actor cannot access this receipt projection', {
          receipt_id: normalizedReceiptId,
          cycle_id: receipt.cycle_id,
          actor
        })
      };
    }

    const assetCount = Array.isArray(receipt?.asset_ids) ? receipt.asset_ids.length : 0;
    const intentCount = Array.isArray(receipt?.intent_ids) ? receipt.intent_ids.length : 0;

    return {
      ok: true,
      body: {
        correlation_id: corr,
        receipt_share: {
          receipt_id: receipt.id,
          cycle_id: receipt.cycle_id,
          final_state: receipt.final_state,
          created_at: receipt.created_at,
          public_summary: {
            asset_count: assetCount,
            intent_count: intentCount,
            final_state: receipt.final_state
          },
          share_payload: {
            title: `Swap cycle ${receipt.cycle_id}`,
            subtitle: `Final state: ${receipt.final_state}`,
            badge: receipt.final_state === 'completed' ? 'completed' : 'failed'
          },
          privacy: {
            default_mode: 'public_safe',
            modes: ['public_safe', 'private'],
            redacted_fields: ['intent_ids', 'asset_ids'],
            toggle_allowed: true
          }
        }
      }
    };
  }

  getPartnerUiCapabilities({ actor, auth }) {
    const op = 'partnerUi.capabilities.get';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, corr });
    if (!authz.ok) return authz.response;

    if (actor?.type !== 'partner') {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can read partner UI capabilities', { actor })
      };
    }

    const surfaces = Array.from(PARTNER_UI_SURFACES.values())
      .map(def => ({
        surface: def.surface,
        version: def.version,
        status: 'ga',
        required_operations: [...def.required_operations]
      }))
      .sort((a, b) => a.surface.localeCompare(b.surface));

    return {
      ok: true,
      body: {
        correlation_id: corr,
        capabilities: {
          api_version: 'v1',
          integration_modes: ['api_only', 'embedded_ui'],
          surfaces
        }
      }
    };
  }

  getPartnerUiBundle({ actor, auth, surface, query }) {
    const op = 'partnerUi.bundle.get';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, corr });
    if (!authz.ok) return authz.response;

    if (actor?.type !== 'partner') {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can read partner UI bundles', { actor })
      };
    }

    const queryCheck = normalizeProjectionQuery({ query, allowedKeys: new Set(['locale']) });
    if (!queryCheck.ok) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid product projection query', {
          reason_code: 'product_projection_query_invalid'
        })
      };
    }

    const normalizedSurface = normalizeOptionalString(surface);
    const def = normalizedSurface ? (PARTNER_UI_SURFACES.get(normalizedSurface) ?? null) : null;

    if (!def) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'unknown partner UI surface', {
          reason_code: 'partner_ui_surface_unknown',
          surface: normalizedSurface
        })
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        surface_bundle: {
          surface: def.surface,
          version: def.version,
          integration_modes: ['api_only', 'embedded_ui'],
          locale: normalizeOptionalString(query?.locale) ?? 'en-US',
          payload: {
            title: def.title,
            description: def.description,
            required_operations: [...def.required_operations]
          }
        }
      }
    };
  }
}
