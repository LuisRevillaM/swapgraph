import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { canonicalStringify } from '../util/canonicalJson.mjs';
import {
  buildSignedPartnerProgramCommercialUsageExportPayload,
  buildSignedPartnerProgramBillingStatementExportPayload,
  buildSignedPartnerProgramSlaBreachExportPayload
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
  store.state.oauth_clients ||= {};
  store.state.oauth_tokens ||= {};
  store.state.idempotency ||= {};

  return {
    usageLedger: store.state.partner_program_commercial_usage_ledger,
    slaPolicy: store.state.partner_program_sla_policy,
    slaBreaches: store.state.partner_program_sla_breach_events,
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

function applyIdempotentMutation({ store, actor, operationId, idempotencyKey, requestPayload, mutate, correlationId }) {
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

  const mutated = mutate();
  if (!mutated.ok) return mutated;

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

const allowedSlaEventTypes = new Set(['latency', 'availability', 'dispute_response']);
const allowedSeverity = new Set(['low', 'medium', 'high']);

export class PartnerCommercialService {
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureCommercialState(this.store);
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

    return applyIdempotentMutation({
      store: this.store,
      actor,
      operationId: op,
      idempotencyKey,
      requestPayload: request,
      correlationId: corr,
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

    return applyIdempotentMutation({
      store: this.store,
      actor,
      operationId: op,
      idempotencyKey,
      requestPayload: request,
      correlationId: corr,
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

    return applyIdempotentMutation({
      store: this.store,
      actor,
      operationId: op,
      idempotencyKey,
      requestPayload: request,
      correlationId: corr,
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
