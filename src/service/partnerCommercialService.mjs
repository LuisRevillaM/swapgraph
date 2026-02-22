import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { canonicalStringify } from '../util/canonicalJson.mjs';
import {
  buildSignedPartnerProgramCommercialUsageExportPayload,
  buildSignedPartnerProgramBillingStatementExportPayload,
  buildSignedPartnerProgramSlaBreachExportPayload,
  buildSignedPartnerProgramWebhookDeadLetterExportPayload,
  buildSignedPartnerProgramDisputeEvidenceBundleExportPayload
} from '../crypto/policyIntegritySigning.mjs';

function errorResponse(correlationId, code, message, details = {}) {
  return {
    correlation_id: correlationId,
    error: {
      code,
      message,
      details
    }
  };
}

function parseIsoMs(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parsePositiveInt(value, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function ensureCommercialState(store) {
  store.state.partner_program_commercial_usage_ledger ||= [];
  store.state.partner_program_sla_policy ||= {};
  store.state.partner_program_sla_breach_events ||= [];
  store.state.partner_program_webhook_delivery_attempts ||= [];
  store.state.partner_program_webhook_retry_policies ||= {};
  store.state.partner_program_risk_tier_policy ||= {};
  store.state.partner_program_risk_tier_usage_counters ||= {};
  store.state.partner_program_disputes ||= [];
  store.state.oauth_clients ||= {};
  store.state.oauth_tokens ||= {};
  store.state.idempotency ||= {};

  return {
    usageLedger: store.state.partner_program_commercial_usage_ledger,
    slaPolicy: store.state.partner_program_sla_policy,
    slaBreaches: store.state.partner_program_sla_breach_events,
    webhookDeliveryAttempts: store.state.partner_program_webhook_delivery_attempts,
    webhookRetryPolicies: store.state.partner_program_webhook_retry_policies,
    riskTierPolicy: store.state.partner_program_risk_tier_policy,
    riskTierUsageCounters: store.state.partner_program_risk_tier_usage_counters,
    disputes: store.state.partner_program_disputes,
    oauthClients: store.state.oauth_clients,
    oauthTokens: store.state.oauth_tokens,
    idempotency: store.state.idempotency
  };
}

function isPartner(actor) {
  return actor?.type === 'partner' && typeof actor?.id === 'string' && actor.id.trim();
}

function payloadHash(payload) {
  return createHash('sha256').update(canonicalStringify(payload), 'utf8').digest('hex');
}

function applyIdempotentMutation({
  store,
  actor,
  operationId,
  idempotencyKey,
  requestPayload,
  mutate,
  correlationId,
  beforeMutate,
  afterMutate
}) {
  const key = normalizeOptionalString(idempotencyKey);
  if (!key) {
    return {
      ok: false,
      body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'idempotency key is required', {
        operation_id: operationId
      })
    };
  }

  const idemState = ensureCommercialState(store).idempotency;
  const scopeKey = `${actor?.type ?? 'unknown'}:${actor?.id ?? 'unknown'}|${operationId}|${key}`;
  const incomingHash = payloadHash(requestPayload);
  const prior = idemState[scopeKey] ?? null;

  if (prior) {
    if (prior.payload_hash !== incomingHash) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH', 'idempotency key reuse with different payload', {
          operation_id: operationId,
          idempotency_key: key
        })
      };
    }

    return {
      ok: true,
      body: {
        ...prior.result,
        replayed: true
      }
    };
  }

  if (typeof beforeMutate === 'function') {
    const pre = beforeMutate();
    if (pre && pre.ok === false) return pre;
  }

  const mutated = mutate();
  if (!mutated.ok) return mutated;

  if (typeof afterMutate === 'function') {
    afterMutate(mutated.body);
  }

  idemState[scopeKey] = {
    payload_hash: incomingHash,
    result: mutated.body
  };

  return {
    ok: true,
    body: {
      ...mutated.body,
      replayed: false
    }
  };
}

function normalizeCommercialUsageEntry(entry) {
  return {
    entry_id: entry.entry_id,
    partner_id: entry.partner_id,
    feature_code: entry.feature_code,
    unit_type: entry.unit_type,
    units: entry.units,
    unit_price_usd_micros: entry.unit_price_usd_micros,
    amount_usd_micros: entry.amount_usd_micros,
    occurred_at: entry.occurred_at,
    metadata: entry.metadata ?? {}
  };
}

function usageEntriesForPartner({ usageLedger, partnerId, fromMs = null, toMs = null, featureCode = null, unitType = null }) {
  const out = [];

  for (const rawEntry of usageLedger ?? []) {
    if (!rawEntry || rawEntry.partner_id !== partnerId) continue;
    if (featureCode && rawEntry.feature_code !== featureCode) continue;
    if (unitType && rawEntry.unit_type !== unitType) continue;

    const occurredMs = parseIsoMs(rawEntry.occurred_at);
    if (occurredMs === null) continue;
    if (fromMs !== null && occurredMs < fromMs) continue;
    if (toMs !== null && occurredMs > toMs) continue;

    out.push(normalizeCommercialUsageEntry(rawEntry));
  }

  out.sort((a, b) => {
    const aMs = parseIsoMs(a.occurred_at) ?? 0;
    const bMs = parseIsoMs(b.occurred_at) ?? 0;
    if (aMs !== bMs) return aMs - bMs;
    return String(a.entry_id).localeCompare(String(b.entry_id));
  });

  return out;
}

function usageSummary(entries) {
  const summary = {
    entries_count: entries.length,
    total_units: 0,
    total_amount_usd_micros: 0,
    feature_breakdown: []
  };

  const bucket = new Map();

  for (const entry of entries) {
    summary.total_units += Number(entry.units ?? 0);
    summary.total_amount_usd_micros += Number(entry.amount_usd_micros ?? 0);

    const k = `${entry.feature_code}|${entry.unit_type}`;
    const prior = bucket.get(k) ?? {
      feature_code: entry.feature_code,
      unit_type: entry.unit_type,
      units: 0,
      amount_usd_micros: 0
    };

    prior.units += Number(entry.units ?? 0);
    prior.amount_usd_micros += Number(entry.amount_usd_micros ?? 0);
    bucket.set(k, prior);
  }

  summary.feature_breakdown = Array.from(bucket.values()).sort((a, b) => {
    const aKey = `${a.feature_code}|${a.unit_type}`;
    const bKey = `${b.feature_code}|${b.unit_type}`;
    return aKey.localeCompare(bKey);
  });

  return summary;
}

function billingStatementFromEntries({ partnerId, periodStartIso, periodEndIso, revSharePartnerBps, entries }) {
  const linesByKey = new Map();

  for (const entry of entries) {
    const key = `${entry.feature_code}|${entry.unit_type}|${entry.unit_price_usd_micros}`;
    const prior = linesByKey.get(key) ?? {
      feature_code: entry.feature_code,
      unit_type: entry.unit_type,
      unit_price_usd_micros: entry.unit_price_usd_micros,
      units: 0,
      amount_usd_micros: 0
    };

    prior.units += Number(entry.units ?? 0);
    prior.amount_usd_micros += Number(entry.amount_usd_micros ?? 0);
    linesByKey.set(key, prior);
  }

  const lines = Array.from(linesByKey.values())
    .sort((a, b) => {
      const aKey = `${a.feature_code}|${a.unit_type}|${a.unit_price_usd_micros}`;
      const bKey = `${b.feature_code}|${b.unit_type}|${b.unit_price_usd_micros}`;
      return aKey.localeCompare(bKey);
    })
    .map((line, idx) => ({
      line_id: `line_${String(idx + 1).padStart(3, '0')}`,
      ...line
    }));

  const gross = lines.reduce((acc, line) => acc + Number(line.amount_usd_micros ?? 0), 0);
  const partnerShare = Math.floor((gross * revSharePartnerBps) / 10000);
  const platformShare = gross - partnerShare;

  return {
    statement_id: `bill_${partnerId}_${periodStartIso.slice(0, 10)}_${periodEndIso.slice(0, 10)}`,
    partner_id: partnerId,
    period_start: periodStartIso,
    period_end: periodEndIso,
    rev_share_partner_bps: revSharePartnerBps,
    lines,
    totals: {
      gross_amount_usd_micros: gross,
      partner_share_usd_micros: partnerShare,
      platform_share_usd_micros: platformShare
    }
  };
}

