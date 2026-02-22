import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { buildSignedPolicyAuditExportPayload } from '../crypto/policyIntegritySigning.mjs';

const EXECUTION_MODES = new Set(['simulation', 'operator_assisted', 'constrained_auto']);
const REQUEST_STATUSES = new Set(['pending', 'approved', 'rejected']);
const REQUEST_DECISIONS = new Set(['approve', 'reject']);
const RISK_CLASSES = new Set(['low', 'medium', 'high', 'critical']);
const ACTION_TYPES = new Set([
  'settlement_execute',
  'settlement_cancel',
  'settlement_retry',
  'inventory_release'
]);
const ACTOR_TYPES = new Set(['user', 'partner', 'agent']);

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

function parsePositiveInt(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

function normalizeReasonCodes(reasonCodes) {
  if (!Array.isArray(reasonCodes)) return null;
  const out = [];
  for (const code of reasonCodes) {
    const value = normalizeOptionalString(code);
    if (!value) return null;
    out.push(value);
  }
  const unique = Array.from(new Set(out)).sort();
  return unique.length > 0 ? unique : null;
}

function normalizeIntentIds(intentIds) {
  if (intentIds === undefined || intentIds === null) return [];
  if (!Array.isArray(intentIds)) return null;

  const out = [];
  for (const id of intentIds) {
    const value = normalizeOptionalString(id);
    if (!value) return null;
    out.push(value);
  }
  return Array.from(new Set(out)).sort();
}

function normalizeActorRef(actor) {
  if (!isObject(actor)) return null;
  const type = normalizeOptionalString(actor.type);
  const id = normalizeOptionalString(actor.id);
  if (!type || !id || !ACTOR_TYPES.has(type)) return null;
  return { type, id };
}

function actorRefEqual(left, right) {
  return left?.type === right?.type && left?.id === right?.id;
}

function sortedArrayEqual(left, right) {
  const a = Array.isArray(left) ? [...left].sort() : [];
  const b = Array.isArray(right) ? [...right].sort() : [];
  return JSON.stringify(a) === JSON.stringify(b);
}

function executionModeView(record, { integrationGateEnabled }) {
  return {
    provider_id: record.provider_id,
    mode: record.mode,
    restricted_adapter_context: record.restricted_adapter_context,
    override_policy: record.override_policy ? clone(record.override_policy) : null,
    integration_gate_enabled: integrationGateEnabled,
    updated_at: record.updated_at,
    updated_by: clone(record.updated_by)
  };
}

function executionRequestView(record) {
  return {
    request_id: record.request_id,
    provider_id: record.provider_id,
    proposal_id: record.proposal_id ?? null,
    cycle_id: record.cycle_id ?? null,
    intent_ids: clone(record.intent_ids ?? []),
    action_type: record.action_type,
    risk_class: record.risk_class,
    reason_codes: clone(record.reason_codes ?? []),
    correlation_id: record.correlation_id,
    requested_at: record.requested_at,
    requested_by: clone(record.requested_by),
    mode_snapshot: {
      mode: record.mode_snapshot.mode,
      restricted_adapter_context: record.mode_snapshot.restricted_adapter_context,
      override_policy: record.mode_snapshot.override_policy ? clone(record.mode_snapshot.override_policy) : null
    },
    metadata: clone(record.metadata ?? {}),
    status: record.status,
    decision: record.decision ?? null,
    operator_actor: record.operator_actor ? clone(record.operator_actor) : null,
    decision_reason_codes: clone(record.decision_reason_codes ?? []),
    decision_correlation_id: record.decision_correlation_id ?? null,
    decided_at: record.decided_at ?? null
  };
}

function requestSort(a, b) {
  const aMs = parseIsoMs(a?.requested_at) ?? 0;
  const bMs = parseIsoMs(b?.requested_at) ?? 0;
  if (aMs !== bMs) return aMs - bMs;
  return String(a?.request_id ?? '').localeCompare(String(b?.request_id ?? ''));
}

function requestCursorKey(request) {
  return `${request.requested_at}|${request.request_id}`;
}

function exportRetentionDays(query) {
  const fromQuery = parsePositiveInt(query?.retention_days);
  if (fromQuery !== null) return Math.min(fromQuery, 3650);

  const fromEnv = parsePositiveInt(process.env.LIQUIDITY_EXECUTION_EXPORT_RETENTION_DAYS);
  if (fromEnv !== null) return Math.min(fromEnv, 3650);

  return 180;
}

function checkpointRetentionDays(defaultDays) {
  const env = parsePositiveInt(process.env.LIQUIDITY_EXECUTION_EXPORT_CHECKPOINT_RETENTION_DAYS);
  if (env !== null) return Math.min(env, 3650);
  return defaultDays;
}

function checkpointRetentionWindowMs(defaultDays) {
  return checkpointRetentionDays(defaultDays) * 24 * 60 * 60 * 1000;
}

function pruneExpiredCheckpoints({ checkpointState, nowMs, retentionDays }) {
  for (const [checkpointHash, checkpoint] of Object.entries(checkpointState)) {
    const exportedAtMs = parseIsoMs(checkpoint?.exported_at);
    if (exportedAtMs === null || nowMs > exportedAtMs + checkpointRetentionWindowMs(retentionDays)) {
      delete checkpointState[checkpointHash];
    }
  }
}

function exportContextFingerprint({ actor, providerId, query, limit, retentionDays }) {
  return JSON.stringify({
    actor_type: actor?.type ?? null,
    actor_id: actor?.id ?? null,
    provider_id: providerId,
    status: normalizeOptionalString(query?.status),
    risk_class: normalizeOptionalString(query?.risk_class),
    from_iso: normalizeOptionalString(query?.from_iso),
    to_iso: normalizeOptionalString(query?.to_iso),
    retention_days: retentionDays,
    limit
  });
}

function providerOwnerMismatch(actor, provider) {
  return actor?.type !== provider?.owner_actor?.type || actor?.id !== provider?.owner_actor?.id;
}

function ensureState(store) {
  store.state.idempotency ||= {};
  store.state.liquidity_execution_modes ||= {};
  store.state.liquidity_execution_requests ||= {};
  store.state.liquidity_execution_request_counter ||= 0;
  store.state.liquidity_execution_export_checkpoints ||= {};
}

function nextExecutionRequestId(store) {
  store.state.liquidity_execution_request_counter += 1;
  return `lpexec_req_${String(store.state.liquidity_execution_request_counter).padStart(6, '0')}`;
}

export class LiquidityExecutionService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureState(this.store);
  }

  _nowIso(auth) {
    return normalizeOptionalString(auth?.now_iso) ?? new Date().toISOString();
  }

  _integrationGateEnabled() {
    return process.env.INTEGRATION_ENABLED === '1';
  }

  _authorize({ actor, auth, operationId, correlationId: corr }) {
    const authz = authorizeApiOperation({ operationId, actor, auth, store: this.store });
    if (!authz.ok) {
      return {
        ok: false,
        body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details)
      };
    }
    return { ok: true };
  }

  _requirePartner({ actor, operationId, correlationId: corr, reasonCode }) {
    if (actor?.type === 'partner' && normalizeOptionalString(actor?.id)) return null;
    return {
      ok: false,
      body: errorResponse(corr, 'FORBIDDEN', 'only partner actors are allowed for liquidity execution operations', {
        operation_id: operationId,
        reason_code: reasonCode,
        actor: actor ?? null
      })
    };
  }

  _withIdempotency({ actor, operationId, idempotencyKey, requestBody, correlationId: corr, scopeSuffix = null, handler }) {
    const operationScope = scopeSuffix ? `${operationId}:${scopeSuffix}` : operationId;
    const scopeKey = idempotencyScopeKey({ actor, operationId: operationScope, idempotencyKey });
    const requestHash = payloadHash(requestBody);
    const existing = this.store.state.idempotency[scopeKey];

    if (existing) {
      if (existing.payload_hash === requestHash) {
        return { replayed: true, result: clone(existing.result) };
      }
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(corr, 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH', 'idempotency key reused with a different payload', {
            operation_id: operationId,
            idempotency_key: idempotencyKey
          })
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

  _resolveProviderForActor({ actor, providerId, correlationId: corr, invalidReasonCode }) {
    const normalizedProviderId = normalizeOptionalString(providerId);
    if (!normalizedProviderId) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'provider_id is required', {
          reason_code: invalidReasonCode
        })
      };
    }

    const provider = this.store.state.liquidity_providers?.[normalizedProviderId];
    if (!provider) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'liquidity provider not found', {
          reason_code: 'liquidity_provider_not_found',
          provider_id: normalizedProviderId
        })
      };
    }

    if (providerOwnerMismatch(actor, provider)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'liquidity provider ownership mismatch', {
          reason_code: 'liquidity_provider_actor_mismatch',
          provider_id: normalizedProviderId,
          actor,
          owner_actor: provider.owner_actor
        })
      };
    }

    return { ok: true, provider_id: normalizedProviderId, provider };
  }

  _defaultModeRecord({ providerId, provider, nowIso }) {
    return {
      provider_id: providerId,
      mode: 'operator_assisted',
      restricted_adapter_context: true,
      override_policy: null,
      updated_at: normalizeOptionalString(provider?.updated_at) ?? nowIso,
      updated_by: clone(provider?.owner_actor ?? { type: 'partner', id: 'unknown_partner' })
    };
  }

  _effectiveModeRecord({ providerId, provider, nowIso }) {
    const existing = this.store.state.liquidity_execution_modes[providerId] ?? null;
    if (existing) return existing;
    return this._defaultModeRecord({ providerId, provider, nowIso });
  }

  _normalizeOverridePolicy(raw) {
    if (raw === undefined || raw === null) return { ok: true, value: null };
    if (!isObject(raw)) return { ok: false };

    const overrideId = normalizeOptionalString(raw.override_id);
    const approvedBy = normalizeActorRef(raw.approved_by);
    const approvedAtRaw = normalizeOptionalString(raw.approved_at);
    const approvedAtMs = parseIsoMs(approvedAtRaw);
    const reasonCodes = normalizeReasonCodes(raw.reason_codes);
    const expiresAtRaw = normalizeOptionalString(raw.expires_at);
    const expiresAtMs = expiresAtRaw ? parseIsoMs(expiresAtRaw) : null;

    if (!overrideId || !approvedBy || approvedAtMs === null || !reasonCodes || (expiresAtRaw && expiresAtMs === null)) {
      return { ok: false };
    }

    if (expiresAtMs !== null && expiresAtMs < approvedAtMs) {
      return { ok: false };
    }

    return {
      ok: true,
      value: {
        override_id: overrideId,
        approved_by: approvedBy,
        approved_at: new Date(approvedAtMs).toISOString(),
        reason_codes: reasonCodes,
        expires_at: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString()
      }
    };
  }

  _resolveExecutionRequestForProvider({ providerId, requestId, correlationId: corr }) {
    const normalizedRequestId = normalizeOptionalString(requestId);
    if (!normalizedRequestId) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'request_id is required', {
          reason_code: 'liquidity_execution_request_invalid'
        })
      };
    }

    const executionRequest = this.store.state.liquidity_execution_requests?.[normalizedRequestId] ?? null;
    if (!executionRequest || executionRequest.provider_id !== providerId) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'liquidity execution request not found', {
          reason_code: 'liquidity_execution_request_not_found',
          request_id: normalizedRequestId,
          provider_id: providerId
        })
      };
    }

    return { ok: true, request: executionRequest };
  }

  upsertMode({ actor, auth, providerId, idempotencyKey, request }) {
    const op = 'liquidityExecution.mode.upsert';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const partnerGuard = this._requirePartner({
      actor,
      operationId: op,
      correlationId: corr,
      reasonCode: 'liquidity_execution_mode_restricted'
    });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    const resolvedProvider = this._resolveProviderForActor({
      actor,
      providerId,
      correlationId: corr,
      invalidReasonCode: 'liquidity_execution_mode_invalid'
    });
    if (!resolvedProvider.ok) return { replayed: false, result: { ok: false, body: resolvedProvider.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: { provider_id: resolvedProvider.provider_id, request },
      correlationId: corr,
      scopeSuffix: resolvedProvider.provider_id,
      handler: () => {
        const modeReq = request?.mode;
        if (!isObject(modeReq)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity execution mode payload', {
              reason_code: 'liquidity_execution_mode_invalid'
            })
          };
        }

        const mode = normalizeOptionalString(modeReq.mode);
        const restrictedAdapterContext = typeof modeReq.restricted_adapter_context === 'boolean'
          ? modeReq.restricted_adapter_context
          : true;

        const updatedAtRaw = normalizeOptionalString(modeReq.updated_at) ?? this._nowIso(auth);
        const updatedAtMs = parseIsoMs(updatedAtRaw);
        const normalizedOverride = this._normalizeOverridePolicy(modeReq.override_policy);

        if (!mode || !EXECUTION_MODES.has(mode) || updatedAtMs === null || !normalizedOverride.ok) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity execution mode payload', {
              reason_code: 'liquidity_execution_mode_invalid'
            })
          };
        }

        if (mode === 'constrained_auto' && restrictedAdapterContext) {
          if (!normalizedOverride.value) {
            return {
              ok: false,
              body: errorResponse(corr, 'FORBIDDEN', 'restricted adapter context requires approved override policy for constrained_auto mode', {
                reason_code: 'liquidity_execution_mode_restricted',
                provider_id: resolvedProvider.provider_id,
                mode,
                restricted_adapter_context: restrictedAdapterContext
              })
            };
          }

          if (!this._integrationGateEnabled()) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONFLICT', 'platform policy blocks constrained_auto while integration gate is disabled', {
                reason_code: 'liquidity_execution_platform_policy_blocked',
                provider_id: resolvedProvider.provider_id,
                required_env: 'INTEGRATION_ENABLED=1'
              })
            };
          }
        }

        const nextMode = {
          provider_id: resolvedProvider.provider_id,
          mode,
          restricted_adapter_context: restrictedAdapterContext,
          override_policy: mode === 'constrained_auto' ? normalizedOverride.value : null,
          updated_at: new Date(updatedAtMs).toISOString(),
          updated_by: clone(actor)
        };

        this.store.state.liquidity_execution_modes[resolvedProvider.provider_id] = nextMode;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            provider_id: resolvedProvider.provider_id,
            execution_mode: executionModeView(nextMode, { integrationGateEnabled: this._integrationGateEnabled() })
          }
        };
      }
    });
  }

  getMode({ actor, auth, providerId }) {
    const op = 'liquidityExecution.mode.get';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const partnerGuard = this._requirePartner({
      actor,
      operationId: op,
      correlationId: corr,
      reasonCode: 'liquidity_execution_mode_restricted'
    });
    if (partnerGuard) return partnerGuard;

    const resolvedProvider = this._resolveProviderForActor({
      actor,
      providerId,
      correlationId: corr,
      invalidReasonCode: 'liquidity_execution_mode_invalid'
    });
    if (!resolvedProvider.ok) return { ok: false, body: resolvedProvider.body };

    const mode = this._effectiveModeRecord({
      providerId: resolvedProvider.provider_id,
      provider: resolvedProvider.provider,
      nowIso: this._nowIso(auth)
    });

    return {
      ok: true,
      body: {
        correlation_id: corr,
        provider_id: resolvedProvider.provider_id,
        execution_mode: executionModeView(mode, { integrationGateEnabled: this._integrationGateEnabled() })
      }
    };
  }

  recordRequest({ actor, auth, providerId, idempotencyKey, request }) {
    const op = 'liquidityExecution.request.record';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const partnerGuard = this._requirePartner({
      actor,
      operationId: op,
      correlationId: corr,
      reasonCode: 'liquidity_execution_request_invalid'
    });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    const resolvedProvider = this._resolveProviderForActor({
      actor,
      providerId,
      correlationId: corr,
      invalidReasonCode: 'liquidity_execution_request_invalid'
    });
    if (!resolvedProvider.ok) return { replayed: false, result: { ok: false, body: resolvedProvider.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: { provider_id: resolvedProvider.provider_id, request },
      correlationId: corr,
      scopeSuffix: resolvedProvider.provider_id,
      handler: () => {
        const requestPayload = request?.execution_request;
        if (!isObject(requestPayload)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity execution request payload', {
              reason_code: 'liquidity_execution_request_invalid'
            })
          };
        }

        const modeRecord = this._effectiveModeRecord({
          providerId: resolvedProvider.provider_id,
          provider: resolvedProvider.provider,
          nowIso: this._nowIso(auth)
        });

        if (modeRecord.mode === 'constrained_auto' && modeRecord.restricted_adapter_context) {
          if (!modeRecord.override_policy) {
            return {
              ok: false,
              body: errorResponse(corr, 'FORBIDDEN', 'restricted adapter context requires approved override policy before execution request recording', {
                reason_code: 'liquidity_execution_mode_restricted',
                provider_id: resolvedProvider.provider_id,
                mode: modeRecord.mode
              })
            };
          }

          const overrideExpiresMs = parseIsoMs(modeRecord.override_policy.expires_at);
          const nowMs = parseIsoMs(this._nowIso(auth));
          if (overrideExpiresMs !== null && nowMs !== null && nowMs > overrideExpiresMs) {
            return {
              ok: false,
              body: errorResponse(corr, 'FORBIDDEN', 'execution override policy has expired', {
                reason_code: 'liquidity_execution_mode_restricted',
                provider_id: resolvedProvider.provider_id,
                override_id: modeRecord.override_policy.override_id
              })
            };
          }

          if (!this._integrationGateEnabled()) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONFLICT', 'platform policy blocks constrained_auto while integration gate is disabled', {
                reason_code: 'liquidity_execution_platform_policy_blocked',
                provider_id: resolvedProvider.provider_id,
                required_env: 'INTEGRATION_ENABLED=1'
              })
            };
          }
        }

        const requestedRequestId = normalizeOptionalString(requestPayload.request_id);
        const proposalId = normalizeOptionalString(requestPayload.proposal_id);
        const cycleId = normalizeOptionalString(requestPayload.cycle_id);
        const intentIds = normalizeIntentIds(requestPayload.intent_ids);
        const actionType = normalizeOptionalString(requestPayload.action_type);
        const riskClass = normalizeOptionalString(requestPayload.risk_class);
        const reasonCodes = normalizeReasonCodes(requestPayload.reason_codes);
        const executionCorrelationId = normalizeOptionalString(requestPayload.correlation_id);
        const requestedAtRaw = normalizeOptionalString(requestPayload.requested_at)
          ?? normalizeOptionalString(request?.requested_at)
          ?? this._nowIso(auth);
        const requestedAtMs = parseIsoMs(requestedAtRaw);
        const metadata = requestPayload.metadata === undefined ? {} : (isObject(requestPayload.metadata) ? requestPayload.metadata : null);
        const autoExecute = requestPayload.auto_execute === true;
        const platformPolicyBlocked = requestPayload.platform_policy_blocked === true;

        if (!actionType
          || !ACTION_TYPES.has(actionType)
          || !riskClass
          || !RISK_CLASSES.has(riskClass)
          || !reasonCodes
          || !executionCorrelationId
          || requestedAtMs === null
          || intentIds === null
          || metadata === null
          || (!proposalId && !cycleId && (intentIds?.length ?? 0) < 1)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity execution request payload', {
              reason_code: 'liquidity_execution_request_invalid'
            })
          };
        }

        if (platformPolicyBlocked) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONFLICT', 'platform policy blocked execution request', {
              reason_code: 'liquidity_execution_platform_policy_blocked',
              provider_id: resolvedProvider.provider_id,
              request_id: requestedRequestId ?? null
            })
          };
        }

        if (autoExecute) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'explicit operator approval is required for execution requests', {
              reason_code: 'liquidity_execution_operator_approval_required',
              provider_id: resolvedProvider.provider_id,
              request_id: requestedRequestId ?? null
            })
          };
        }

        const requestId = requestedRequestId ?? nextExecutionRequestId(this.store);
        const existingByRequestId = this.store.state.liquidity_execution_requests[requestId] ?? null;
        if (existingByRequestId) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONFLICT', 'execution request id already exists', {
              reason_code: 'liquidity_execution_request_invalid',
              provider_id: resolvedProvider.provider_id,
              request_id: requestId
            })
          };
        }

        const nextRequest = {
          request_id: requestId,
          provider_id: resolvedProvider.provider_id,
          proposal_id: proposalId,
          cycle_id: cycleId,
          intent_ids: intentIds,
          action_type: actionType,
          risk_class: riskClass,
          reason_codes: reasonCodes,
          correlation_id: executionCorrelationId,
          requested_at: new Date(requestedAtMs).toISOString(),
          requested_by: clone(actor),
          mode_snapshot: {
            mode: modeRecord.mode,
            restricted_adapter_context: modeRecord.restricted_adapter_context,
            override_policy: modeRecord.override_policy ? clone(modeRecord.override_policy) : null
          },
          metadata: clone(metadata),
          status: 'pending',
          decision: null,
          operator_actor: null,
          decision_reason_codes: [],
          decision_correlation_id: null,
          decided_at: null
        };

        this.store.state.liquidity_execution_requests[nextRequest.request_id] = nextRequest;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            provider_id: resolvedProvider.provider_id,
            execution_request: executionRequestView(nextRequest)
          }
        };
      }
    });
  }

  approveRequest({ actor, auth, providerId, requestId, idempotencyKey, request }) {
    const op = 'liquidityExecution.request.approve';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const partnerGuard = this._requirePartner({
      actor,
      operationId: op,
      correlationId: corr,
      reasonCode: 'liquidity_execution_operator_approval_required'
    });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    const resolvedProvider = this._resolveProviderForActor({
      actor,
      providerId,
      correlationId: corr,
      invalidReasonCode: 'liquidity_execution_request_invalid'
    });
    if (!resolvedProvider.ok) return { replayed: false, result: { ok: false, body: resolvedProvider.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: { provider_id: resolvedProvider.provider_id, request_id: requestId, request },
      correlationId: corr,
      scopeSuffix: `${resolvedProvider.provider_id}:${requestId}`,
      handler: () => {
        const decisionPayload = request?.decision;
        if (!isObject(decisionPayload)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity execution approval payload', {
              reason_code: 'liquidity_execution_request_invalid'
            })
          };
        }

        const operatorActor = normalizeActorRef(decisionPayload.operator_actor);
        if (!operatorActor) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'operator actor is required for execution approval', {
              reason_code: 'liquidity_execution_operator_approval_required'
            })
          };
        }

        const reasonCodes = normalizeReasonCodes(decisionPayload.reason_codes);
        const decisionCorrelationId = normalizeOptionalString(decisionPayload.correlation_id);
        const approvedAtRaw = normalizeOptionalString(decisionPayload.approved_at)
          ?? normalizeOptionalString(request?.approved_at)
          ?? this._nowIso(auth);
        const approvedAtMs = parseIsoMs(approvedAtRaw);

        if (!reasonCodes || !decisionCorrelationId || approvedAtMs === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity execution approval payload', {
              reason_code: 'liquidity_execution_request_invalid'
            })
          };
        }

        const resolvedRequest = this._resolveExecutionRequestForProvider({
          providerId: resolvedProvider.provider_id,
          requestId,
          correlationId: corr
        });
        if (!resolvedRequest.ok) return { ok: false, body: resolvedRequest.body };

        const executionRequest = resolvedRequest.request;
        if (executionRequest.status === 'rejected') {
          return {
            ok: false,
            body: errorResponse(corr, 'CONFLICT', 'execution request has already been rejected', {
              reason_code: 'liquidity_execution_request_invalid',
              request_id: executionRequest.request_id,
              status: executionRequest.status
            })
          };
        }

        if (executionRequest.status === 'approved') {
          const sameApproval = actorRefEqual(executionRequest.operator_actor, operatorActor)
            && sortedArrayEqual(executionRequest.decision_reason_codes, reasonCodes)
            && executionRequest.decision_correlation_id === decisionCorrelationId;
          if (!sameApproval) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONFLICT', 'execution request already approved with different payload', {
                reason_code: 'liquidity_execution_request_invalid',
                request_id: executionRequest.request_id,
                status: executionRequest.status
              })
            };
          }

          return {
            ok: true,
            body: {
              correlation_id: corr,
              provider_id: resolvedProvider.provider_id,
              execution_request: executionRequestView(executionRequest)
            }
          };
        }

        executionRequest.status = 'approved';
        executionRequest.decision = 'approve';
        executionRequest.operator_actor = clone(operatorActor);
        executionRequest.decision_reason_codes = reasonCodes;
        executionRequest.decision_correlation_id = decisionCorrelationId;
        executionRequest.decided_at = new Date(approvedAtMs).toISOString();

        return {
          ok: true,
          body: {
            correlation_id: corr,
            provider_id: resolvedProvider.provider_id,
            execution_request: executionRequestView(executionRequest)
          }
        };
      }
    });
  }

  rejectRequest({ actor, auth, providerId, requestId, idempotencyKey, request }) {
    const op = 'liquidityExecution.request.reject';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const partnerGuard = this._requirePartner({
      actor,
      operationId: op,
      correlationId: corr,
      reasonCode: 'liquidity_execution_operator_approval_required'
    });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    const resolvedProvider = this._resolveProviderForActor({
      actor,
      providerId,
      correlationId: corr,
      invalidReasonCode: 'liquidity_execution_request_invalid'
    });
    if (!resolvedProvider.ok) return { replayed: false, result: { ok: false, body: resolvedProvider.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: { provider_id: resolvedProvider.provider_id, request_id: requestId, request },
      correlationId: corr,
      scopeSuffix: `${resolvedProvider.provider_id}:${requestId}`,
      handler: () => {
        const decisionPayload = request?.decision;
        if (!isObject(decisionPayload)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity execution rejection payload', {
              reason_code: 'liquidity_execution_request_invalid'
            })
          };
        }

        const operatorActor = normalizeActorRef(decisionPayload.operator_actor);
        if (!operatorActor) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'operator actor is required for execution rejection', {
              reason_code: 'liquidity_execution_operator_approval_required'
            })
          };
        }

        const reasonCodes = normalizeReasonCodes(decisionPayload.reason_codes);
        const decisionCorrelationId = normalizeOptionalString(decisionPayload.correlation_id);
        const rejectedAtRaw = normalizeOptionalString(decisionPayload.rejected_at)
          ?? normalizeOptionalString(request?.rejected_at)
          ?? this._nowIso(auth);
        const rejectedAtMs = parseIsoMs(rejectedAtRaw);

        if (!reasonCodes || !decisionCorrelationId || rejectedAtMs === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity execution rejection payload', {
              reason_code: 'liquidity_execution_request_invalid'
            })
          };
        }

        const resolvedRequest = this._resolveExecutionRequestForProvider({
          providerId: resolvedProvider.provider_id,
          requestId,
          correlationId: corr
        });
        if (!resolvedRequest.ok) return { ok: false, body: resolvedRequest.body };

        const executionRequest = resolvedRequest.request;
        if (executionRequest.status === 'approved') {
          return {
            ok: false,
            body: errorResponse(corr, 'CONFLICT', 'execution request has already been approved', {
              reason_code: 'liquidity_execution_request_invalid',
              request_id: executionRequest.request_id,
              status: executionRequest.status
            })
          };
        }

        if (executionRequest.status === 'rejected') {
          const sameRejection = actorRefEqual(executionRequest.operator_actor, operatorActor)
            && sortedArrayEqual(executionRequest.decision_reason_codes, reasonCodes)
            && executionRequest.decision_correlation_id === decisionCorrelationId;
          if (!sameRejection) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONFLICT', 'execution request already rejected with different payload', {
                reason_code: 'liquidity_execution_request_invalid',
                request_id: executionRequest.request_id,
                status: executionRequest.status
              })
            };
          }

          return {
            ok: true,
            body: {
              correlation_id: corr,
              provider_id: resolvedProvider.provider_id,
              execution_request: executionRequestView(executionRequest)
            }
          };
        }

        executionRequest.status = 'rejected';
        executionRequest.decision = 'reject';
        executionRequest.operator_actor = clone(operatorActor);
        executionRequest.decision_reason_codes = reasonCodes;
        executionRequest.decision_correlation_id = decisionCorrelationId;
        executionRequest.decided_at = new Date(rejectedAtMs).toISOString();

        return {
          ok: true,
          body: {
            correlation_id: corr,
            provider_id: resolvedProvider.provider_id,
            execution_request: executionRequestView(executionRequest)
          }
        };
      }
    });
  }

  exportRequests({ actor, auth, providerId, query }) {
    const op = 'liquidityExecution.export';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const partnerGuard = this._requirePartner({
      actor,
      operationId: op,
      correlationId: corr,
      reasonCode: 'liquidity_execution_request_invalid'
    });
    if (partnerGuard) return partnerGuard;

    const resolvedProvider = this._resolveProviderForActor({
      actor,
      providerId,
      correlationId: corr,
      invalidReasonCode: 'liquidity_execution_request_invalid'
    });
    if (!resolvedProvider.ok) return { ok: false, body: resolvedProvider.body };

    const allowed = new Set([
      'status',
      'risk_class',
      'from_iso',
      'to_iso',
      'limit',
      'cursor_after',
      'attestation_after',
      'checkpoint_after',
      'retention_days',
      'now_iso',
      'exported_at_iso'
    ]);
    const unknown = Object.keys(query ?? {}).filter(key => !allowed.has(key));
    if (unknown.length > 0) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity execution export query', {
          reason_code: 'liquidity_execution_request_invalid',
          unknown_query_params: unknown.sort()
        })
      };
    }

    const statusFilter = normalizeOptionalString(query?.status);
    const riskClassFilter = normalizeOptionalString(query?.risk_class);
    const fromIso = normalizeOptionalString(query?.from_iso);
    const toIso = normalizeOptionalString(query?.to_iso);
    const fromMs = fromIso ? parseIsoMs(fromIso) : null;
    const toMs = toIso ? parseIsoMs(toIso) : null;
    const limit = parseLimit(query?.limit, 50);

    const nowIso = normalizeOptionalString(query?.now_iso) ?? auth?.now_iso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
    const nowMs = parseIsoMs(nowIso);
    const retentionDays = exportRetentionDays(query);

    if ((statusFilter && !REQUEST_STATUSES.has(statusFilter))
      || (riskClassFilter && !RISK_CLASSES.has(riskClassFilter))
      || (fromIso && fromMs === null)
      || (toIso && toMs === null)
      || limit === null
      || nowMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity execution export query', {
          reason_code: 'liquidity_execution_request_invalid'
        })
      };
    }

    const cursorAfter = normalizeOptionalString(query?.cursor_after);
    const attestationAfter = normalizeOptionalString(query?.attestation_after);
    const checkpointAfter = normalizeOptionalString(query?.checkpoint_after);

    if (cursorAfter && (!attestationAfter || !checkpointAfter)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity execution export query', {
          reason_code: 'liquidity_execution_request_invalid',
          cursor_after: cursorAfter,
          attestation_after: attestationAfter,
          checkpoint_after: checkpointAfter
        })
      };
    }

    if (!cursorAfter && (attestationAfter || checkpointAfter)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity execution export query', {
          reason_code: 'liquidity_execution_request_invalid',
          cursor_after: cursorAfter,
          attestation_after: attestationAfter,
          checkpoint_after: checkpointAfter
        })
      };
    }

    const cutoffMs = nowMs - (retentionDays * 24 * 60 * 60 * 1000);

    let requests = Object.values(this.store.state.liquidity_execution_requests ?? {})
      .filter(row => row.provider_id === resolvedProvider.provider_id)
      .filter(row => {
        const requestedAtMs = parseIsoMs(row.requested_at);
        return requestedAtMs !== null && requestedAtMs >= cutoffMs;
      });

    if (statusFilter) requests = requests.filter(row => row.status === statusFilter);
    if (riskClassFilter) requests = requests.filter(row => row.risk_class === riskClassFilter);
    if (fromMs !== null) requests = requests.filter(row => (parseIsoMs(row.requested_at) ?? 0) >= fromMs);
    if (toMs !== null) requests = requests.filter(row => (parseIsoMs(row.requested_at) ?? 0) <= toMs);

    requests.sort(requestSort);

    let startIndex = 0;
    if (cursorAfter) {
      const idx = requests.findIndex(row => requestCursorKey(row) === cursorAfter);
      if (idx < 0) {
        return {
          ok: false,
          body: errorResponse(corr, 'NOT_FOUND', 'cursor_after not found for liquidity execution export', {
            reason_code: 'liquidity_execution_request_not_found',
            cursor_after: cursorAfter
          })
        };
      }
      startIndex = idx + 1;
    }

    const filteredAfterCursor = requests.slice(startIndex);
    const totalFiltered = filteredAfterCursor.length;
    const page = filteredAfterCursor.slice(0, limit);
    const nextCursor = filteredAfterCursor.length > limit
      ? requestCursorKey(page[page.length - 1])
      : null;

    const checkpointState = this.store.state.liquidity_execution_export_checkpoints;
    const contextFingerprint = exportContextFingerprint({
      actor,
      providerId: resolvedProvider.provider_id,
      query,
      limit,
      retentionDays
    });

    pruneExpiredCheckpoints({
      checkpointState,
      nowMs,
      retentionDays
    });

    if (cursorAfter) {
      const priorCheckpoint = checkpointState[checkpointAfter] ?? null;
      if (!priorCheckpoint) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity execution export continuation checkpoint', {
            reason_code: 'liquidity_execution_request_invalid',
            checkpoint_after: checkpointAfter
          })
        };
      }

      if (priorCheckpoint.next_cursor !== cursorAfter) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity execution export continuation cursor', {
            reason_code: 'liquidity_execution_request_invalid',
            checkpoint_after: checkpointAfter,
            expected_cursor_after: priorCheckpoint.next_cursor ?? null,
            cursor_after: cursorAfter
          })
        };
      }

      if (priorCheckpoint.attestation_chain_hash !== attestationAfter) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity execution export continuation attestation', {
            reason_code: 'liquidity_execution_request_invalid',
            checkpoint_after: checkpointAfter,
            expected_attestation_after: priorCheckpoint.attestation_chain_hash ?? null,
            attestation_after: attestationAfter
          })
        };
      }

      if (priorCheckpoint.query_context_fingerprint !== contextFingerprint) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity execution export continuation filter context', {
            reason_code: 'liquidity_execution_request_invalid',
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
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity execution export query', {
          reason_code: 'liquidity_execution_request_invalid',
          exported_at_iso: query?.exported_at_iso ?? null
        })
      };
    }
    const exportedAt = new Date(exportedAtMs).toISOString();

    const entries = page.map(row => executionRequestView(row));
    const signedPayload = buildSignedPolicyAuditExportPayload({
      exportedAt,
      query: {
        provider_id: resolvedProvider.provider_id,
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(riskClassFilter ? { risk_class: riskClassFilter } : {}),
        ...(fromIso ? { from_iso: fromIso } : {}),
        ...(toIso ? { to_iso: toIso } : {}),
        limit,
        ...(cursorAfter ? { cursor_after: cursorAfter } : {}),
        ...(attestationAfter ? { attestation_after: attestationAfter } : {}),
        ...(checkpointAfter ? { checkpoint_after: checkpointAfter } : {}),
        retention_days: retentionDays,
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
        provider_id: resolvedProvider.provider_id,
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
        provider_id: resolvedProvider.provider_id,
        export: signedPayload
      }
    };
  }
}
