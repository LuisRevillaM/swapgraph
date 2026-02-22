import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { buildSignedPolicyAuditExportPayload } from '../crypto/policyIntegritySigning.mjs';

const signalCategories = new Set([
  'fraud_value_anomaly',
  'fraud_velocity_spike',
  'fraud_cycle_abuse_pattern',
  'ato_device_drift',
  'ato_session_geo_impossible',
  'ato_credential_reuse_suspected'
]);

const decisionOutcomes = new Set(['allow', 'manual_review', 'block']);
const severityLevels = new Set(['low', 'medium', 'high', 'critical']);
const subjectActorTypes = new Set(['user', 'partner']);

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

function parseBps(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 0 || n > 10000) return null;
  return n;
}

function parseLimit(value, fallback = 50) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, 200);
}

function parsePositiveInt(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes') return true;
    if (v === '0' || v === 'false' || v === 'no') return false;
  }
  return fallback;
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

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function ensureState(store) {
  store.state.trust_safety_signals ||= {};
  store.state.trust_safety_signal_counter ||= 0;
  store.state.trust_safety_decisions ||= {};
  store.state.trust_safety_decision_counter ||= 0;
  store.state.trust_safety_export_checkpoints ||= {};
  store.state.idempotency ||= {};
}

function nextSignalId(store) {
  store.state.trust_safety_signal_counter += 1;
  return `ts_signal_${String(store.state.trust_safety_signal_counter).padStart(6, '0')}`;
}

function nextDecisionId(store) {
  store.state.trust_safety_decision_counter += 1;
  return `ts_decision_${String(store.state.trust_safety_decision_counter).padStart(6, '0')}`;
}

function normalizeMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeReasonCodes(reasonCodes) {
  if (!Array.isArray(reasonCodes)) return null;
  const out = [];
  for (const rc of reasonCodes) {
    const v = normalizeOptionalString(rc);
    if (!v) return null;
    out.push(v);
  }
  const unique = Array.from(new Set(out));
  unique.sort();
  return unique.length > 0 ? unique : null;
}

function normalizeContributingSignalIds(ids) {
  if (!Array.isArray(ids)) return [];
  const out = [];
  for (const id of ids) {
    const v = normalizeOptionalString(id);
    if (!v) return null;
    out.push(v);
  }
  return Array.from(new Set(out)).sort();
}

function normalizeSignalRecord(record) {
  return {
    signal_id: record.signal_id,
    category: record.category,
    subject_actor_type: record.subject_actor_type,
    subject_actor_id: record.subject_actor_id,
    severity: record.severity,
    confidence_score_bps: record.confidence_score_bps,
    observed_at: record.observed_at,
    recorded_at: record.recorded_at,
    metadata: clone(record.metadata ?? {})
  };
}

function normalizeDecisionRecord(record, { redactSubject = false } = {}) {
  const subjectActorId = redactSubject
    ? `redacted_${createHash('sha256').update(String(record.subject_actor_id), 'utf8').digest('hex').slice(0, 12)}`
    : record.subject_actor_id;

  const out = {
    decision_id: record.decision_id,
    subject_actor_type: record.subject_actor_type,
    subject_actor_id: subjectActorId,
    decision: record.decision,
    reason_codes: Array.isArray(record.reason_codes) ? [...record.reason_codes] : [],
    contributing_signal_ids: Array.isArray(record.contributing_signal_ids) ? [...record.contributing_signal_ids] : [],
    severity: record.severity,
    confidence_score_bps: record.confidence_score_bps,
    recorded_at: record.recorded_at,
    correlation_id: record.correlation_id,
    dispute_id: record.dispute_id ?? null,
    reliability_ref: record.reliability_ref ?? null
  };

  if (redactSubject) out.subject_redacted = true;
  return out;
}

function decisionSort(a, b) {
  const aMs = parseIsoMs(a?.recorded_at) ?? 0;
  const bMs = parseIsoMs(b?.recorded_at) ?? 0;
  if (aMs !== bMs) return aMs - bMs;
  return String(a?.decision_id ?? '').localeCompare(String(b?.decision_id ?? ''));
}