function normalizeWebhookRetryPolicy(policy) {
  return {
    max_attempts: parsePositiveInt(policy?.max_attempts, { min: 1, max: 20 }) ?? 3,
    backoff_seconds: parsePositiveInt(policy?.backoff_seconds, { min: 0, max: 86400 }) ?? 300
  };
}

function normalizeWebhookDeliveryAttemptRecord(record) {
  const retryPolicy = normalizeWebhookRetryPolicy(record?.retry_policy ?? {});

  return {
    delivery_id: typeof record?.delivery_id === 'string' ? record.delivery_id : null,
    partner_id: typeof record?.partner_id === 'string' ? record.partner_id : null,
    event_type: typeof record?.event_type === 'string' ? record.event_type : null,
    endpoint: typeof record?.endpoint === 'string' ? record.endpoint : null,
    attempt_count: Number.isFinite(record?.attempt_count) ? Number(record.attempt_count) : 0,
    max_attempts: Number.isFinite(record?.max_attempts) ? Number(record.max_attempts) : retryPolicy.max_attempts,
    first_attempt_at: typeof record?.first_attempt_at === 'string' ? record.first_attempt_at : null,
    last_attempt_at: typeof record?.last_attempt_at === 'string' ? record.last_attempt_at : null,
    next_retry_at: typeof record?.next_retry_at === 'string' ? record.next_retry_at : null,
    last_error_code: typeof record?.last_error_code === 'string' ? record.last_error_code : null,
    last_status: typeof record?.last_status === 'string' ? record.last_status : null,
    dead_lettered: record?.dead_lettered === true,
    dead_lettered_at: typeof record?.dead_lettered_at === 'string' ? record.dead_lettered_at : null,
    replayed: record?.replayed === true,
    replayed_at: typeof record?.replayed_at === 'string' ? record.replayed_at : null,
    retry_policy: retryPolicy,
    metadata: record?.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? record.metadata
      : {}
  };
}

function webhookReliabilitySummary(records) {
  const rows = Array.isArray(records) ? records : [];

  return {
    total_attempts: rows.reduce((acc, row) => acc + (Number.isFinite(row?.attempt_count) ? Number(row.attempt_count) : 0), 0),
    deliveries_count: rows.length,
    dead_letter_count: rows.filter(row => row?.dead_lettered === true).length,
    pending_retry_count: rows.filter(row => row?.last_status === 'failed' && row?.dead_lettered !== true && parseIsoMs(row?.next_retry_at) !== null).length,
    replayed_count: rows.filter(row => row?.replayed === true).length
  };
}

function webhookDeadLetterCursorKey(row) {
  const ts = normalizeOptionalString(row?.dead_lettered_at)
    ?? normalizeOptionalString(row?.last_attempt_at)
    ?? '';
  const deliveryId = normalizeOptionalString(row?.delivery_id) ?? '';
  return `${ts}|${deliveryId}`;
}

function webhookDeadLetterEntriesForPartner({ records, partnerId, fromMs = null, toMs = null, includeReplayed = false }) {
  const out = [];

  for (const row of records ?? []) {
    if (!row || row.partner_id !== partnerId) continue;
    if (row.dead_lettered !== true) continue;
    if (!includeReplayed && row.replayed === true) continue;

    const deadLetterMs = parseIsoMs(row.dead_lettered_at ?? row.last_attempt_at);
    if (deadLetterMs === null) continue;
    if (fromMs !== null && deadLetterMs < fromMs) continue;
    if (toMs !== null && deadLetterMs > toMs) continue;

    out.push(normalizeWebhookDeliveryAttemptRecord(row));
  }

  out.sort((a, b) => webhookDeadLetterCursorKey(a).localeCompare(webhookDeadLetterCursorKey(b)));
  return out;
}

function normalizeDisputeEvidenceItems(items) {
  const normalized = Array.isArray(items)
    ? items
      .map(item => ({
        evidence_id: normalizeOptionalString(item?.evidence_id),
        kind: normalizeOptionalString(item?.kind),
        content_hash: normalizeOptionalString(item?.content_hash),
        metadata: item?.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
          ? item.metadata
          : {}
      }))
      .filter(item => item.evidence_id && item.kind && item.content_hash)
    : [];

  normalized.sort((a, b) => String(a.evidence_id).localeCompare(String(b.evidence_id)));
  return normalized;
}

function normalizeDisputeRecord(record) {
  return {
    dispute_id: record.dispute_id,
    partner_id: record.partner_id,
    dispute_type: record.dispute_type,
    severity: record.severity,
    subject_ref: record.subject_ref,
    reason_code: record.reason_code,
    status: record.status,
    opened_at: record.opened_at,
    resolved_at: record.resolved_at ?? null,
    resolution: record.resolution ?? null,
    evidence_items: normalizeDisputeEvidenceItems(record.evidence_items)
  };
}

function disputeEvidenceBundleCursorKey(bundle) {
  const openedAt = normalizeOptionalString(bundle?.opened_at) ?? '';
  const disputeId = normalizeOptionalString(bundle?.dispute_id) ?? '';
  return `${openedAt}|${disputeId}`;
}

function disputeEvidenceBundlesForPartner({ disputes, partnerId, fromMs = null, toMs = null, includeResolved = true }) {
  const out = [];

  for (const dispute of disputes ?? []) {
    if (!dispute || dispute.partner_id !== partnerId) continue;
    if (!includeResolved && dispute.status === 'resolved') continue;

    const openedMs = parseIsoMs(dispute.opened_at);
    if (openedMs === null) continue;
    if (fromMs !== null && openedMs < fromMs) continue;
    if (toMs !== null && openedMs > toMs) continue;

    const normalizedDispute = normalizeDisputeRecord(dispute);
    out.push({
      evidence_bundle_id: `evidence_${normalizedDispute.dispute_id}`,
      ...normalizedDispute
    });
  }

  out.sort((a, b) => disputeEvidenceBundleCursorKey(a).localeCompare(disputeEvidenceBundleCursorKey(b)));
  return out;
}

function disputeSummary(disputes, bundles) {
  const all = Array.isArray(disputes) ? disputes : [];
  const returned = Array.isArray(bundles) ? bundles : [];

  return {
    total_disputes: all.length,
    open_disputes: all.filter(x => x?.status !== 'resolved').length,
    resolved_disputes: all.filter(x => x?.status === 'resolved').length,
    total_evidence_items: all.reduce((acc, row) => acc + (Array.isArray(row?.evidence_items) ? row.evidence_items.length : 0), 0),
    returned_count: returned.length
  };
}

const allowedSlaEventTypes = new Set(['latency', 'availability', 'dispute_response']);
const allowedSeverity = new Set(['low', 'medium', 'high']);
const allowedDisputeTypes = new Set(['delivery', 'billing', 'sla']);
const allowedRiskTiers = new Set(['low', 'medium', 'high']);
const allowedRiskEscalationModes = new Set(['monitor', 'throttle', 'block']);
const riskTierHighRiskWriteOps = new Set([
  'auth.oauth_client.register',
  'auth.oauth_client.rotate',
  'auth.oauth_client.revoke',
  'partnerProgram.webhook_dead_letter.replay'
]);

