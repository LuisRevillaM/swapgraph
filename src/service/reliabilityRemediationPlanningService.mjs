import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { canonicalStringify } from '../util/canonicalJson.mjs';
import { buildSignedReliabilityRemediationPlanExportPayload } from '../crypto/policyIntegritySigning.mjs';

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

function normalizeLimit(value) {
  return parsePositiveInt(value, { min: 1, max: 200 });
}

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function payloadHash(payload) {
  return createHash('sha256').update(canonicalStringify(payload), 'utf8').digest('hex');
}

function isPartner(actor) {
  return actor?.type === 'partner' && typeof actor?.id === 'string' && actor.id.trim();
}

function ensureRemediationPlanningState(store) {
  store.state.reliability_slo_metrics ||= [];
  store.state.reliability_incident_drills ||= [];
  store.state.reliability_replay_checks ||= [];
  store.state.reliability_remediation_plans ||= [];
  store.state.reliability_remediation_plan_counter ||= 0;
  store.state.idempotency ||= {};

  return {
    sloMetrics: store.state.reliability_slo_metrics,
    incidentDrills: store.state.reliability_incident_drills,
    replayChecks: store.state.reliability_replay_checks,
    plans: store.state.reliability_remediation_plans,
    idempotency: store.state.idempotency
  };
}