function decisionCursorKey(decision) {
  return `${decision.recorded_at}|${decision.decision_id}`;
}

function exportRetentionDays(query) {
  const q = parsePositiveInt(query?.retention_days);
  if (q !== null) return Math.min(q, 3650);

  const env = parsePositiveInt(process.env.TRUST_SAFETY_EXPORT_RETENTION_DAYS);
  if (env !== null) return Math.min(env, 3650);

  return 180;
}

function checkpointRetentionDays(defaultDays) {
  const env = parsePositiveInt(process.env.TRUST_SAFETY_EXPORT_CHECKPOINT_RETENTION_DAYS);
  if (env !== null) return Math.min(env, 3650);
  return defaultDays;
}

function checkpointRetentionWindowMs(defaultDays) {
  return checkpointRetentionDays(defaultDays) * 24 * 60 * 60 * 1000;
}

function pruneExpiredCheckpoints({ checkpointState, nowMs, retentionDays }) {
  for (const [k, checkpoint] of Object.entries(checkpointState)) {
    const exportedAtMs = parseIsoMs(checkpoint?.exported_at);
    if (exportedAtMs === null || nowMs > exportedAtMs + checkpointRetentionWindowMs(retentionDays)) {
      delete checkpointState[k];
    }
  }
}

function decisionVisibleToActor({ actor, decision }) {
  if (!actor || !decision) return false;

  if (actor.type === 'user') {
    return decision.subject_actor_type === 'user' && decision.subject_actor_id === actor.id;
  }

  if (actor.type === 'partner') {
    const recordedByPartner = decision.recorded_by?.type === 'partner' && decision.recorded_by?.id === actor.id;
    const partnerSubject = decision.subject_actor_type === 'partner' && decision.subject_actor_id === actor.id;
    return recordedByPartner || partnerSubject;
  }

  return false;
}

function exportContextFingerprint({ actor, query, retentionDays, limit, redactSubject }) {
  return JSON.stringify({
    actor_type: actor?.type ?? null,
    actor_id: actor?.id ?? null,
    subject_actor_id: normalizeOptionalString(query?.subject_actor_id),
    decision: normalizeOptionalString(query?.decision),
    from_iso: normalizeOptionalString(query?.from_iso),
    to_iso: normalizeOptionalString(query?.to_iso),
    retention_days: retentionDays,
    limit,
    redact_subject: redactSubject
  });
}