export class PartnerCommercialService {
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureCommercialState(this.store);
  }

  resolveRiskTierNowMs({ auth, request }) {
    const candidates = [
      normalizeOptionalString(request?.occurred_at),
      normalizeOptionalString(request?.replayed_at),
      normalizeOptionalString(auth?.now_iso),
      normalizeOptionalString(process.env.AUTHZ_NOW_ISO)
    ];

    for (const candidate of candidates) {
      if (!candidate) continue;
      const ms = parseIsoMs(candidate);
      if (ms !== null) return ms;
    }

    return Date.now();
  }

  riskHourBucketIso(nowMs) {
    return new Date(Date.UTC(
      new Date(nowMs).getUTCFullYear(),
      new Date(nowMs).getUTCMonth(),
      new Date(nowMs).getUTCDate(),
      new Date(nowMs).getUTCHours(),
      0,
      0,
      0
    )).toISOString();
  }

  normalizeRiskTierPolicyView(policy) {
    if (!policy || typeof policy !== 'object') return null;

    const blockedOperations = Array.isArray(policy.blocked_operations)
      ? Array.from(new Set(policy.blocked_operations.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()))).sort()
      : [];

    const manualReviewOperations = Array.isArray(policy.manual_review_operations)
      ? Array.from(new Set(policy.manual_review_operations.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()))).sort()
      : [];

    const maxWriteOpsPerHour = parsePositiveInt(policy.max_write_ops_per_hour, { min: 1, max: 1000000 });

    return {
      partner_id: typeof policy.partner_id === 'string' ? policy.partner_id : null,
      version: Number.isFinite(policy.version) ? Number(policy.version) : null,
      tier: typeof policy.tier === 'string' && allowedRiskTiers.has(policy.tier) ? policy.tier : 'low',
      escalation_mode: typeof policy.escalation_mode === 'string' && allowedRiskEscalationModes.has(policy.escalation_mode)
        ? policy.escalation_mode
        : 'monitor',
      max_write_ops_per_hour: maxWriteOpsPerHour,
      blocked_operations: blockedOperations,
      manual_review_operations: manualReviewOperations,
      updated_at: typeof policy.updated_at === 'string' ? policy.updated_at : null
    };
  }

  evaluateRiskTierWriteAccess({ actor, operationId, correlationId, nowMs }) {
    const state = ensureCommercialState(this.store);
    const policy = this.normalizeRiskTierPolicyView(state.riskTierPolicy[actor.id] ?? null);

    if (!policy) return { ok: true };

    if ((policy.blocked_operations ?? []).includes(operationId)) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'operation blocked by risk tier policy', {
          reason_code: 'risk_tier_blocked_operation',
          operation_id: operationId,
          tier: policy.tier,
          escalation_mode: policy.escalation_mode
        })
      };
    }

    const manualReview = policy.manual_review_operations.includes(operationId)
      || (policy.tier === 'high' && riskTierHighRiskWriteOps.has(operationId));

    if (manualReview) {
      return {
        ok: false,
        body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'operation requires manual review under risk tier policy', {
          reason_code: 'risk_tier_manual_review_required',
          operation_id: operationId,
          tier: policy.tier
        })
      };
    }

    const maxWriteOpsPerHour = policy.max_write_ops_per_hour;
    if (maxWriteOpsPerHour !== null) {
      const bucket = this.riskHourBucketIso(nowMs);
      const partnerCounters = state.riskTierUsageCounters[actor.id] ?? {};
      const hourCounters = partnerCounters[bucket] ?? {};
      const observedWrites = Number.isFinite(hourCounters[operationId]) ? Number(hourCounters[operationId]) : 0;

      if (observedWrites >= maxWriteOpsPerHour) {
        return {
          ok: false,
          body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'risk tier throttle exceeded for write operation', {
            reason_code: 'risk_tier_throttle_exceeded',
            operation_id: operationId,
            tier: policy.tier,
            observed_writes_in_hour: observedWrites,
            max_write_ops_per_hour: maxWriteOpsPerHour,
            usage_hour_bucket: bucket
          })
        };
      }
    }

    return { ok: true };
  }

  recordRiskTierWriteUsage({ actor, operationId, nowMs }) {
    const state = ensureCommercialState(this.store);
    const bucket = this.riskHourBucketIso(nowMs);

    state.riskTierUsageCounters[actor.id] ||= {};
    state.riskTierUsageCounters[actor.id][bucket] ||= {};
    const prior = Number.isFinite(state.riskTierUsageCounters[actor.id][bucket][operationId])
      ? Number(state.riskTierUsageCounters[actor.id][bucket][operationId])
      : 0;
    state.riskTierUsageCounters[actor.id][bucket][operationId] = prior + 1;
  }

  upsertRiskTierPolicy({ actor, auth, idempotencyKey, request }) {
    const op = 'partnerProgram.risk_tier_policy.upsert';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can upsert risk tier policy', { actor })
      };
    }

    const tier = normalizeOptionalString(request?.policy?.tier);
    const escalationMode = normalizeOptionalString(request?.policy?.escalation_mode);
    const maxWriteOpsPerHour = parsePositiveInt(request?.policy?.max_write_ops_per_hour, { min: 1, max: 1000000 });

    const blockedOperations = Array.isArray(request?.policy?.blocked_operations)
      ? Array.from(new Set(request.policy.blocked_operations.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()))).sort()
      : [];

    const manualReviewOperations = Array.isArray(request?.policy?.manual_review_operations)
      ? Array.from(new Set(request.policy.manual_review_operations.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()))).sort()
      : [];

    if (!tier || !allowedRiskTiers.has(tier) || !escalationMode || !allowedRiskEscalationModes.has(escalationMode) || maxWriteOpsPerHour === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid risk tier policy payload', {
          reason_code: 'partner_risk_tier_policy_invalid'
        })
      };
    }

    const updatedAtRaw = normalizeOptionalString(request?.occurred_at)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const updatedAtMs = parseIsoMs(updatedAtRaw);
    if (updatedAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid timestamp for risk tier policy upsert', {
          reason_code: 'partner_risk_tier_policy_invalid_timestamp'
        })
      };
    }

    const state = ensureCommercialState(this.store);

    return applyIdempotentMutation({
      store: this.store,
      actor,
      operationId: op,
      idempotencyKey,
      requestPayload: request,
      correlationId: corr,
      mutate: () => {
        const prior = this.normalizeRiskTierPolicyView(state.riskTierPolicy[actor.id] ?? null);
        const nextVersion = Number.isFinite(prior?.version) ? Number(prior.version) + 1 : 1;

        const policy = {
          partner_id: actor.id,
          version: nextVersion,
          tier,
          escalation_mode: escalationMode,
          max_write_ops_per_hour: maxWriteOpsPerHour,
          blocked_operations: blockedOperations,
          manual_review_operations: manualReviewOperations,
          updated_at: new Date(updatedAtMs).toISOString()
        };

        state.riskTierPolicy[actor.id] = policy;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            policy: this.normalizeRiskTierPolicyView(policy)
          }
        };
      }
    });
  }

  getRiskTierPolicy({ actor, auth, query }) {
    const op = 'partnerProgram.risk_tier_policy.get';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can read risk tier policy', { actor })
      };
    }

    const nowIso = normalizeOptionalString(query?.now_iso) ?? new Date().toISOString();
    const nowMs = parseIsoMs(nowIso);
    if (nowMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid risk tier policy query', {
          reason_code: 'partner_risk_tier_policy_query_invalid'
        })
      };
    }

    const state = ensureCommercialState(this.store);
    const policy = this.normalizeRiskTierPolicyView(state.riskTierPolicy[actor.id] ?? null);
    const bucket = this.riskHourBucketIso(nowMs);
    const usageCounts = state.riskTierUsageCounters[actor.id]?.[bucket] ?? {};

    return {
      ok: true,
      body: {
        correlation_id: corr,
        partner_id: actor.id,
        policy,
        usage_hour_bucket: bucket,
        usage_counts: usageCounts
      }
    };
  }

  createDispute({ actor, auth, idempotencyKey, request }) {
    const op = 'partnerProgram.dispute.create';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can create disputes', { actor })
      };
    }

    const disputeType = normalizeOptionalString(request?.dispute_type);
    const severity = normalizeOptionalString(request?.severity) ?? 'medium';
    const subjectRef = normalizeOptionalString(request?.subject_ref);
    const reasonCode = normalizeOptionalString(request?.reason_code);
    const openedAtRaw = normalizeOptionalString(request?.opened_at)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const openedAtMs = parseIsoMs(openedAtRaw);

    if (!disputeType || !allowedDisputeTypes.has(disputeType) || !allowedSeverity.has(severity) || !subjectRef || !reasonCode) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid dispute payload', {
          reason_code: 'partner_dispute_invalid'
        })
      };
    }

    if (openedAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid dispute timestamp', {
          reason_code: 'partner_dispute_invalid_timestamp'
        })
      };
    }

    const evidenceItems = normalizeDisputeEvidenceItems(request?.evidence_items);
    const state = ensureCommercialState(this.store);
    // Keep risk-tier usage bucketing deterministic for dispute scenarios.
    const riskNowMs = this.resolveRiskTierNowMs({
      auth,
      request: {
        ...request,
        occurred_at: normalizeOptionalString(request?.occurred_at) ?? normalizeOptionalString(request?.opened_at)
      }
    });

    return applyIdempotentMutation({
      store: this.store,
      actor,
      operationId: op,
      idempotencyKey,
      requestPayload: request,
      correlationId: corr,
      beforeMutate: () => this.evaluateRiskTierWriteAccess({ actor, operationId: op, correlationId: corr, nowMs: riskNowMs }),
      afterMutate: () => this.recordRiskTierWriteUsage({ actor, operationId: op, nowMs: riskNowMs }),
      mutate: () => {
        const disputeId = `dispute_${String(state.disputes.length + 1).padStart(6, '0')}`;
        const dispute = {
          dispute_id: disputeId,
          partner_id: actor.id,
          dispute_type: disputeType,
          severity,
          subject_ref: subjectRef,
          reason_code: reasonCode,
          status: 'open',
          opened_at: new Date(openedAtMs).toISOString(),
          resolved_at: null,
          resolution: null,
          evidence_items: evidenceItems
        };

        state.disputes.push(dispute);

        const partnerDisputes = state.disputes.filter(row => row?.partner_id === actor.id);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            dispute: normalizeDisputeRecord(dispute),
            summary: disputeSummary(partnerDisputes, partnerDisputes)
          }
        };
      }
    });
  }

  resolveDispute({ actor, auth, idempotencyKey, disputeId, request }) {
    const op = 'partnerProgram.dispute.resolve';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can resolve disputes', { actor })
      };
    }

    const normalizedDisputeId = normalizeOptionalString(disputeId) ?? normalizeOptionalString(request?.dispute_id);
    if (!normalizedDisputeId) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'dispute_id is required for dispute resolve', {
          reason_code: 'partner_dispute_id_required'
        })
      };
    }

    const resolutionCode = normalizeOptionalString(request?.resolution?.code);
    const resolutionNotes = normalizeOptionalString(request?.resolution?.notes);
    if (!resolutionCode) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid dispute resolution payload', {
          reason_code: 'partner_dispute_resolution_invalid'
        })
      };
    }

    const resolvedAtRaw = normalizeOptionalString(request?.resolved_at)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const resolvedAtMs = parseIsoMs(resolvedAtRaw);
    if (resolvedAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid dispute resolution timestamp', {
          reason_code: 'partner_dispute_resolution_invalid_timestamp'
        })
      };
    }

    const state = ensureCommercialState(this.store);
    const dispute = state.disputes.find(row => row?.partner_id === actor.id && row?.dispute_id === normalizedDisputeId) ?? null;

    if (!dispute) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'dispute not found', {
          dispute_id: normalizedDisputeId
        })
      };
    }

    // Keep risk-tier usage bucketing deterministic for dispute scenarios.
    const riskNowMs = this.resolveRiskTierNowMs({
      auth,
      request: {
        ...request,
        occurred_at: normalizeOptionalString(request?.occurred_at) ?? normalizeOptionalString(request?.resolved_at)
      }
    });

    return applyIdempotentMutation({
      store: this.store,
      actor,
      operationId: op,
      idempotencyKey,
      requestPayload: {
        dispute_id: normalizedDisputeId,
        ...(request ?? {})
      },
      correlationId: corr,
      beforeMutate: () => this.evaluateRiskTierWriteAccess({ actor, operationId: op, correlationId: corr, nowMs: riskNowMs }),
      afterMutate: () => this.recordRiskTierWriteUsage({ actor, operationId: op, nowMs: riskNowMs }),
      mutate: () => {
        if (dispute.status !== 'open') {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'dispute is not open', {
              reason_code: 'partner_dispute_not_open',
              dispute_id: normalizedDisputeId
            })
          };
        }

        dispute.status = 'resolved';
        dispute.resolved_at = new Date(resolvedAtMs).toISOString();
        dispute.resolution = {
          code: resolutionCode,
          ...(resolutionNotes ? { notes: resolutionNotes } : {})
        };

        const partnerDisputes = state.disputes.filter(row => row?.partner_id === actor.id);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            dispute: normalizeDisputeRecord(dispute),
            summary: disputeSummary(partnerDisputes, partnerDisputes)
          }
        };
      }
    });
  }

  exportDisputeEvidenceBundles({ actor, auth, query }) {
    const op = 'partnerProgram.dispute.evidence_bundle.export';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can export dispute evidence bundles', { actor })
      };
    }

    const fromIso = normalizeOptionalString(query?.from_iso);
    const toIso = normalizeOptionalString(query?.to_iso);
    const includeResolved = query?.include_resolved !== false;
    const limit = parsePositiveInt(query?.limit ?? 50, { min: 1, max: 200 });
    const cursorAfter = normalizeOptionalString(query?.cursor_after);
    const exportedAtRaw = normalizeOptionalString(query?.exported_at_iso) ?? new Date().toISOString();

    const fromMs = fromIso ? parseIsoMs(fromIso) : null;
    const toMs = toIso ? parseIsoMs(toIso) : null;
    const exportedAtMs = parseIsoMs(exportedAtRaw);

    if ((fromIso && fromMs === null) || (toIso && toMs === null) || exportedAtMs === null || limit === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid dispute evidence export query', {
          reason_code: 'partner_dispute_evidence_export_query_invalid'
        })
      };
    }

    const state = ensureCommercialState(this.store);
    const partnerDisputes = (state.disputes ?? []).filter(row => row?.partner_id === actor.id).map(normalizeDisputeRecord);

    const allBundles = disputeEvidenceBundlesForPartner({
      disputes: partnerDisputes,
      partnerId: actor.id,
      fromMs,
      toMs,
      includeResolved
    });

    let startIndex = 0;
    if (cursorAfter) {
      const idx = allBundles.findIndex(row => disputeEvidenceBundleCursorKey(row) === cursorAfter);
      if (idx < 0) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cursor_after not found in dispute evidence export window', {
            reason_code: 'partner_dispute_evidence_cursor_not_found',
            cursor_after: cursorAfter
          })
        };
      }
      startIndex = idx + 1;
    }

    const bundles = allBundles.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < allBundles.length
      ? disputeEvidenceBundleCursorKey(bundles[bundles.length - 1])
      : null;

    const summary = disputeSummary(partnerDisputes, bundles);

    const normalizedExportedAtIso = new Date(exportedAtMs).toISOString();
    const signedPayload = buildSignedPartnerProgramDisputeEvidenceBundleExportPayload({
      exportedAt: normalizedExportedAtIso,
      query: {
        ...(fromIso ? { from_iso: fromIso } : {}),
        ...(toIso ? { to_iso: toIso } : {}),
        include_resolved: includeResolved,
        limit,
        ...(cursorAfter ? { cursor_after: cursorAfter } : {}),
        ...(normalizeOptionalString(query?.now_iso) ? { now_iso: normalizeOptionalString(query?.now_iso) } : {}),
        exported_at_iso: normalizedExportedAtIso
      },
      summary,
      bundles,
      nextCursor
    });

    return {
      ok: true,
      body: {
        correlation_id: corr,
        ...signedPayload
      }
    };
  }

  recordCommercialUsage({ actor, auth, idempotencyKey, request }) {
    const op = 'partnerProgram.commercial_usage.record';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can record commercial usage', { actor })
      };
    }

    const featureCode = normalizeOptionalString(request?.feature_code);
    const unitType = normalizeOptionalString(request?.unit_type);
    const units = parsePositiveInt(request?.units, { min: 1, max: 1000000 });
    const unitPrice = parsePositiveInt(request?.unit_price_usd_micros, { min: 0, max: 1000000000 });
    const occurredAt = normalizeOptionalString(request?.occurred_at) ?? new Date().toISOString();

    const occurredMs = parseIsoMs(occurredAt);
    if (occurredMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid usage occurred_at timestamp', {
          occurred_at: request?.occurred_at ?? null
        })
      };
    }

    if (!featureCode || !unitType || units === null || unitPrice === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid commercial usage record payload', {
          reason_code: 'partner_commercial_usage_invalid'
        })
      };
    }

    const state = ensureCommercialState(this.store);
    const riskNowMs = this.resolveRiskTierNowMs({ auth, request });

    return applyIdempotentMutation({
      store: this.store,
      actor,
      operationId: op,
      idempotencyKey,
      requestPayload: request,
      correlationId: corr,
      beforeMutate: () => this.evaluateRiskTierWriteAccess({ actor, operationId: op, correlationId: corr, nowMs: riskNowMs }),
      afterMutate: () => this.recordRiskTierWriteUsage({ actor, operationId: op, nowMs: riskNowMs }),
      mutate: () => {
        const entryId = `usage_ledger_${String(state.usageLedger.length + 1).padStart(6, '0')}`;
        const entry = {
          entry_id: entryId,
          partner_id: actor.id,
          feature_code: featureCode,
          unit_type: unitType,
          units,
          unit_price_usd_micros: unitPrice,
          amount_usd_micros: units * unitPrice,
          occurred_at: new Date(occurredMs).toISOString(),
          metadata: request?.metadata && typeof request.metadata === 'object' && !Array.isArray(request.metadata)
            ? request.metadata
            : {}
        };

        state.usageLedger.push(entry);

        const entries = usageEntriesForPartner({ usageLedger: state.usageLedger, partnerId: actor.id });
        const summary = usageSummary(entries);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            entry,
            ledger_summary: {
              partner_id: actor.id,
              ...summary
            }
          }
        };
      }
    });
  }

  exportCommercialUsage({ actor, auth, query }) {
    const op = 'partnerProgram.commercial_usage.export';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can export commercial usage', { actor })
      };
    }

    const fromIso = normalizeOptionalString(query?.from_iso);
    const toIso = normalizeOptionalString(query?.to_iso);
    const exportedAt = normalizeOptionalString(query?.exported_at_iso) ?? new Date().toISOString();
    const featureCode = normalizeOptionalString(query?.feature_code);
    const unitType = normalizeOptionalString(query?.unit_type);

    const fromMs = fromIso ? parseIsoMs(fromIso) : null;
    const toMs = toIso ? parseIsoMs(toIso) : null;
    const exportedAtMs = parseIsoMs(exportedAt);

    if ((fromIso && fromMs === null) || (toIso && toMs === null) || exportedAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid commercial usage export query', {
          reason_code: 'partner_commercial_usage_export_query_invalid'
        })
      };
    }

    const state = ensureCommercialState(this.store);
    const entries = usageEntriesForPartner({
      usageLedger: state.usageLedger,
      partnerId: actor.id,
      fromMs,
      toMs,
      featureCode,
      unitType
    });

    const summary = usageSummary(entries);

    const signedPayload = buildSignedPartnerProgramCommercialUsageExportPayload({
      exportedAt: new Date(exportedAtMs).toISOString(),
      query: {
        ...(fromIso ? { from_iso: fromIso } : {}),
        ...(toIso ? { to_iso: toIso } : {}),
        ...(featureCode ? { feature_code: featureCode } : {}),
        ...(unitType ? { unit_type: unitType } : {}),
        ...(normalizeOptionalString(query?.now_iso) ? { now_iso: normalizeOptionalString(query?.now_iso) } : {}),
        exported_at_iso: new Date(exportedAtMs).toISOString()
      },
      ledgerSummary: {
        partner_id: actor.id,
        ...summary
      },
      entries
    });

    return {
      ok: true,
      body: {
        correlation_id: corr,
        ...signedPayload
      }
    };
  }

  exportBillingStatement({ actor, auth, query }) {
    const op = 'partnerProgram.billing_statement.export';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can export billing statements', { actor })
      };
    }

    const periodStartIso = normalizeOptionalString(query?.period_start_iso);
    const periodEndIso = normalizeOptionalString(query?.period_end_iso);
    const exportedAt = normalizeOptionalString(query?.exported_at_iso) ?? new Date().toISOString();
    const revSharePartnerBps = parsePositiveInt(query?.rev_share_partner_bps ?? 7000, { min: 0, max: 10000 });

    const periodStartMs = parseIsoMs(periodStartIso);
    const periodEndMs = parseIsoMs(periodEndIso);
    const exportedAtMs = parseIsoMs(exportedAt);

    if (!periodStartIso || !periodEndIso || periodStartMs === null || periodEndMs === null || periodEndMs < periodStartMs || exportedAtMs === null || revSharePartnerBps === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid billing statement export query', {
          reason_code: 'partner_billing_statement_export_query_invalid'
        })
      };
    }

    const state = ensureCommercialState(this.store);
    const entries = usageEntriesForPartner({
      usageLedger: state.usageLedger,
      partnerId: actor.id,
      fromMs: periodStartMs,
      toMs: periodEndMs
    });

    const statement = billingStatementFromEntries({
      partnerId: actor.id,
      periodStartIso: new Date(periodStartMs).toISOString(),
      periodEndIso: new Date(periodEndMs).toISOString(),
      revSharePartnerBps,
      entries
    });

    const signedPayload = buildSignedPartnerProgramBillingStatementExportPayload({
      exportedAt: new Date(exportedAtMs).toISOString(),
      query: {
        period_start_iso: new Date(periodStartMs).toISOString(),
        period_end_iso: new Date(periodEndMs).toISOString(),
        rev_share_partner_bps: revSharePartnerBps,
        ...(normalizeOptionalString(query?.now_iso) ? { now_iso: normalizeOptionalString(query?.now_iso) } : {}),
        exported_at_iso: new Date(exportedAtMs).toISOString()
      },
      statement
    });

    return {
      ok: true,
      body: {
        correlation_id: corr,
        ...signedPayload
      }
    };
  }

  upsertSlaPolicy({ actor, auth, idempotencyKey, request }) {
    const op = 'partnerProgram.sla_policy.upsert';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can upsert SLA policy', { actor })
      };
    }

    const latencyP95Ms = parsePositiveInt(request?.policy?.latency_p95_ms, { min: 1, max: 300000 });
    const availabilityTargetBps = parsePositiveInt(request?.policy?.availability_target_bps, { min: 1, max: 10000 });
    const disputeResponseMinutes = parsePositiveInt(request?.policy?.dispute_response_minutes, { min: 1, max: 10080 });
    const breachThresholdMinutes = parsePositiveInt(request?.policy?.breach_threshold_minutes, { min: 1, max: 10080 });

    if (latencyP95Ms === null || availabilityTargetBps === null || disputeResponseMinutes === null || breachThresholdMinutes === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid SLA policy payload', {
          reason_code: 'partner_sla_policy_invalid'
        })
      };
    }

    const state = ensureCommercialState(this.store);
    const riskNowMs = this.resolveRiskTierNowMs({ auth, request });

    return applyIdempotentMutation({
      store: this.store,
      actor,
      operationId: op,
      idempotencyKey,
      requestPayload: request,
      correlationId: corr,
      beforeMutate: () => this.evaluateRiskTierWriteAccess({ actor, operationId: op, correlationId: corr, nowMs: riskNowMs }),
      afterMutate: () => this.recordRiskTierWriteUsage({ actor, operationId: op, nowMs: riskNowMs }),
      mutate: () => {
        const prior = state.slaPolicy[actor.id] ?? null;
        const nextVersion = Number.isFinite(prior?.version) ? Number(prior.version) + 1 : 1;
        const updatedAt = normalizeOptionalString(request?.occurred_at) ?? new Date().toISOString();

        const policy = {
          partner_id: actor.id,
          version: nextVersion,
          updated_at: new Date(parseIsoMs(updatedAt) ?? Date.now()).toISOString(),
          latency_p95_ms: latencyP95Ms,
          availability_target_bps: availabilityTargetBps,
          dispute_response_minutes: disputeResponseMinutes,
          breach_threshold_minutes: breachThresholdMinutes
        };

        state.slaPolicy[actor.id] = policy;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            policy
          }
        };
      }
    });
  }

  recordSlaBreach({ actor, auth, idempotencyKey, request }) {
    const op = 'partnerProgram.sla_breach.record';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can record SLA breaches', { actor })
      };
    }

    const eventType = normalizeOptionalString(request?.event_type);
    const severity = normalizeOptionalString(request?.severity) ?? 'medium';
    const reasonCode = normalizeOptionalString(request?.reason_code);
    const occurredAt = normalizeOptionalString(request?.occurred_at) ?? new Date().toISOString();
    const occurredMs = parseIsoMs(occurredAt);

    if (!eventType || !allowedSlaEventTypes.has(eventType) || !allowedSeverity.has(severity) || !reasonCode || occurredMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid SLA breach event payload', {
          reason_code: 'partner_sla_breach_invalid'
        })
      };
    }

    const state = ensureCommercialState(this.store);
    const riskNowMs = this.resolveRiskTierNowMs({ auth, request });

    return applyIdempotentMutation({
      store: this.store,
      actor,
      operationId: op,
      idempotencyKey,
      requestPayload: request,
      correlationId: corr,
      beforeMutate: () => this.evaluateRiskTierWriteAccess({ actor, operationId: op, correlationId: corr, nowMs: riskNowMs }),
      afterMutate: () => this.recordRiskTierWriteUsage({ actor, operationId: op, nowMs: riskNowMs }),
      mutate: () => {
        const eventId = `sla_breach_${String(state.slaBreaches.length + 1).padStart(6, '0')}`;
        const event = {
          event_id: eventId,
          partner_id: actor.id,
          event_type: eventType,
          severity,
          reason_code: reasonCode,
          occurred_at: new Date(occurredMs).toISOString(),
          resolved: request?.resolved === true,
          resolved_at: request?.resolved_at && parseIsoMs(request.resolved_at) !== null
            ? new Date(parseIsoMs(request.resolved_at)).toISOString()
            : null,
          metadata: request?.metadata && typeof request.metadata === 'object' && !Array.isArray(request.metadata)
            ? request.metadata
            : {}
        };

        state.slaBreaches.push(event);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            event
          }
        };
      }
    });
  }

  exportSlaBreachEvents({ actor, auth, query }) {
    const op = 'partnerProgram.sla_breach.export';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can export SLA breaches', { actor })
      };
    }

    const fromIso = normalizeOptionalString(query?.from_iso);
    const toIso = normalizeOptionalString(query?.to_iso);
    const includeResolved = query?.include_resolved !== false;
    const exportedAt = normalizeOptionalString(query?.exported_at_iso) ?? new Date().toISOString();

    const fromMs = fromIso ? parseIsoMs(fromIso) : null;
    const toMs = toIso ? parseIsoMs(toIso) : null;
    const exportedAtMs = parseIsoMs(exportedAt);

    if ((fromIso && fromMs === null) || (toIso && toMs === null) || exportedAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid SLA breach export query', {
          reason_code: 'partner_sla_breach_export_query_invalid'
        })
      };
    }

    const state = ensureCommercialState(this.store);
    const events = (state.slaBreaches ?? [])
      .filter(event => event?.partner_id === actor.id)
      .filter(event => {
        if (!includeResolved && event?.resolved === true) return false;
        const ms = parseIsoMs(event?.occurred_at);
        if (ms === null) return false;
        if (fromMs !== null && ms < fromMs) return false;
        if (toMs !== null && ms > toMs) return false;
        return true;
      })
      .map(event => ({ ...event }))
      .sort((a, b) => {
        const aMs = parseIsoMs(a.occurred_at) ?? 0;
        const bMs = parseIsoMs(b.occurred_at) ?? 0;
        if (aMs !== bMs) return aMs - bMs;
        return String(a.event_id).localeCompare(String(b.event_id));
      });

    const summary = {
      total_events: events.length,
      open_events: events.filter(x => x.resolved !== true).length,
      high_severity_events: events.filter(x => x.severity === 'high').length
    };

    const signedPayload = buildSignedPartnerProgramSlaBreachExportPayload({
      exportedAt: new Date(exportedAtMs).toISOString(),
      query: {
        ...(fromIso ? { from_iso: fromIso } : {}),
        ...(toIso ? { to_iso: toIso } : {}),
        include_resolved: includeResolved,
        ...(normalizeOptionalString(query?.now_iso) ? { now_iso: normalizeOptionalString(query?.now_iso) } : {}),
        exported_at_iso: new Date(exportedAtMs).toISOString()
      },
      policy: state.slaPolicy[actor.id] ?? null,
      summary,
      events
    });

    return {
      ok: true,
      body: {
        correlation_id: corr,
        ...signedPayload
      }
    };
  }

  getDashboardSummary({ actor, auth, query }) {
    const op = 'partnerProgram.dashboard.summary.get';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can read dashboard summary', { actor })
      };
    }

    const nowIso = normalizeOptionalString(query?.now_iso) ?? new Date().toISOString();
    const nowMs = parseIsoMs(nowIso);
    if (nowMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid now_iso for dashboard summary', {
          now_iso: query?.now_iso ?? null
        })
      };
    }

    const state = ensureCommercialState(this.store);
    const usageLast24h = usageEntriesForPartner({
      usageLedger: state.usageLedger,
      partnerId: actor.id,
      fromMs: nowMs - (24 * 60 * 60 * 1000),
      toMs: nowMs
    });

    const usageSummaryLast24h = usageSummary(usageLast24h);

    const dayStartIso = new Date(Date.UTC(
      new Date(nowMs).getUTCFullYear(),
      new Date(nowMs).getUTCMonth(),
      new Date(nowMs).getUTCDate(),
      0, 0, 0, 0
    )).toISOString();

    const dayStartMs = parseIsoMs(dayStartIso) ?? nowMs;

    const usageToday = usageEntriesForPartner({
      usageLedger: state.usageLedger,
      partnerId: actor.id,
      fromMs: dayStartMs,
      toMs: nowMs
    });

    const billingToday = billingStatementFromEntries({
      partnerId: actor.id,
      periodStartIso: dayStartIso,
      periodEndIso: new Date(nowMs).toISOString(),
      revSharePartnerBps: 7000,
      entries: usageToday
    });

    const slaEvents = (state.slaBreaches ?? []).filter(event => event?.partner_id === actor.id);
    const openSlaEvents = slaEvents.filter(event => event?.resolved !== true);

    return {
      ok: true,
      body: {
        correlation_id: corr,
        partner_id: actor.id,
        as_of: new Date(nowMs).toISOString(),
        usage_last_24h: {
          ...usageSummaryLast24h
        },
        billing_today: billingToday.totals,
        sla: {
          policy: state.slaPolicy[actor.id] ?? null,
          open_breaches: openSlaEvents.length,
          high_severity_open_breaches: openSlaEvents.filter(x => x.severity === 'high').length
        }
      }
    };
  }

  recordWebhookDeliveryAttempt({ actor, auth, idempotencyKey, request }) {
    const op = 'partnerProgram.webhook_delivery.record';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can record webhook delivery attempts', { actor })
      };
    }

    const deliveryId = normalizeOptionalString(request?.delivery_id);
    const eventType = normalizeOptionalString(request?.event_type);
    const endpoint = normalizeOptionalString(request?.endpoint);
    const status = normalizeOptionalString(request?.status);
    const attemptNumber = parsePositiveInt(request?.attempt_number, { min: 1, max: 1000000 });
    const maxAttempts = parsePositiveInt(request?.max_attempts, { min: 1, max: 20 });
    const backoffSeconds = parsePositiveInt(request?.backoff_seconds, { min: 0, max: 86400 });
    const errorCode = normalizeOptionalString(request?.error_code);
    const occurredAtRaw = normalizeOptionalString(request?.occurred_at)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const occurredMs = parseIsoMs(occurredAtRaw);
    const nextRetryAtRaw = normalizeOptionalString(request?.next_retry_at);
    const nextRetryMs = nextRetryAtRaw ? parseIsoMs(nextRetryAtRaw) : null;

    if (!deliveryId || !eventType || !endpoint || !status || !['failed', 'delivered'].includes(status) || attemptNumber === null || maxAttempts === null || backoffSeconds === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid webhook delivery attempt payload', {
          reason_code: 'partner_webhook_attempt_invalid'
        })
      };
    }

    if (occurredMs === null || (nextRetryAtRaw && nextRetryMs === null)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid webhook delivery attempt timestamp', {
          reason_code: 'partner_webhook_attempt_invalid_timestamp'
        })
      };
    }

    if (status === 'failed' && !errorCode) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'failed webhook attempts require error_code', {
          reason_code: 'partner_webhook_attempt_error_required'
        })
      };
    }

    const state = ensureCommercialState(this.store);
    const riskNowMs = this.resolveRiskTierNowMs({ auth, request });

    return applyIdempotentMutation({
      store: this.store,
      actor,
      operationId: op,
      idempotencyKey,
      requestPayload: request,
      correlationId: corr,
      beforeMutate: () => this.evaluateRiskTierWriteAccess({ actor, operationId: op, correlationId: corr, nowMs: riskNowMs }),
      afterMutate: () => this.recordRiskTierWriteUsage({ actor, operationId: op, nowMs: riskNowMs }),
      mutate: () => {
        const existing = state.webhookDeliveryAttempts.find(row => row?.partner_id === actor.id && row?.delivery_id === deliveryId) ?? null;

        if (existing && attemptNumber <= Number(existing.attempt_count ?? 0)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'webhook attempt number must strictly increase', {
              reason_code: 'partner_webhook_attempt_sequence_invalid',
              delivery_id: deliveryId,
              prior_attempt_count: Number(existing.attempt_count ?? 0)
            })
          };
        }

        const occurredIso = new Date(occurredMs).toISOString();
        const deadLettered = status === 'failed' && attemptNumber >= maxAttempts;
        const computedNextRetryIso = status === 'failed' && !deadLettered
          ? new Date((nextRetryMs ?? (occurredMs + (backoffSeconds * 1000)))).toISOString()
          : null;

        const record = existing ?? {
          delivery_id: deliveryId,
          partner_id: actor.id,
          event_type: eventType,
          endpoint,
          attempt_count: 0,
          max_attempts: maxAttempts,
          first_attempt_at: occurredIso,
          last_attempt_at: occurredIso,
          next_retry_at: null,
          last_error_code: null,
          last_status: status,
          dead_lettered: false,
          dead_lettered_at: null,
          replayed: false,
          replayed_at: null,
          retry_policy: normalizeWebhookRetryPolicy({ max_attempts: maxAttempts, backoff_seconds: backoffSeconds }),
          metadata: {}
        };

        record.event_type = eventType;
        record.endpoint = endpoint;
        record.attempt_count = attemptNumber;
        record.max_attempts = maxAttempts;
        record.last_attempt_at = occurredIso;
        record.last_status = status;
        record.last_error_code = status === 'failed' ? errorCode : null;
        record.dead_lettered = deadLettered;
        record.dead_lettered_at = deadLettered ? occurredIso : null;
        record.next_retry_at = computedNextRetryIso;
        record.retry_policy = normalizeWebhookRetryPolicy({ max_attempts: maxAttempts, backoff_seconds: backoffSeconds });
        record.metadata = request?.metadata && typeof request.metadata === 'object' && !Array.isArray(request.metadata)
          ? request.metadata
          : {};

        if (!existing) state.webhookDeliveryAttempts.push(record);
        state.webhookRetryPolicies[actor.id] = normalizeWebhookRetryPolicy({ max_attempts: maxAttempts, backoff_seconds: backoffSeconds });

        const partnerRecords = state.webhookDeliveryAttempts.filter(row => row?.partner_id === actor.id);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            record: normalizeWebhookDeliveryAttemptRecord(record),
            summary: webhookReliabilitySummary(partnerRecords)
          }
        };
      }
    });
  }

  exportWebhookDeadLetters({ actor, auth, query }) {
    const op = 'partnerProgram.webhook_dead_letter.export';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can export webhook dead letters', { actor })
      };
    }

    const fromIso = normalizeOptionalString(query?.from_iso);
    const toIso = normalizeOptionalString(query?.to_iso);
    const includeReplayed = query?.include_replayed === true;
    const limit = parsePositiveInt(query?.limit ?? 50, { min: 1, max: 200 });
    const cursorAfter = normalizeOptionalString(query?.cursor_after);
    const exportedAtRaw = normalizeOptionalString(query?.exported_at_iso) ?? new Date().toISOString();

    const fromMs = fromIso ? parseIsoMs(fromIso) : null;
    const toMs = toIso ? parseIsoMs(toIso) : null;
    const exportedAtMs = parseIsoMs(exportedAtRaw);

    if ((fromIso && fromMs === null) || (toIso && toMs === null) || limit === null || exportedAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid webhook dead-letter export query', {
          reason_code: 'partner_webhook_dead_letter_export_query_invalid'
        })
      };
    }

    const state = ensureCommercialState(this.store);
    const partnerRecords = (state.webhookDeliveryAttempts ?? []).filter(row => row?.partner_id === actor.id);
    const allDeadLetters = webhookDeadLetterEntriesForPartner({
      records: partnerRecords,
      partnerId: actor.id,
      fromMs,
      toMs,
      includeReplayed
    });

    let startIndex = 0;
    if (cursorAfter) {
      const idx = allDeadLetters.findIndex(row => webhookDeadLetterCursorKey(row) === cursorAfter);
      if (idx < 0) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cursor_after not found in dead-letter export window', {
            reason_code: 'webhook_dead_letter_cursor_not_found',
            cursor_after: cursorAfter
          })
        };
      }
      startIndex = idx + 1;
    }

    const entries = allDeadLetters.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < allDeadLetters.length
      ? webhookDeadLetterCursorKey(entries[entries.length - 1])
      : null;

    const reliabilitySummary = webhookReliabilitySummary(partnerRecords);
    const summary = {
      ...reliabilitySummary,
      returned_count: entries.length
    };

    const normalizedExportedAtIso = new Date(exportedAtMs).toISOString();
    const signedPayload = buildSignedPartnerProgramWebhookDeadLetterExportPayload({
      exportedAt: normalizedExportedAtIso,
      query: {
        ...(fromIso ? { from_iso: fromIso } : {}),
        ...(toIso ? { to_iso: toIso } : {}),
        include_replayed: includeReplayed,
        limit,
        ...(cursorAfter ? { cursor_after: cursorAfter } : {}),
        ...(normalizeOptionalString(query?.now_iso) ? { now_iso: normalizeOptionalString(query?.now_iso) } : {}),
        exported_at_iso: normalizedExportedAtIso
      },
      summary,
      entries,
      nextCursor
    });

    return {
      ok: true,
      body: {
        correlation_id: corr,
        ...signedPayload
      }
    };
  }

  replayWebhookDeadLetter({ actor, auth, idempotencyKey, request }) {
    const op = 'partnerProgram.webhook_dead_letter.replay';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can replay dead-letter deliveries', { actor })
      };
    }

    const deliveryId = normalizeOptionalString(request?.delivery_id);
    const replayMode = normalizeOptionalString(request?.replay_mode) ?? 'retry_now';
    const replayedAtRaw = normalizeOptionalString(request?.replayed_at)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const replayedAtMs = parseIsoMs(replayedAtRaw);

    if (!deliveryId || !['retry_now', 'backfill'].includes(replayMode)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid dead-letter replay payload', {
          reason_code: 'partner_webhook_dead_letter_replay_invalid'
        })
      };
    }

    if (replayedAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid replayed_at timestamp', {
          reason_code: 'partner_webhook_dead_letter_replay_invalid_timestamp'
        })
      };
    }

    const state = ensureCommercialState(this.store);
    const record = state.webhookDeliveryAttempts.find(row => row?.partner_id === actor.id && row?.delivery_id === deliveryId) ?? null;

    if (!record) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'webhook delivery record not found', {
          delivery_id: deliveryId
        })
      };
    }

    const riskNowMs = this.resolveRiskTierNowMs({ auth, request });

    return applyIdempotentMutation({
      store: this.store,
      actor,
      operationId: op,
      idempotencyKey,
      requestPayload: {
        delivery_id: deliveryId,
        ...(request ?? {})
      },
      correlationId: corr,
      beforeMutate: () => this.evaluateRiskTierWriteAccess({ actor, operationId: op, correlationId: corr, nowMs: riskNowMs }),
      afterMutate: () => this.recordRiskTierWriteUsage({ actor, operationId: op, nowMs: riskNowMs }),
      mutate: () => {
        if (record.dead_lettered !== true) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'delivery is not in dead-letter state', {
              reason_code: 'partner_webhook_not_dead_letter',
              delivery_id: deliveryId
            })
          };
        }

        const replayedAtIso = new Date(replayedAtMs).toISOString();
        record.replayed = true;
        record.replayed_at = replayedAtIso;
        record.metadata = {
          ...(record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata) ? record.metadata : {}),
          replay_mode: replayMode,
          ...(normalizeOptionalString(request?.backfill_reference)
            ? { backfill_reference: normalizeOptionalString(request?.backfill_reference) }
            : {})
        };

        if (replayMode === 'retry_now') {
          record.next_retry_at = replayedAtIso;
        }

        const partnerRecords = state.webhookDeliveryAttempts.filter(row => row?.partner_id === actor.id);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            replay_mode: replayMode,
            record: normalizeWebhookDeliveryAttemptRecord(record),
            summary: webhookReliabilitySummary(partnerRecords)
          }
        };
      }
    });
  }

  registerOauthClient({ actor, auth, idempotencyKey, request }) {
    const op = 'auth.oauth_client.register';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can register oauth clients', { actor })
      };
    }

    const clientName = normalizeOptionalString(request?.client_name);
    const redirectUris = Array.isArray(request?.redirect_uris)
      ? request.redirect_uris.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim())
      : [];
    const scopes = Array.isArray(request?.scopes)
      ? request.scopes.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim())
      : [];

    if (!clientName || redirectUris.length === 0 || scopes.length === 0) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid oauth client registration payload', {
          reason_code: 'oauth_client_registration_invalid'
        })
      };
    }

    const state = ensureCommercialState(this.store);
    const nowIsoRaw = normalizeOptionalString(request?.occurred_at)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const nowMs = parseIsoMs(nowIsoRaw);
    if (nowMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid timestamp for oauth client registration', {
          reason_code: 'oauth_client_registration_invalid_timestamp',
          now_iso: nowIsoRaw
        })
      };
    }

    return applyIdempotentMutation({
      store: this.store,
      actor,
      operationId: op,
      idempotencyKey,
      requestPayload: request,
      correlationId: corr,
      beforeMutate: () => this.evaluateRiskTierWriteAccess({ actor, operationId: op, correlationId: corr, nowMs }),
      afterMutate: () => this.recordRiskTierWriteUsage({ actor, operationId: op, nowMs }),
      mutate: () => {
        const ordinal = Object.keys(state.oauthClients).length + 1;
        const clientId = `oc_${createHash('sha256').update(`${actor.id}:${clientName}:${ordinal}`, 'utf8').digest('hex').slice(0, 16)}`;
        const createdAt = new Date(nowMs).toISOString();

        const client = {
          client_id: clientId,
          owner_partner_id: actor.id,
          client_name: clientName,
          redirect_uris: Array.from(new Set(redirectUris)).sort(),
          scopes: Array.from(new Set(scopes)).sort(),
          secret_version: 1,
          secret_key_id: `${clientId}_sk_v1`,
          status: 'active',
          created_at: createdAt,
          updated_at: createdAt,
          revoked_at: null
        };

        const issuedTestToken = `oc_tok_${clientId}_v1`;

        state.oauthClients[clientId] = client;
        state.oauthTokens[issuedTestToken] = {
          token: issuedTestToken,
          client_id: clientId,
          partner_id: actor.id,
          scopes: client.scopes,
          active: true,
          issued_at: createdAt,
          expires_at: new Date(Date.parse(createdAt) + (24 * 60 * 60 * 1000)).toISOString()
        };

        return {
          ok: true,
          body: {
            correlation_id: corr,
            client,
            issued_test_token: issuedTestToken
          }
        };
      }
    });
  }

  rotateOauthClientSecret({ actor, auth, idempotencyKey, clientId, request }) {
    const op = 'auth.oauth_client.rotate';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    const normalizedClientId = normalizeOptionalString(clientId) ?? normalizeOptionalString(request?.client_id);
    if (!normalizedClientId) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'client_id is required for oauth rotate', {
          reason_code: 'oauth_client_id_required'
        })
      };
    }

    const state = ensureCommercialState(this.store);
    const client = state.oauthClients[normalizedClientId] ?? null;

    if (!client || client.owner_partner_id !== actor?.id) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'oauth client not found', {
          client_id: normalizedClientId
        })
      };
    }

    const nowIsoRaw = normalizeOptionalString(request?.occurred_at)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const nowMs = parseIsoMs(nowIsoRaw);
    if (nowMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid timestamp for oauth client rotate', {
          reason_code: 'oauth_client_rotate_invalid_timestamp',
          now_iso: nowIsoRaw
        })
      };
    }

    return applyIdempotentMutation({
      store: this.store,
      actor,
      operationId: op,
      idempotencyKey,
      requestPayload: {
        client_id: normalizedClientId,
        ...(request ?? {})
      },
      correlationId: corr,
      beforeMutate: () => this.evaluateRiskTierWriteAccess({ actor, operationId: op, correlationId: corr, nowMs }),
      afterMutate: () => this.recordRiskTierWriteUsage({ actor, operationId: op, nowMs }),
      mutate: () => {
        if (client.status !== 'active') {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'oauth client is not active', {
              reason_code: 'oauth_client_not_active',
              client_id: normalizedClientId
            })
          };
        }

        const nowIso = new Date(nowMs).toISOString();
        client.secret_version = Number(client.secret_version ?? 1) + 1;
        client.secret_key_id = `${normalizedClientId}_sk_v${client.secret_version}`;
        client.updated_at = nowIso;

        const issuedTestToken = `oc_tok_${normalizedClientId}_v${client.secret_version}`;
        state.oauthTokens[issuedTestToken] = {
          token: issuedTestToken,
          client_id: normalizedClientId,
          partner_id: actor.id,
          scopes: client.scopes,
          active: true,
          issued_at: nowIso,
          expires_at: new Date(Date.parse(nowIso) + (24 * 60 * 60 * 1000)).toISOString()
        };

        return {
          ok: true,
          body: {
            correlation_id: corr,
            client,
            issued_test_token: issuedTestToken
          }
        };
      }
    });
  }

  revokeOauthClient({ actor, auth, idempotencyKey, clientId, request }) {
    const op = 'auth.oauth_client.revoke';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    const normalizedClientId = normalizeOptionalString(clientId) ?? normalizeOptionalString(request?.client_id);
    if (!normalizedClientId) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'client_id is required for oauth revoke', {
          reason_code: 'oauth_client_id_required'
        })
      };
    }

    const state = ensureCommercialState(this.store);
    const client = state.oauthClients[normalizedClientId] ?? null;

    if (!client || client.owner_partner_id !== actor?.id) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'oauth client not found', {
          client_id: normalizedClientId
        })
      };
    }

    const nowIsoRaw = normalizeOptionalString(request?.occurred_at)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const nowMs = parseIsoMs(nowIsoRaw);
    if (nowMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid timestamp for oauth client revoke', {
          reason_code: 'oauth_client_revoke_invalid_timestamp',
          now_iso: nowIsoRaw
        })
      };
    }

    return applyIdempotentMutation({
      store: this.store,
      actor,
      operationId: op,
      idempotencyKey,
      requestPayload: {
        client_id: normalizedClientId,
        ...(request ?? {})
      },
      correlationId: corr,
      beforeMutate: () => this.evaluateRiskTierWriteAccess({ actor, operationId: op, correlationId: corr, nowMs }),
      afterMutate: () => this.recordRiskTierWriteUsage({ actor, operationId: op, nowMs }),
      mutate: () => {
        const nowIso = new Date(nowMs).toISOString();
        client.status = 'revoked';
        client.revoked_at = nowIso;
        client.updated_at = nowIso;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            client
          }
        };
      }
    });
  }

  introspectOauthToken({ actor, auth, request }) {
    const op = 'auth.oauth_token.introspect';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    const token = normalizeOptionalString(request?.token);
    if (!token) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'token is required for oauth introspection', {
          reason_code: 'oauth_token_required'
        })
      };
    }

    const state = ensureCommercialState(this.store);
    const record = state.oauthTokens[token] ?? null;

    if (!record) {
      return {
        ok: true,
        body: {
          correlation_id: corr,
          active: false,
          client_id: null,
          reason_code: 'token_unknown',
          scopes: [],
          exp: null,
          iat: null
        }
      };
    }

    const nowIsoRaw = normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const nowMs = parseIsoMs(nowIsoRaw);
    if (nowMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid timestamp for oauth token introspection', {
          reason_code: 'oauth_token_introspect_invalid_timestamp',
          now_iso: nowIsoRaw
        })
      };
    }

    const client = state.oauthClients[record.client_id] ?? null;
    const expMs = parseIsoMs(record.expires_at);

    let active = record.active === true;
    let reasonCode = null;

    if (!client) {
      active = false;
      reasonCode = 'client_unknown';
    } else if (client.status !== 'active') {
      active = false;
      reasonCode = 'client_revoked';
    } else if (expMs !== null && nowMs > expMs) {
      active = false;
      reasonCode = 'token_expired';
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        active,
        client_id: record.client_id,
        reason_code: reasonCode,
        scopes: Array.isArray(record.scopes) ? record.scopes : [],
        exp: record.expires_at ?? null,
        iat: record.issued_at ?? null
      }
    };
  }
}