function nextPlanCounter(store) {
  const current = Number.parseInt(String(store.state.reliability_remediation_plan_counter ?? 0), 10);
  const next = (Number.isFinite(current) ? current : 0) + 1;
  store.state.reliability_remediation_plan_counter = next;
  return next;
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

  const idemState = ensureRemediationPlanningState(store).idempotency;
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

const allowedRiskLevels = new Set(['low', 'medium', 'high', 'critical']);
const allowedPlanStatus = new Set(['suggested', 'approved', 'applied', 'dismissed']);

function normalizeSuggestRequest(request) {
  const payload = request?.plan_request;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const serviceId = normalizeOptionalString(payload.service_id);
  const fromIsoRaw = normalizeOptionalString(payload.from_iso);
  const toIsoRaw = normalizeOptionalString(payload.to_iso);
  const fromMs = parseIsoMs(fromIsoRaw);
  const toMs = parseIsoMs(toIsoRaw);
  const maxActions = parsePositiveInt(payload.max_actions ?? 8, { min: 1, max: 20 });
  const includeDrillActions = payload.include_drill_actions !== false;
  const includeReplayActions = payload.include_replay_actions !== false;

  if (!serviceId
    || fromMs === null
    || toMs === null
    || toMs < fromMs
    || maxActions === null
    || typeof includeDrillActions !== 'boolean'
    || typeof includeReplayActions !== 'boolean') {
    return null;
  }

  return {
    service_id: serviceId,
    from_iso: new Date(fromMs).toISOString(),
    to_iso: new Date(toMs).toISOString(),
    max_actions: maxActions,
    include_drill_actions: includeDrillActions,
    include_replay_actions: includeReplayActions,
    ...(normalizeOptionalString(payload.notes) ? { notes: normalizeOptionalString(payload.notes) } : {})
  };
}

function isInWindow(recordedAt, { fromMs, toMs }) {
  const t = parseIsoMs(recordedAt);
  if (t === null) return false;
  if (t < fromMs || t > toMs) return false;
  return true;
}

function summarizeSignals({ state, partnerId, serviceId, fromMs, toMs }) {
  const sloRows = state.sloMetrics
    .filter(row => row?.partner_id === partnerId)
    .filter(row => row?.service_id === serviceId)
    .filter(row => isInWindow(row?.recorded_at, { fromMs, toMs }));

  const serviceScopedSignalsPresent = sloRows.length > 0;

  const drillRows = serviceScopedSignalsPresent
    ? state.incidentDrills
      .filter(row => row?.partner_id === partnerId)
      .filter(row => isInWindow(row?.recorded_at, { fromMs, toMs }))
    : [];

  const replayRows = serviceScopedSignalsPresent
    ? state.replayChecks
      .filter(row => row?.partner_id === partnerId)
      .filter(row => isInWindow(row?.recorded_at, { fromMs, toMs }))
    : [];

  const summary = {
    slo_total: sloRows.length,
    slo_failing: sloRows.filter(row => row?.passing !== true).length,
    drills_total: drillRows.length,
    drills_failing: drillRows.filter(row => row?.outcome !== 'pass').length,
    replay_checks_total: replayRows.length,
    replay_checks_failing: replayRows.filter(row => row?.passing !== true).length,
    availability_failures: sloRows.filter(row => Array.isArray(row?.breach_reasons) && row.breach_reasons.includes('availability_below_target')).length,
    latency_failures: sloRows.filter(row => Array.isArray(row?.breach_reasons) && row.breach_reasons.includes('latency_above_target')).length,
    error_budget_failures: sloRows.filter(row => Array.isArray(row?.breach_reasons) && row.breach_reasons.includes('error_budget_exhausted')).length,
    replay_log_failures: replayRows.filter(row => row?.reason_code === 'replay_log_hash_mismatch').length,
    replay_state_failures: replayRows.filter(row => row?.reason_code === 'recovery_state_hash_mismatch').length
  };

  summary.signal_count = summary.slo_total + summary.drills_total + summary.replay_checks_total;
  summary.total_failing = summary.slo_failing + summary.drills_failing + summary.replay_checks_failing;

  return summary;
}

function normalizeAction(action, idx) {
  const out = {
    action_id: `remediation_action_${String(idx + 1).padStart(3, '0')}`,
    action_code: action.action_code,
    priority: action.priority,
    reason_code: action.reason_code,
    runbook_ref: action.runbook_ref,
    automation_hint: action.automation_hint,
    evidence_hint: action.evidence_hint
  };

  if (normalizeOptionalString(action.notes)) out.notes = normalizeOptionalString(action.notes);
  return out;
}

function buildActions({ signalSummary, includeDrillActions, includeReplayActions }) {
  const base = [];

  if (signalSummary.availability_failures > 0) {
    base.push({
      action_code: 'triage_availability_regression',
      priority: 'critical',
      reason_code: 'availability_below_target',
      runbook_ref: 'runbooks/reliability/availability-triage.md',
      automation_hint: 'rollback_latest_risky_change',
      evidence_hint: 'artifact://reliability/availability/regression-timeline.json'
    });
  }

  if (signalSummary.error_budget_failures > 0) {
    base.push({
      action_code: 'enforce_error_budget_guardrail',
      priority: 'high',
      reason_code: 'error_budget_exhausted',
      runbook_ref: 'runbooks/reliability/error-budget-guardrail.md',
      automation_hint: 'enable_rate_limit_overlay',
      evidence_hint: 'artifact://reliability/error-budget/burn-rate.json'
    });
  }

  if (signalSummary.latency_failures > 0) {
    base.push({
      action_code: 'profile_high_latency_hotpaths',
      priority: 'high',
      reason_code: 'latency_above_target',
      runbook_ref: 'runbooks/reliability/latency-hotpath-profile.md',
      automation_hint: 'route_hot_traffic_to_stable_pool',
      evidence_hint: 'artifact://reliability/latency/p95-profile.ndjson'
    });
  }

  if (includeDrillActions && signalSummary.drills_failing > 0) {
    base.push({
      action_code: 'schedule_incident_response_rehearsal',
      priority: 'medium',
      reason_code: 'incident_drill_failed',
      runbook_ref: 'runbooks/reliability/incident-rehearsal.md',
      automation_hint: 'open_drill_followup_ticket',
      evidence_hint: 'artifact://reliability/drills/failing-drills.json'
    });
  }

  if (includeReplayActions && signalSummary.replay_log_failures > 0) {
    base.push({
      action_code: 'audit_event_log_integrity',
      priority: 'high',
      reason_code: 'replay_log_hash_mismatch',
      runbook_ref: 'runbooks/reliability/replay-log-integrity.md',
      automation_hint: 'lock_mutating_endpoints_to_safe_mode',
      evidence_hint: 'artifact://reliability/replay/log-hash-diff.json'
    });
  }

  if (includeReplayActions && signalSummary.replay_state_failures > 0) {
    base.push({
      action_code: 'diff_recovery_state_projection',
      priority: 'high',
      reason_code: 'recovery_state_hash_mismatch',
      runbook_ref: 'runbooks/reliability/recovery-state-diff.md',
      automation_hint: 'run_state_repair_dry_run',
      evidence_hint: 'artifact://reliability/replay/state-diff.json'
    });
  }

  if (base.length === 0) {
    base.push({
      action_code: 'maintain_baseline_observability_watch',
      priority: 'low',
      reason_code: 'no_failures_detected',
      runbook_ref: 'runbooks/reliability/baseline-watch.md',
      automation_hint: 'continue_standard_monitoring',
      evidence_hint: 'artifact://reliability/baseline/status.json'
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const row of base) {
    if (seen.has(row.action_code)) continue;
    seen.add(row.action_code);
    deduped.push(row);
  }

  return deduped;
}

function riskForSummary(summary) {
  const score = Math.min(
    100,
    (summary.slo_failing * 20)
      + (summary.drills_failing * 15)
      + (summary.replay_checks_failing * 25)
      + (summary.error_budget_failures * 10)
  );

  let level = 'low';
  if (score >= 75) level = 'critical';
  else if (score >= 45) level = 'high';
  else if (score >= 15) level = 'medium';

  return {
    priority_score: score,
    risk_level: level
  };
}

function normalizePlanBlocker(blocker) {
  return {
    blocker_code: blocker.blocker_code,
    severity: blocker.severity,
    reason_code: blocker.reason_code,
    message: blocker.message
  };
}

function planCursorKey(row) {
  const updatedAt = normalizeOptionalString(row?.updated_at) ?? '';
  const planId = normalizeOptionalString(row?.plan_id) ?? '';
  return `${updatedAt}|${planId}`;
}

function normalizePlan(record) {
  return {
    plan_id: record.plan_id,
    partner_id: record.partner_id,
    service_id: record.service_id,
    status: record.status,
    risk_level: record.risk_level,
    priority_score: Number(record.priority_score ?? 0),
    window: {
      from_iso: record.window?.from_iso,
      to_iso: record.window?.to_iso
    },
    signal_summary: {
      slo_total: Number(record.signal_summary?.slo_total ?? 0),
      slo_failing: Number(record.signal_summary?.slo_failing ?? 0),
      drills_total: Number(record.signal_summary?.drills_total ?? 0),
      drills_failing: Number(record.signal_summary?.drills_failing ?? 0),
      replay_checks_total: Number(record.signal_summary?.replay_checks_total ?? 0),
      replay_checks_failing: Number(record.signal_summary?.replay_checks_failing ?? 0),
      availability_failures: Number(record.signal_summary?.availability_failures ?? 0),
      latency_failures: Number(record.signal_summary?.latency_failures ?? 0),
      error_budget_failures: Number(record.signal_summary?.error_budget_failures ?? 0),
      replay_log_failures: Number(record.signal_summary?.replay_log_failures ?? 0),
      replay_state_failures: Number(record.signal_summary?.replay_state_failures ?? 0),
      signal_count: Number(record.signal_summary?.signal_count ?? 0),
      total_failing: Number(record.signal_summary?.total_failing ?? 0)
    },
    recommended_actions: Array.isArray(record.recommended_actions)
      ? record.recommended_actions.map((action, idx) => normalizeAction(action, idx))
      : [],
    blockers: Array.isArray(record.blockers)
      ? record.blockers.map(normalizePlanBlocker)
      : [],
    integration_mode: 'fixture_only',
    created_at: record.created_at,
    updated_at: record.updated_at,
    ...(normalizeOptionalString(record.notes) ? { notes: normalizeOptionalString(record.notes) } : {})
  };
}

function summarizePlans(all, page) {
  const rows = Array.isArray(all) ? all : [];
  const returned = Array.isArray(page) ? page : [];

  const statusMap = new Map();
  for (const row of rows) {
    statusMap.set(row.status, (statusMap.get(row.status) ?? 0) + 1);
  }

  return {
    total_plans: rows.length,
    returned_plans: returned.length,
    actionable_plans: rows.filter(row => Array.isArray(row.recommended_actions) && row.recommended_actions.length > 0).length,
    critical_count: rows.filter(row => row.risk_level === 'critical').length,
    high_count: rows.filter(row => row.risk_level === 'high').length,
    medium_count: rows.filter(row => row.risk_level === 'medium').length,
    low_count: rows.filter(row => row.risk_level === 'low').length,
    by_status: Array.from(statusMap.entries())
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => String(a.status).localeCompare(String(b.status)))
  };
}

export class ReliabilityRemediationPlanningService {
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureRemediationPlanningState(this.store);
  }

  suggestPlan({ actor, auth, idempotencyKey, request }) {
    const op = 'reliability.remediation_plan.suggest';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can request remediation planning', { actor })
      };
    }

    const normalized = normalizeSuggestRequest(request);
    if (!normalized) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid reliability remediation planning payload', {
          reason_code: 'reliability_remediation_plan_invalid'
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
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid remediation planning timestamp', {
          reason_code: 'reliability_remediation_plan_invalid_timestamp'
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
        const state = ensureRemediationPlanningState(this.store);
        const fromMs = parseIsoMs(normalized.from_iso);
        const toMs = parseIsoMs(normalized.to_iso);

        const signalSummary = summarizeSignals({
          state,
          partnerId: actor.id,
          serviceId: normalized.service_id,
          fromMs,
          toMs
        });

        const risk = riskForSummary(signalSummary);
        const actions = buildActions({
          signalSummary,
          includeDrillActions: normalized.include_drill_actions,
          includeReplayActions: normalized.include_replay_actions
        }).slice(0, normalized.max_actions);

        const blockers = [];
        if (signalSummary.signal_count === 0) {
          blockers.push({
            blocker_code: 'signals_missing',
            severity: 'medium',
            reason_code: 'reliability_signals_missing',
            message: 'no reliability signals were found inside the requested remediation window'
          });
        }

        const nowIso = new Date(occurredAtMs).toISOString();
        const planCounter = nextPlanCounter(this.store);
        const planId = `remediation_plan_${String(planCounter).padStart(6, '0')}`;

        const plan = {
          plan_id: planId,
          partner_id: actor.id,
          service_id: normalized.service_id,
          status: 'suggested',
          risk_level: risk.risk_level,
          priority_score: risk.priority_score,
          window: {
            from_iso: normalized.from_iso,
            to_iso: normalized.to_iso
          },
          signal_summary: signalSummary,
          recommended_actions: actions,
          blockers,
          integration_mode: 'fixture_only',
          created_at: nowIso,
          updated_at: nowIso,
          ...(normalized.notes ? { notes: normalized.notes } : {})
        };

        state.plans.push(plan);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            plan: normalizePlan(plan)
          }
        };
      }
    });
  }

  exportPlans({ actor, auth, query }) {
    const op = 'reliability.remediation_plan.export';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    if (!isPartner(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can export remediation planning', { actor })
      };
    }

    const serviceId = normalizeOptionalString(query?.service_id);
    const riskLevel = normalizeOptionalString(query?.risk_level);
    const status = normalizeOptionalString(query?.status);
    const fromIso = normalizeOptionalString(query?.from_iso);
    const toIso = normalizeOptionalString(query?.to_iso);
    const limit = normalizeLimit(query?.limit ?? 50);
    const cursorAfter = normalizeOptionalString(query?.cursor_after);
    const exportedAtRaw = normalizeOptionalString(query?.exported_at_iso)
      ?? normalizeOptionalString(auth?.now_iso)
      ?? process.env.AUTHZ_NOW_ISO
      ?? new Date().toISOString();

    const fromMs = fromIso ? parseIsoMs(fromIso) : null;
    const toMs = toIso ? parseIsoMs(toIso) : null;
    const exportedAtMs = parseIsoMs(exportedAtRaw);

    if ((riskLevel && !allowedRiskLevels.has(riskLevel))
      || (status && !allowedPlanStatus.has(status))
      || (fromIso && fromMs === null)
      || (toIso && toMs === null)
      || (fromMs !== null && toMs !== null && toMs < fromMs)
      || limit === null
      || exportedAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid reliability remediation export query', {
          reason_code: 'reliability_remediation_plan_export_query_invalid'
        })
      };
    }

    const state = ensureRemediationPlanningState(this.store);
    const all = (state.plans ?? [])
      .filter(row => row?.partner_id === actor.id)
      .map(normalizePlan)
      .filter(row => !serviceId || row.service_id === serviceId)
      .filter(row => !riskLevel || row.risk_level === riskLevel)
      .filter(row => !status || row.status === status)
      .filter(row => {
        const rowMs = parseIsoMs(row.updated_at);
        if (rowMs === null) return false;
        if (fromMs !== null && rowMs < fromMs) return false;
        if (toMs !== null && rowMs > toMs) return false;
        return true;
      })
      .sort((a, b) => planCursorKey(a).localeCompare(planCursorKey(b)));

    let startIndex = 0;
    if (cursorAfter) {
      const idx = all.findIndex(row => planCursorKey(row) === cursorAfter);
      if (idx < 0) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cursor_after not found in remediation planning export window', {
            reason_code: 'reliability_remediation_plan_cursor_not_found',
            cursor_after: cursorAfter
          })
        };
      }

      startIndex = idx + 1;
    }

    const plans = all.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < all.length
      ? planCursorKey(plans[plans.length - 1])
      : null;

    const summary = summarizePlans(all, plans);
    const normalizedExportedAtIso = new Date(exportedAtMs).toISOString();

    const signedPayload = buildSignedReliabilityRemediationPlanExportPayload({
      exportedAt: normalizedExportedAtIso,
      query: {
        ...(serviceId ? { service_id: serviceId } : {}),
        ...(riskLevel ? { risk_level: riskLevel } : {}),
        ...(status ? { status } : {}),
        ...(fromIso ? { from_iso: fromIso } : {}),
        ...(toIso ? { to_iso: toIso } : {}),
        limit,
        ...(cursorAfter ? { cursor_after: cursorAfter } : {}),
        ...(normalizeOptionalString(query?.now_iso) ? { now_iso: normalizeOptionalString(query?.now_iso) } : {}),
        exported_at_iso: normalizedExportedAtIso
      },
      summary,
      plans,
      totalFiltered: all.length,
      nextCursor,
      withAttestation: true
    });

    return {
      ok: true,
      body: {
        correlation_id: corr,
        partner_id: actor.id,
        integration_mode: 'fixture_only',
        ...signedPayload
      }
    };
  }
}