export class TrustSafetyService {
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
      if (existing.payload_hash === requestHash) return { replayed: true, result: clone(existing.result) };
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
      result: clone(result)
    };

    return { replayed: false, result };
  }

  recordSignal({ actor, auth, idempotencyKey, request }) {
    const op = 'trustSafety.signal.record';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details)
        }
      };
    }

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const signal = request?.signal ?? {};

        const category = normalizeOptionalString(signal?.category);
        const subjectActorType = normalizeOptionalString(signal?.subject_actor_type);
        const subjectActorId = normalizeOptionalString(signal?.subject_actor_id);

        if (!subjectActorType || !subjectActorId) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'signal subject actor is required', {
              reason_code: 'trust_safety_signal_subject_missing'
            })
          };
        }

        if (!subjectActorTypes.has(subjectActorType)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid signal subject actor type', {
              reason_code: 'trust_safety_signal_invalid',
              subject_actor_type: subjectActorType
            })
          };
        }

        const severity = normalizeOptionalString(signal?.severity) ?? 'medium';
        const confidenceScoreBps = parseBps(signal?.confidence_score_bps);

        if (!category || !signalCategories.has(category) || !severityLevels.has(severity) || confidenceScoreBps === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid trust/safety signal payload', {
              reason_code: 'trust_safety_signal_invalid'
            })
          };
        }

        const observedAt = normalizeOptionalString(signal?.observed_at);
        const observedMs = parseIsoMs(observedAt);
        const recordedAtRaw = normalizeOptionalString(request?.recorded_at) ?? auth?.now_iso ?? new Date().toISOString();
        const recordedMs = parseIsoMs(recordedAtRaw);

        if (observedMs === null || recordedMs === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid trust/safety signal timestamp', {
              reason_code: 'trust_safety_signal_invalid_timestamp',
              observed_at: signal?.observed_at ?? null,
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const requestedSignalId = normalizeOptionalString(signal?.signal_id);
        const signalId = requestedSignalId ?? nextSignalId(this.store);
        if (this.store.state.trust_safety_signals[signalId]) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'signal_id already exists', {
              reason_code: 'trust_safety_signal_invalid',
              signal_id: signalId
            })
          };
        }

        const next = {
          signal_id: signalId,
          category,
          subject_actor_type: subjectActorType,
          subject_actor_id: subjectActorId,
          severity,
          confidence_score_bps: confidenceScoreBps,
          observed_at: new Date(observedMs).toISOString(),
          recorded_at: new Date(recordedMs).toISOString(),
          metadata: normalizeMetadata(signal?.metadata),
          recorded_by: {
            type: actor.type,
            id: actor.id
          }
        };

        this.store.state.trust_safety_signals[next.signal_id] = next;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            signal: normalizeSignalRecord(next)
          }
        };
      }
    });
  }

  recordDecision({ actor, auth, idempotencyKey, request }) {
    const op = 'trustSafety.decision.record';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details)
        }
      };
    }

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const decision = request?.decision ?? {};

        const decisionOutcome = normalizeOptionalString(decision?.decision);
        const subjectActorType = normalizeOptionalString(decision?.subject_actor_type);
        const subjectActorId = normalizeOptionalString(decision?.subject_actor_id);
        const severity = normalizeOptionalString(decision?.severity);
        const confidenceScoreBps = parseBps(decision?.confidence_score_bps);

        const reasonCodes = normalizeReasonCodes(decision?.reason_codes);
        const contributingSignalIds = normalizeContributingSignalIds(decision?.contributing_signal_ids);

        if (!decisionOutcome || !decisionOutcomes.has(decisionOutcome)
          || !subjectActorType || !subjectActorTypes.has(subjectActorType)
          || !subjectActorId
          || !severity || !severityLevels.has(severity)
          || confidenceScoreBps === null
          || !reasonCodes
          || contributingSignalIds === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid trust/safety decision payload', {
              reason_code: 'trust_safety_decision_invalid'
            })
          };
        }

        const recordedAtRaw = normalizeOptionalString(decision?.recorded_at) ?? normalizeOptionalString(request?.recorded_at) ?? auth?.now_iso ?? new Date().toISOString();
        const recordedMs = parseIsoMs(recordedAtRaw);
        if (recordedMs === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid trust/safety decision timestamp', {
              reason_code: 'trust_safety_decision_invalid_timestamp',
              recorded_at: decision?.recorded_at ?? request?.recorded_at ?? null
            })
          };
        }

        for (const signalId of contributingSignalIds) {
          const signal = this.store.state.trust_safety_signals[signalId] ?? null;
          if (!signal) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'decision references unknown signal', {
                reason_code: 'trust_safety_decision_invalid',
                signal_id: signalId
              })
            };
          }

          if (signal.subject_actor_type !== subjectActorType || signal.subject_actor_id !== subjectActorId) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'decision subject does not match contributing signal subjects', {
                reason_code: 'trust_safety_decision_subject_mismatch',
                signal_id: signalId,
                decision_subject_actor_type: subjectActorType,
                decision_subject_actor_id: subjectActorId,
                signal_subject_actor_type: signal.subject_actor_type,
                signal_subject_actor_id: signal.subject_actor_id
              })
            };
          }
        }

        const requestedDecisionId = normalizeOptionalString(decision?.decision_id);
        const decisionId = requestedDecisionId ?? nextDecisionId(this.store);
        if (this.store.state.trust_safety_decisions[decisionId]) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'decision_id already exists', {
              reason_code: 'trust_safety_decision_invalid',
              decision_id: decisionId
            })
          };
        }

        const next = {
          decision_id: decisionId,
          subject_actor_type: subjectActorType,
          subject_actor_id: subjectActorId,
          decision: decisionOutcome,
          reason_codes: reasonCodes,
          contributing_signal_ids: contributingSignalIds,
          severity,
          confidence_score_bps: confidenceScoreBps,
          recorded_at: new Date(recordedMs).toISOString(),
          correlation_id: normalizeOptionalString(decision?.correlation_id) ?? `corr_ts_decision_${decisionId}`,
          dispute_id: normalizeOptionalString(decision?.dispute_id),
          reliability_ref: normalizeOptionalString(decision?.reliability_ref),
          recorded_by: {
            type: actor.type,
            id: actor.id
          }
        };

        this.store.state.trust_safety_decisions[next.decision_id] = next;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            decision: normalizeDecisionRecord(next)
          }
        };
      }
    });
  }

  getDecision({ actor, auth, decisionId }) {
    const op = 'trustSafety.decision.get';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) {
      return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };
    }

    const requestedDecisionId = normalizeOptionalString(decisionId);
    const decision = requestedDecisionId ? (this.store.state.trust_safety_decisions[requestedDecisionId] ?? null) : null;

    if (!decision || !decisionVisibleToActor({ actor, decision })) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'trust/safety decision not found', {
          reason_code: 'trust_safety_decision_not_found',
          decision_id: requestedDecisionId
        })
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        decision: normalizeDecisionRecord(decision)
      }
    };
  }

  exportDecisions({ actor, auth, query }) {
    const op = 'trustSafety.decision.export';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) {
      return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };
    }

    const decisionFilter = normalizeOptionalString(query?.decision);
    if (decisionFilter && !decisionOutcomes.has(decisionFilter)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid trust/safety export query', {
          reason_code: 'trust_safety_export_query_invalid',
          decision: decisionFilter
        })
      };
    }

    const fromIso = normalizeOptionalString(query?.from_iso);
    const toIso = normalizeOptionalString(query?.to_iso);
    const fromMs = fromIso ? parseIsoMs(fromIso) : null;
    const toMs = toIso ? parseIsoMs(toIso) : null;
    const limit = parseLimit(query?.limit, 50);

    const retentionDays = exportRetentionDays(query);
    const nowIso = normalizeOptionalString(query?.now_iso) ?? auth?.now_iso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
    const nowMs = parseIsoMs(nowIso);

    if ((fromIso && fromMs === null) || (toIso && toMs === null) || limit === null || nowMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid trust/safety export query', {
          reason_code: 'trust_safety_export_query_invalid'
        })
      };
    }

    const cursorAfter = normalizeOptionalString(query?.cursor_after);
    const attestationAfter = normalizeOptionalString(query?.attestation_after);
    const checkpointAfter = normalizeOptionalString(query?.checkpoint_after);

    if (cursorAfter && (!attestationAfter || !checkpointAfter)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid trust/safety export query', {
          reason_code: 'trust_safety_export_query_invalid',
          cursor_after: cursorAfter,
          attestation_after: attestationAfter,
          checkpoint_after: checkpointAfter
        })
      };
    }

    if (!cursorAfter && (attestationAfter || checkpointAfter)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid trust/safety export query', {
          reason_code: 'trust_safety_export_query_invalid',
          cursor_after: cursorAfter,
          attestation_after: attestationAfter,
          checkpoint_after: checkpointAfter
        })
      };
    }

    const cutoffMs = nowMs - (retentionDays * 24 * 60 * 60 * 1000);
    const subjectActorIdFilter = normalizeOptionalString(query?.subject_actor_id);
    const redactSubject = parseBoolean(query?.redact_subject, false);

    let decisions = Object.values(this.store.state.trust_safety_decisions ?? {})
      .filter(d => decisionVisibleToActor({ actor, decision: d }))
      .filter(d => {
        const recordedMs = parseIsoMs(d?.recorded_at);
        return recordedMs !== null && recordedMs >= cutoffMs;
      });

    if (subjectActorIdFilter) decisions = decisions.filter(d => d.subject_actor_id === subjectActorIdFilter);
    if (decisionFilter) decisions = decisions.filter(d => d.decision === decisionFilter);
    if (fromMs !== null) decisions = decisions.filter(d => (parseIsoMs(d.recorded_at) ?? 0) >= fromMs);
    if (toMs !== null) decisions = decisions.filter(d => (parseIsoMs(d.recorded_at) ?? 0) <= toMs);

    decisions.sort(decisionSort);

    let startIndex = 0;
    if (cursorAfter) {
      const idx = decisions.findIndex(d => decisionCursorKey(d) === cursorAfter);
      if (idx < 0) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cursor_after not found for trust/safety export', {
            reason_code: 'trust_safety_export_cursor_not_found',
            cursor_after: cursorAfter
          })
        };
      }
      startIndex = idx + 1;
    }

    const filteredAfterCursor = decisions.slice(startIndex);
    const totalFiltered = filteredAfterCursor.length;
    const page = filteredAfterCursor.slice(0, limit);

    const nextCursor = filteredAfterCursor.length > limit
      ? decisionCursorKey(page[page.length - 1])
      : null;

    const checkpointState = this.store.state.trust_safety_export_checkpoints;
    const contextFingerprint = exportContextFingerprint({
      actor,
      query,
      retentionDays,
      limit,
      redactSubject
    });

    pruneExpiredCheckpoints({ checkpointState, nowMs, retentionDays });

    if (cursorAfter) {
      const priorCheckpoint = checkpointState[checkpointAfter] ?? null;
      if (!priorCheckpoint) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid trust/safety export continuation checkpoint', {
            reason_code: 'trust_safety_export_query_invalid',
            checkpoint_after: checkpointAfter
          })
        };
      }

      if (priorCheckpoint.next_cursor !== cursorAfter) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid trust/safety export continuation cursor', {
            reason_code: 'trust_safety_export_query_invalid',
            checkpoint_after: checkpointAfter,
            expected_cursor_after: priorCheckpoint.next_cursor ?? null,
            cursor_after: cursorAfter
          })
        };
      }

      if (priorCheckpoint.attestation_chain_hash !== attestationAfter) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid trust/safety export continuation attestation', {
            reason_code: 'trust_safety_export_query_invalid',
            checkpoint_after: checkpointAfter,
            expected_attestation_after: priorCheckpoint.attestation_chain_hash ?? null,
            attestation_after: attestationAfter
          })
        };
      }

      if (priorCheckpoint.query_context_fingerprint !== contextFingerprint) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid trust/safety export continuation filter context', {
            reason_code: 'trust_safety_export_query_invalid',
            checkpoint_after: checkpointAfter
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
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid trust/safety export query', {
          reason_code: 'trust_safety_export_query_invalid',
          exported_at_iso: query?.exported_at_iso ?? null
        })
      };
    }

    const exportedAt = new Date(exportedAtMs).toISOString();
    const entries = page.map(row => normalizeDecisionRecord(row, { redactSubject }));

    const signedPayload = buildSignedPolicyAuditExportPayload({
      exportedAt,
      query: {
        ...(subjectActorIdFilter ? { subject_actor_id: subjectActorIdFilter } : {}),
        ...(decisionFilter ? { decision: decisionFilter } : {}),
        ...(fromIso ? { from_iso: fromIso } : {}),
        ...(toIso ? { to_iso: toIso } : {}),
        limit,
        ...(cursorAfter ? { cursor_after: cursorAfter } : {}),
        ...(attestationAfter ? { attestation_after: attestationAfter } : {}),
        ...(checkpointAfter ? { checkpoint_after: checkpointAfter } : {}),
        retention_days: retentionDays,
        ...(redactSubject ? { redact_subject: true } : {}),
        now_iso: nowIso,
        exported_at_iso: exportedAt
      },
      entries,
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
        ...signedPayload
      }
    };
  }
}
