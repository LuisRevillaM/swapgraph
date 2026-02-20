import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { canonicalStringify } from '../util/canonicalJson.mjs';
import { signPolicyIntegrityPayload } from '../crypto/policyIntegritySigning.mjs';

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

function parseIntBounded(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function normalizeStringSet(values) {
  if (!Array.isArray(values)) return [];
  const out = values
    .filter(x => typeof x === 'string' && x.trim())
    .map(x => x.trim());

  return Array.from(new Set(out)).sort();
}

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function payloadHash(payload) {
  return createHash('sha256').update(canonicalStringify(payload), 'utf8').digest('hex');
}

function sha256HexCanonical(value) {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function isPartner(actor) {
  return actor?.type === 'partner' && typeof actor?.id === 'string' && actor.id.trim();
}

function ensureReliabilityState(store) {
  store.state.reliability_slo_metrics ||= [];
  store.state.reliability_incident_drills ||= [];
  store.state.reliability_replay_checks ||= [];
  store.state.idempotency ||= {};

  return {
    sloMetrics: store.state.reliability_slo_metrics,
    incidentDrills: store.state.reliability_incident_drills,
    replayChecks: store.state.reliability_replay_checks,
    idempotency: store.state.idempotency
  };
}

function applyIdempotentMutation({ store, actor, operationId, idempotencyKey, requestPayload, mutate, correlationId: corr }) {
  const key = normalizeOptionalString(idempotencyKey);
  if (!key) {
    return {
      ok: false,
      body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'idempotency key is required', {
        operation_id: operationId
      })
    };
  }

  const idemState = ensureReliabilityState(store).idempotency;
  const scopeKey = `${actor?.type ?? 'unknown'}:${actor?.id ?? 'unknown'}|${operationId}|${key}`;
  const incomingHash = payloadHash(requestPayload);
  const prior = idemState[scopeKey] ?? null;

  if (prior) {
    if (prior.payload_hash !== incomingHash) {
      return {
        ok: false,
        body: errorResponse(corr, 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH', 'idempotency key reuse with different payload', {
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

function normalizeSloMetricRequest(request) {
  const metric = request?.metric;
  if (!metric || typeof metric !== 'object' || Array.isArray(metric)) return null;

  const serviceId = normalizeOptionalString(metric.service_id);
  const windowStartRaw = normalizeOptionalString(metric.window_start_at);
  const windowEndRaw = normalizeOptionalString(metric.window_end_at);
  const windowStartMs = parseIsoMs(windowStartRaw);
  const windowEndMs = parseIsoMs(windowEndRaw);

  const targetAvailabilityBps = parseIntBounded(metric.target_availability_bps, { min: 0, max: 10000 });
  const observedAvailabilityBps = parseIntBounded(metric.observed_availability_bps, { min: 0, max: 10000 });
  const targetP95LatencyMs = parseIntBounded(metric.target_p95_latency_ms, { min: 1, max: 120000 });
  const observedP95LatencyMs = parseIntBounded(metric.observed_p95_latency_ms, { min: 1, max: 120000 });
  const errorBudgetConsumedBps = parseIntBounded(metric.error_budget_consumed_bps, { min: 0, max: 10000 });
  const requestCount = parseIntBounded(metric.request_count, { min: 0, max: 1000000000 });

  if (!serviceId
    || windowStartMs === null
    || windowEndMs === null
    || windowEndMs < windowStartMs
    || targetAvailabilityBps === null
    || observedAvailabilityBps === null
    || targetP95LatencyMs === null
    || observedP95LatencyMs === null
    || errorBudgetConsumedBps === null
    || requestCount === null) {
    return null;
  }

  return {
    service_id: serviceId,
    window_start_at: new Date(windowStartMs).toISOString(),
    window_end_at: new Date(windowEndMs).toISOString(),
    target_availability_bps: targetAvailabilityBps,
    observed_availability_bps: observedAvailabilityBps,
    target_p95_latency_ms: targetP95LatencyMs,
    observed_p95_latency_ms: observedP95LatencyMs,
    error_budget_consumed_bps: errorBudgetConsumedBps,
    request_count: requestCount,
    ...(normalizeOptionalString(metric.notes) ? { notes: normalizeOptionalString(metric.notes) } : {})
  };
}

function evaluateSloMetric(metric) {
  const breachReasons = [];

  if (metric.observed_availability_bps < metric.target_availability_bps) {
    breachReasons.push('availability_below_target');
  }

  if (metric.observed_p95_latency_ms > metric.target_p95_latency_ms) {
    breachReasons.push('latency_above_target');
  }

  const maxErrorBudgetBps = Math.max(0, 10000 - metric.target_availability_bps);
  if (metric.error_budget_consumed_bps > maxErrorBudgetBps) {
    breachReasons.push('error_budget_exhausted');
  }

  return {
    passing: breachReasons.length === 0,
    breach_reasons: breachReasons
  };
}

const allowedDrillTypes = new Set(['replay_recovery', 'partial_outage', 'signer_rotation']);
const allowedSeverities = new Set(['sev2', 'sev3', 'sev4']);
const allowedOutcomes = new Set(['pass', 'fail']);

function normalizeIncidentDrillRequest(request) {
  const drill = request?.drill;
  if (!drill || typeof drill !== 'object' || Array.isArray(drill)) return null;

  const drillType = normalizeOptionalString(drill.drill_type);
  const severity = normalizeOptionalString(drill.severity);
  const outcome = normalizeOptionalString(drill.outcome);
  const startedAtRaw = normalizeOptionalString(drill.started_at);
  const resolvedAtRaw = normalizeOptionalString(drill.resolved_at);
  const startedAtMs = parseIsoMs(startedAtRaw);
  const resolvedAtMs = parseIsoMs(resolvedAtRaw);
  const runbookRef = normalizeOptionalString(drill.runbook_ref);
  const evidenceRefs = normalizeStringSet(drill.evidence_refs);
  const targetRecoveryTimeMinutes = parseIntBounded(drill.target_recovery_time_minutes, { min: 1, max: 100000 });

  if (!drillType
    || !allowedDrillTypes.has(drillType)
    || !severity
    || !allowedSeverities.has(severity)
    || !outcome
    || !allowedOutcomes.has(outcome)
    || startedAtMs === null
    || resolvedAtMs === null
    || resolvedAtMs < startedAtMs
    || !runbookRef
    || evidenceRefs.length === 0
    || targetRecoveryTimeMinutes === null) {
    return null;
  }

  return {
    drill_type: drillType,
    severity,
    outcome,
    started_at: new Date(startedAtMs).toISOString(),
    resolved_at: new Date(resolvedAtMs).toISOString(),
    runbook_ref: runbookRef,
    evidence_refs: evidenceRefs,
    target_recovery_time_minutes: targetRecoveryTimeMinutes,
    ...(normalizeOptionalString(drill.notes) ? { notes: normalizeOptionalString(drill.notes) } : {})
  };
}

function isHex64(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function normalizeReplayCheckRequest(request) {
  const check = request?.replay_check;
  if (!check || typeof check !== 'object' || Array.isArray(check)) return null;

  const scenarioId = normalizeOptionalString(check.scenario_id);
  const recoveryMode = normalizeOptionalString(check.recovery_mode);
  const eventCount = parseIntBounded(check.event_count, { min: 1, max: 100000000 });
  const sourceLogHash = normalizeOptionalString(check.source_log_hash);
  const replayLogHash = normalizeOptionalString(check.replay_log_hash);
  const expectedStateHash = normalizeOptionalString(check.expected_state_hash);
  const recoveredStateHash = normalizeOptionalString(check.recovered_state_hash);

  if (!scenarioId
    || !recoveryMode
    || !['full_replay', 'checkpoint_replay'].includes(recoveryMode)
    || eventCount === null
    || !isHex64(sourceLogHash)
    || !isHex64(replayLogHash)
    || !isHex64(expectedStateHash)
    || !isHex64(recoveredStateHash)) {
    return null;
  }

  return {
    scenario_id: scenarioId,
    recovery_mode: recoveryMode,
    event_count: eventCount,
    source_log_hash: sourceLogHash,
    replay_log_hash: replayLogHash,
    expected_state_hash: expectedStateHash,
    recovered_state_hash: recoveredStateHash,
    ...(normalizeOptionalString(check.notes) ? { notes: normalizeOptionalString(check.notes) } : {})
  };
}

function evaluateReplayCheck(check) {
  let reasonCode = null;

  if (check.source_log_hash !== check.replay_log_hash) {
    reasonCode = 'replay_log_hash_mismatch';
  } else if (check.expected_state_hash !== check.recovered_state_hash) {
    reasonCode = 'recovery_state_hash_mismatch';
  }

  return {
    passing: reasonCode === null,
    reason_code: reasonCode
  };
}

function normalizeSloMetricRecord(record) {
  return {
    metric_id: record.metric_id,
    partner_id: record.partner_id,
    service_id: record.service_id,
    window_start_at: record.window_start_at,
    window_end_at: record.window_end_at,
    target_availability_bps: Number(record.target_availability_bps ?? 0),
    observed_availability_bps: Number(record.observed_availability_bps ?? 0),
    target_p95_latency_ms: Number(record.target_p95_latency_ms ?? 0),
    observed_p95_latency_ms: Number(record.observed_p95_latency_ms ?? 0),
    error_budget_consumed_bps: Number(record.error_budget_consumed_bps ?? 0),
    request_count: Number(record.request_count ?? 0),
    passing: record.passing === true,
    breach_reasons: normalizeStringSet(record.breach_reasons),
    integration_mode: 'fixture_only',
    recorded_at: record.recorded_at,
    ...(normalizeOptionalString(record.notes) ? { notes: normalizeOptionalString(record.notes) } : {})
  };
}

function normalizeIncidentDrillRecord(record) {
  return {
    drill_record_id: record.drill_record_id,
    partner_id: record.partner_id,
    drill_type: record.drill_type,
    severity: record.severity,
    outcome: record.outcome,
    started_at: record.started_at,
    resolved_at: record.resolved_at,
    recovery_time_minutes: Number(record.recovery_time_minutes ?? 0),
    target_recovery_time_minutes: Number(record.target_recovery_time_minutes ?? 0),
    within_target: record.within_target === true,
    runbook_ref: record.runbook_ref,
    evidence_refs: normalizeStringSet(record.evidence_refs),
    integration_mode: 'fixture_only',
    recorded_at: record.recorded_at,
    ...(normalizeOptionalString(record.notes) ? { notes: normalizeOptionalString(record.notes) } : {})
  };
}

function normalizeReplayCheckRecord(record) {
  return {
    replay_check_id: record.replay_check_id,
    partner_id: record.partner_id,
    scenario_id: record.scenario_id,
    recovery_mode: record.recovery_mode,
    event_count: Number(record.event_count ?? 0),
    source_log_hash: record.source_log_hash,
    replay_log_hash: record.replay_log_hash,
    expected_state_hash: record.expected_state_hash,
    recovered_state_hash: record.recovered_state_hash,
    passing: record.passing === true,
    reason_code: record.reason_code ?? null,
    integration_mode: 'fixture_only',
    recorded_at: record.recorded_at,
    ...(normalizeOptionalString(record.notes) ? { notes: normalizeOptionalString(record.notes) } : {})
  };
}

function conformanceSummary({ sloMetrics, incidentDrills, replayChecks }) {
  const sloTotal = sloMetrics.length;
  const sloPassing = sloMetrics.filter(x => x.passing === true).length;
  const drillTotal = incidentDrills.length;
  const drillPassing = incidentDrills.filter(x => x.outcome === 'pass').length;
  const replayTotal = replayChecks.length;
  const replayPassing = replayChecks.filter(x => x.passing === true).length;

  const failing = (sloTotal - sloPassing) + (drillTotal - drillPassing) + (replayTotal - replayPassing);

  return {
    slo_total: sloTotal,
    slo_passing: sloPassing,
    slo_failing: sloTotal - sloPassing,
    drills_total: drillTotal,
    drills_passing: drillPassing,
    drills_failing: drillTotal - drillPassing,
    replay_checks_total: replayTotal,
    replay_checks_passing: replayPassing,
    replay_checks_failing: replayTotal - replayPassing,
    overall_passing: failing === 0 && (sloTotal + drillTotal + replayTotal) > 0
  };
}

function normalizeLimit(value) {
  return parseIntBounded(value, { min: 1, max: 200 });
}

export class ReliabilityConformanceService {
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureReliabilityState(this.store);
  }

  recordSloMetric({ actor, auth, idempotencyKey, request }) {
    const op = 'reliability.slo.record';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can record reliability slo metrics', { actor })
      };
    }

    const normalized = normalizeSloMetricRequest(request);
    if (!normalized) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid reliability slo metric payload', {
          reason_code: 'reliability_slo_metric_invalid'
        })
      };
    }

    const occurredAtRaw = normalizeOptionalString(request?.occurred_at)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const occurredAtMs = parseIsoMs(occurredAtRaw);

    if (occurredAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid reliability slo metric timestamp', {
          reason_code: 'reliability_slo_metric_invalid_timestamp'
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
        const state = ensureReliabilityState(this.store);
        const evalResult = evaluateSloMetric(normalized);

        const record = {
          metric_id: `slo_metric_${String(state.sloMetrics.length + 1).padStart(6, '0')}`,
          partner_id: actor.id,
          ...normalized,
          passing: evalResult.passing,
          breach_reasons: evalResult.breach_reasons,
          integration_mode: 'fixture_only',
          recorded_at: new Date(occurredAtMs).toISOString()
        };

        state.sloMetrics.push(record);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            metric: normalizeSloMetricRecord(record)
          }
        };
      }
    });
  }

  recordIncidentDrill({ actor, auth, idempotencyKey, request }) {
    const op = 'reliability.incident_drill.record';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can record incident drills', { actor })
      };
    }

    const normalized = normalizeIncidentDrillRequest(request);
    if (!normalized) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid reliability incident drill payload', {
          reason_code: 'reliability_incident_drill_invalid'
        })
      };
    }

    const occurredAtRaw = normalizeOptionalString(request?.occurred_at)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const occurredAtMs = parseIsoMs(occurredAtRaw);

    if (occurredAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid incident drill timestamp', {
          reason_code: 'reliability_incident_drill_invalid_timestamp'
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
        const state = ensureReliabilityState(this.store);
        const startedMs = parseIsoMs(normalized.started_at);
        const resolvedMs = parseIsoMs(normalized.resolved_at);
        const recoveryTimeMinutes = Math.floor((resolvedMs - startedMs) / 60000);

        const record = {
          drill_record_id: `incident_drill_${String(state.incidentDrills.length + 1).padStart(6, '0')}`,
          partner_id: actor.id,
          ...normalized,
          recovery_time_minutes: recoveryTimeMinutes,
          within_target: recoveryTimeMinutes <= normalized.target_recovery_time_minutes,
          integration_mode: 'fixture_only',
          recorded_at: new Date(occurredAtMs).toISOString()
        };

        state.incidentDrills.push(record);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            drill: normalizeIncidentDrillRecord(record)
          }
        };
      }
    });
  }

  recordReplayCheck({ actor, auth, idempotencyKey, request }) {
    const op = 'reliability.replay_check.record';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can record replay checks', { actor })
      };
    }

    const normalized = normalizeReplayCheckRequest(request);
    if (!normalized) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid reliability replay check payload', {
          reason_code: 'reliability_replay_check_invalid'
        })
      };
    }

    const occurredAtRaw = normalizeOptionalString(request?.occurred_at)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const occurredAtMs = parseIsoMs(occurredAtRaw);

    if (occurredAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid replay check timestamp', {
          reason_code: 'reliability_replay_check_invalid_timestamp'
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
        const state = ensureReliabilityState(this.store);
        const evalResult = evaluateReplayCheck(normalized);

        const record = {
          replay_check_id: `replay_check_${String(state.replayChecks.length + 1).padStart(6, '0')}`,
          partner_id: actor.id,
          ...normalized,
          passing: evalResult.passing,
          reason_code: evalResult.reason_code,
          integration_mode: 'fixture_only',
          recorded_at: new Date(occurredAtMs).toISOString()
        };

        state.replayChecks.push(record);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            replay_check: normalizeReplayCheckRecord(record)
          }
        };
      }
    });
  }

  exportConformance({ actor, auth, query }) {
    const op = 'reliability.conformance.export';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can export reliability conformance', { actor })
      };
    }

    const nowRaw = normalizeOptionalString(query?.now_iso)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();
    const nowMs = parseIsoMs(nowRaw);

    const fromIsoRaw = normalizeOptionalString(query?.from_iso);
    const toIsoRaw = normalizeOptionalString(query?.to_iso);
    const fromMs = fromIsoRaw ? parseIsoMs(fromIsoRaw) : null;
    const toMs = toIsoRaw ? parseIsoMs(toIsoRaw) : null;
    const limit = normalizeLimit(query?.limit);

    if (nowMs === null || (fromIsoRaw && fromMs === null) || (toIsoRaw && toMs === null) || (fromMs !== null && toMs !== null && toMs < fromMs)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid reliability conformance export query', {
          reason_code: 'reliability_conformance_export_query_invalid'
        })
      };
    }

    const state = ensureReliabilityState(this.store);
    const inWindow = record => {
      const t = parseIsoMs(record?.recorded_at);
      if (t === null) return false;
      if (fromMs !== null && t < fromMs) return false;
      if (toMs !== null && t > toMs) return false;
      return record?.partner_id === actor.id;
    };

    let sloRows = state.sloMetrics.filter(inWindow).map(normalizeSloMetricRecord);
    let drillRows = state.incidentDrills.filter(inWindow).map(normalizeIncidentDrillRecord);
    let replayRows = state.replayChecks.filter(inWindow).map(normalizeReplayCheckRecord);

    if (limit) {
      sloRows = sloRows.slice(0, limit);
      drillRows = drillRows.slice(0, limit);
      replayRows = replayRows.slice(0, limit);
    }

    const summary = conformanceSummary({
      sloMetrics: sloRows,
      incidentDrills: drillRows,
      replayChecks: replayRows
    });

    const exportedAt = new Date(nowMs).toISOString();
    const normalizedQuery = {
      ...(fromIsoRaw ? { from_iso: new Date(fromMs).toISOString() } : {}),
      ...(toIsoRaw ? { to_iso: new Date(toMs).toISOString() } : {}),
      ...(limit ? { limit } : {})
    };

    const exportHash = sha256HexCanonical({
      partner_id: actor.id,
      query: normalizedQuery,
      summary,
      slo_metrics: sloRows,
      incident_drills: drillRows,
      replay_checks: replayRows
    });

    const unsigned = {
      correlation_id: corr,
      partner_id: actor.id,
      exported_at: exportedAt,
      query: normalizedQuery,
      summary,
      slo_metrics: sloRows,
      incident_drills: drillRows,
      replay_checks: replayRows,
      integration_mode: 'fixture_only',
      export_hash: exportHash
    };

    return {
      ok: true,
      body: {
        ...unsigned,
        signature: signPolicyIntegrityPayload(unsigned)
      }
    };
  }
}
