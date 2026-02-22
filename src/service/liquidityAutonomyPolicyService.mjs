import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { buildSignedPolicyAuditExportPayload } from '../crypto/policyIntegritySigning.mjs';
import { canonicalStringify } from '../util/canonicalJson.mjs';

const PRECEDENCE = 'safety>trust>lp_autonomy_policy>commercial>preference';
const HIGH_VOLATILITY_MODES = new Set(['tighten', 'pause', 'quote_only']);
const POLICY_MODES = new Set(['simulation', 'operator_assisted', 'constrained_auto', 'manual']);
const ASSET_LIQUIDITY_TIERS = new Set(['low', 'medium', 'high', 'critical']);
const EVALUATION_ACTION_TYPES = new Set(['quote', 'accept', 'execute']);
const VERDICTS = new Set(['allow', 'deny']);
const DAY_MS = 24 * 60 * 60 * 1000;

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

function parseBps(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 0 || n > 10000) return null;
  return n;
}

function parseNonNegativeUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function parseBooleanLike(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) return fallback;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  return null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function actorRef(actor) {
  return {
    type: actor?.type ?? 'unknown',
    id: actor?.id ?? 'unknown'
  };
}

function deterministicId(prefix, value) {
  const digest = createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 16);
  return `${prefix}_${digest}`;
}

function normalizeBlockedAssetLiquidityTiers(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const tier of raw) {
    const normalized = normalizeOptionalString(tier)?.toLowerCase();
    if (!normalized || !ASSET_LIQUIDITY_TIERS.has(normalized)) return null;
    out.push(normalized);
  }
  return Array.from(new Set(out)).sort();
}

function pushReasonCode(out, code) {
  if (!out.includes(code)) out.push(code);
}

function providerOwnerMismatch(actor, provider) {
  return actor?.type !== provider?.owner_actor?.type || actor?.id !== provider?.owner_actor?.id;
}

function policyConstraintsDigest(policy) {
  const canonical = {
    precedence_assertion: policy.precedence_assertion,
    max_spread_bps: policy.max_spread_bps,
    max_daily_value_usd: policy.max_daily_value_usd,
    max_counterparty_exposure_usd: policy.max_counterparty_exposure_usd,
    min_price_confidence_bps: policy.min_price_confidence_bps,
    blocked_asset_liquidity_tiers: clone(policy.blocked_asset_liquidity_tiers ?? []),
    high_volatility_mode: policy.high_volatility_mode
  };
  return createHash('sha256').update(canonicalStringify(canonical), 'utf8').digest('hex');
}

function buildPolicyRef(policy) {
  return {
    policy_id: policy.policy_id,
    policy_version: policy.version,
    policy_mode: policy.policy_mode,
    constraints_hash: `sha256:${policyConstraintsDigest(policy)}`
  };
}

function defaultPolicy({ providerId, provider, nowIso, actor }) {
  const providerPolicyRef = provider?.policy_ref ?? null;
  const requestedPolicyMode = normalizeOptionalString(providerPolicyRef?.policy_mode);
  const policyMode = requestedPolicyMode && POLICY_MODES.has(requestedPolicyMode)
    ? requestedPolicyMode
    : 'constrained_auto';
  const requestedVersion = Number.parseInt(String(providerPolicyRef?.policy_version ?? ''), 10);
  const version = Number.isFinite(requestedVersion) && requestedVersion > 0 ? requestedVersion : 1;

  const policy = {
    provider_id: providerId,
    policy_id: normalizeOptionalString(providerPolicyRef?.policy_id) ?? `lp_policy_${providerId}`,
    version,
    policy_mode: policyMode,
    precedence_assertion: PRECEDENCE,
    max_spread_bps: 500,
    max_daily_value_usd: 25000,
    max_counterparty_exposure_usd: 5000,
    min_price_confidence_bps: 7000,
    blocked_asset_liquidity_tiers: ['critical'],
    high_volatility_mode: 'tighten',
    updated_at: normalizeOptionalString(provider?.updated_at) ?? nowIso,
    updated_by: actorRef(actor)
  };

  policy.policy_ref = buildPolicyRef(policy);
  return policy;
}

function normalizePolicyRecordForResponse(record) {
  return {
    provider_id: record.provider_id,
    policy_id: record.policy_id,
    version: record.version,
    policy_mode: record.policy_mode,
    precedence_assertion: record.precedence_assertion,
    max_spread_bps: record.max_spread_bps,
    max_daily_value_usd: record.max_daily_value_usd,
    max_counterparty_exposure_usd: record.max_counterparty_exposure_usd,
    min_price_confidence_bps: record.min_price_confidence_bps,
    blocked_asset_liquidity_tiers: clone(record.blocked_asset_liquidity_tiers ?? []),
    high_volatility_mode: record.high_volatility_mode,
    policy_ref: clone(record.policy_ref),
    updated_at: record.updated_at,
    updated_by: clone(record.updated_by)
  };
}

function parsePolicyPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const precedenceAssertion = normalizeOptionalString(raw.precedence_assertion);
  const maxSpreadBps = parseBps(raw.max_spread_bps);
  const maxDailyValueUsd = parseNonNegativeUsd(raw.max_daily_value_usd);
  const maxCounterpartyExposureUsd = parseNonNegativeUsd(raw.max_counterparty_exposure_usd);
  const minPriceConfidenceBps = parseBps(raw.min_price_confidence_bps);
  const blockedAssetLiquidityTiers = normalizeBlockedAssetLiquidityTiers(raw.blocked_asset_liquidity_tiers);
  const highVolatilityMode = normalizeOptionalString(raw.high_volatility_mode);
  const policyId = normalizeOptionalString(raw.policy_id);
  const policyMode = normalizeOptionalString(raw.policy_mode);
  const updatedAt = normalizeOptionalString(raw.updated_at);

  if (!precedenceAssertion
    || maxSpreadBps === null
    || maxDailyValueUsd === null
    || maxCounterpartyExposureUsd === null
    || minPriceConfidenceBps === null
    || blockedAssetLiquidityTiers === null
    || !highVolatilityMode
    || !HIGH_VOLATILITY_MODES.has(highVolatilityMode)
    || (policyMode && !POLICY_MODES.has(policyMode))) {
    return null;
  }

  return {
    policy_id: policyId,
    policy_mode: policyMode,
    precedence_assertion: precedenceAssertion,
    max_spread_bps: maxSpreadBps,
    max_daily_value_usd: maxDailyValueUsd,
    max_counterparty_exposure_usd: maxCounterpartyExposureUsd,
    min_price_confidence_bps: minPriceConfidenceBps,
    blocked_asset_liquidity_tiers: blockedAssetLiquidityTiers,
    high_volatility_mode: highVolatilityMode,
    updated_at: updatedAt
  };
}

function parseEvaluationPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const operationId = normalizeOptionalString(raw.operation_id);
  const precedenceAssertion = normalizeOptionalString(raw.precedence_assertion);
  const actionType = normalizeOptionalString(raw.action_type);
  const counterpartyActorId = normalizeOptionalString(raw.counterparty_actor_id);
  const assetLiquidityTier = normalizeOptionalString(raw.asset_liquidity_tier)?.toLowerCase();

  const spreadBps = parseBps(raw.spread_bps);
  const quoteValueUsd = parseNonNegativeUsd(raw.quote_value_usd);
  const dailyValueUsd = parseNonNegativeUsd(raw.daily_value_usd);
  const counterpartyExposureUsd = parseNonNegativeUsd(raw.counterparty_exposure_usd);
  const priceConfidenceBps = parseBps(raw.price_confidence_bps);

  if (!operationId
    || !precedenceAssertion
    || typeof raw.safety_gate_passed !== 'boolean'
    || typeof raw.trust_gate_passed !== 'boolean'
    || typeof raw.commercial_gate_passed !== 'boolean'
    || typeof raw.high_volatility !== 'boolean'
    || !actionType
    || !EVALUATION_ACTION_TYPES.has(actionType)
    || spreadBps === null
    || quoteValueUsd === null
    || dailyValueUsd === null
    || !counterpartyActorId
    || counterpartyExposureUsd === null
    || priceConfidenceBps === null
    || !assetLiquidityTier
    || !ASSET_LIQUIDITY_TIERS.has(assetLiquidityTier)) {
    return null;
  }

  return {
    operation_id: operationId,
    precedence_assertion: precedenceAssertion,
    safety_gate_passed: raw.safety_gate_passed,
    trust_gate_passed: raw.trust_gate_passed,
    commercial_gate_passed: raw.commercial_gate_passed,
    action_type: actionType,
    spread_bps: spreadBps,
    quote_value_usd: quoteValueUsd,
    daily_value_usd: dailyValueUsd,
    counterparty_actor_id: counterpartyActorId,
    counterparty_exposure_usd: counterpartyExposureUsd,
    price_confidence_bps: priceConfidenceBps,
    asset_liquidity_tier: assetLiquidityTier,
    high_volatility: raw.high_volatility
  };
}

function auditCursor(entry) {
  return `${entry.evaluated_at}|${entry.audit_id}`;
}

function auditSort(a, b) {
  const aMs = parseIsoMs(a?.evaluated_at) ?? 0;
  const bMs = parseIsoMs(b?.evaluated_at) ?? 0;
  if (aMs !== bMs) return aMs - bMs;
  return String(a?.audit_id ?? '').localeCompare(String(b?.audit_id ?? ''));
}

function normalizeAuditEntry(entry, { redactCounterparty = false } = {}) {
  const inputSummary = clone(entry.input_summary ?? {});
  if (redactCounterparty && inputSummary.counterparty_actor_id) {
    inputSummary.counterparty_actor_id = 'redacted';
  }

  return {
    audit_id: entry.audit_id,
    evaluation_id: entry.evaluation_id,
    provider_id: entry.provider_id,
    operation_id: entry.operation_id,
    verdict: entry.verdict,
    reason_codes: clone(entry.reason_codes ?? []),
    enforced_precedence: entry.enforced_precedence,
    policy_ref: clone(entry.policy_ref),
    policy_version: entry.policy_version,
    evaluated_at: entry.evaluated_at,
    actor: clone(entry.actor),
    input_summary: inputSummary
  };
}

function queryContext({ fromIso, toIso, verdict, counterpartyActorId, reasonCode, limit, retentionDays, redactCounterparty }) {
  return {
    from_iso: fromIso,
    to_iso: toIso,
    verdict,
    counterparty_actor_id: counterpartyActorId,
    reason_code: reasonCode,
    limit,
    retention_days: retentionDays,
    redact_counterparty: redactCounterparty
  };
}

function exportRetentionDays(query) {
  const fromQuery = parsePositiveInt(query?.retention_days);
  if (fromQuery !== null) return Math.min(fromQuery, 3650);

  const fromEnv = parsePositiveInt(process.env.LIQUIDITY_POLICY_AUDIT_EXPORT_RETENTION_DAYS);
  if (fromEnv !== null) return Math.min(fromEnv, 3650);

  return 180;
}

function checkpointRetentionDays(defaultDays) {
  const env = parsePositiveInt(process.env.LIQUIDITY_POLICY_AUDIT_EXPORT_CHECKPOINT_RETENTION_DAYS);
  if (env !== null) return Math.min(env, 3650);
  return defaultDays;
}

function checkpointRetentionWindowMs(defaultDays) {
  return checkpointRetentionDays(defaultDays) * DAY_MS;
}

function pruneExpiredCheckpoints({ checkpointState, nowMs, retentionDays }) {
  for (const [checkpointHash, checkpoint] of Object.entries(checkpointState)) {
    const exportedAtMs = parseIsoMs(checkpoint?.exported_at);
    if (exportedAtMs === null || nowMs > exportedAtMs + checkpointRetentionWindowMs(retentionDays)) {
      delete checkpointState[checkpointHash];
    }
  }
}

function ensureState(store) {
  store.state.idempotency ||= {};
  store.state.liquidity_policies ||= {};
  store.state.liquidity_policy_decision_audit ||= [];
  store.state.liquidity_policy_decision_audit_counter ||= 0;
  store.state.liquidity_policy_export_checkpoints ||= {};
  store.state.liquidity_policy_daily_usage ||= {};
  store.state.liquidity_policy_counterparty_exposure ||= {};
}

function nextAuditId(store) {
  store.state.liquidity_policy_decision_audit_counter += 1;
  return `lpaudit_${String(store.state.liquidity_policy_decision_audit_counter).padStart(6, '0')}`;
}

export class LiquidityAutonomyPolicyService {
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

  _authorize({ operationId, actor, auth, correlationId: corr }) {
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
      body: errorResponse(corr, 'FORBIDDEN', 'only partner actors are allowed for liquidity policy operations', {
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
        return {
          replayed: true,
          result: clone(existing.result)
        };
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

  _effectivePolicyRecord({ providerId, provider, nowIso, actor }) {
    const existing = this.store.state.liquidity_policies[providerId] ?? null;
    if (existing) return existing;
    return defaultPolicy({
      providerId,
      provider,
      nowIso,
      actor: provider?.owner_actor ?? actor
    });
  }

  upsertPolicy({ actor, auth, providerId, idempotencyKey, request }) {
    const op = 'liquidityPolicy.upsert';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const partnerGuard = this._requirePartner({
      actor,
      operationId: op,
      correlationId: corr,
      reasonCode: 'liquidity_policy_invalid'
    });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    const resolvedProvider = this._resolveProviderForActor({
      actor,
      providerId,
      correlationId: corr,
      invalidReasonCode: 'liquidity_policy_invalid'
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
        const parsedPolicy = parsePolicyPayload(request?.policy);
        if (!parsedPolicy) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity policy payload', {
              reason_code: 'liquidity_policy_invalid'
            })
          };
        }

        if (parsedPolicy.precedence_assertion !== PRECEDENCE) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'liquidity policy precedence assertion failed', {
              reason_code: 'liquidity_policy_precedence_violation',
              expected: PRECEDENCE,
              received: parsedPolicy.precedence_assertion
            })
          };
        }

        const updatedAtRaw = parsedPolicy.updated_at
          ?? normalizeOptionalString(request?.recorded_at)
          ?? this._nowIso(auth);
        const updatedAtMs = parseIsoMs(updatedAtRaw);
        if (updatedAtMs === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity policy timestamp', {
              reason_code: 'liquidity_policy_invalid',
              updated_at: parsedPolicy.updated_at ?? request?.recorded_at ?? null
            })
          };
        }

        const currentPolicy = this._effectivePolicyRecord({
          providerId: resolvedProvider.provider_id,
          provider: resolvedProvider.provider,
          nowIso: this._nowIso(auth),
          actor
        });

        const version = (Number(currentPolicy?.version) || 0) + 1;
        const nextPolicy = {
          provider_id: resolvedProvider.provider_id,
          policy_id: parsedPolicy.policy_id ?? currentPolicy.policy_id,
          version,
          policy_mode: parsedPolicy.policy_mode ?? currentPolicy.policy_mode,
          precedence_assertion: PRECEDENCE,
          max_spread_bps: parsedPolicy.max_spread_bps,
          max_daily_value_usd: parsedPolicy.max_daily_value_usd,
          max_counterparty_exposure_usd: parsedPolicy.max_counterparty_exposure_usd,
          min_price_confidence_bps: parsedPolicy.min_price_confidence_bps,
          blocked_asset_liquidity_tiers: clone(parsedPolicy.blocked_asset_liquidity_tiers),
          high_volatility_mode: parsedPolicy.high_volatility_mode,
          updated_at: new Date(updatedAtMs).toISOString(),
          updated_by: actorRef(actor)
        };

        nextPolicy.policy_ref = buildPolicyRef(nextPolicy);

        this.store.state.liquidity_policies[resolvedProvider.provider_id] = nextPolicy;
        resolvedProvider.provider.policy_ref = clone(nextPolicy.policy_ref);
        resolvedProvider.provider.updated_at = nextPolicy.updated_at;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            provider_id: resolvedProvider.provider_id,
            policy: normalizePolicyRecordForResponse(nextPolicy)
          }
        };
      }
    });
  }

  getPolicy({ actor, auth, providerId }) {
    const op = 'liquidityPolicy.get';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const partnerGuard = this._requirePartner({
      actor,
      operationId: op,
      correlationId: corr,
      reasonCode: 'liquidity_policy_invalid'
    });
    if (partnerGuard) return partnerGuard;

    const resolvedProvider = this._resolveProviderForActor({
      actor,
      providerId,
      correlationId: corr,
      invalidReasonCode: 'liquidity_policy_invalid'
    });
    if (!resolvedProvider.ok) return { ok: false, body: resolvedProvider.body };

    const policy = this._effectivePolicyRecord({
      providerId: resolvedProvider.provider_id,
      provider: resolvedProvider.provider,
      nowIso: this._nowIso(auth),
      actor
    });

    return {
      ok: true,
      body: {
        correlation_id: corr,
        provider_id: resolvedProvider.provider_id,
        policy: normalizePolicyRecordForResponse(policy)
      }
    };
  }

  evaluatePolicy({ actor, auth, providerId, idempotencyKey, request }) {
    const op = 'liquidityPolicy.evaluate';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const partnerGuard = this._requirePartner({
      actor,
      operationId: op,
      correlationId: corr,
      reasonCode: 'liquidity_policy_invalid'
    });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    const resolvedProvider = this._resolveProviderForActor({
      actor,
      providerId,
      correlationId: corr,
      invalidReasonCode: 'liquidity_policy_invalid'
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
        const evaluation = parseEvaluationPayload(request?.evaluation);
        if (!evaluation) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity policy evaluation payload', {
              reason_code: 'liquidity_policy_invalid'
            })
          };
        }

        if (evaluation.precedence_assertion !== PRECEDENCE) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'liquidity policy precedence assertion failed', {
              reason_code: 'liquidity_policy_precedence_violation',
              expected: PRECEDENCE,
              received: evaluation.precedence_assertion
            })
          };
        }

        const evaluatedAtRaw = normalizeOptionalString(request?.recorded_at) ?? this._nowIso(auth);
        const evaluatedAtMs = parseIsoMs(evaluatedAtRaw);
        if (evaluatedAtMs === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity policy evaluation timestamp', {
              reason_code: 'liquidity_policy_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const policy = this._effectivePolicyRecord({
          providerId: resolvedProvider.provider_id,
          provider: resolvedProvider.provider,
          nowIso: this._nowIso(auth),
          actor
        });

        const reasonCodes = [];
        if (!evaluation.safety_gate_passed || !evaluation.trust_gate_passed || !evaluation.commercial_gate_passed) {
          pushReasonCode(reasonCodes, 'liquidity_policy_precedence_violation');
        }

        if (evaluation.high_volatility && policy.high_volatility_mode === 'pause') {
          pushReasonCode(reasonCodes, 'liquidity_policy_high_volatility_pause');
        }

        let effectiveMaxSpreadBps = policy.max_spread_bps;
        if (evaluation.high_volatility && policy.high_volatility_mode === 'tighten') {
          effectiveMaxSpreadBps = Math.max(0, Math.floor(policy.max_spread_bps / 2));
        }

        if (evaluation.spread_bps > effectiveMaxSpreadBps) {
          pushReasonCode(reasonCodes, 'liquidity_policy_spread_exceeded');
        }

        if (evaluation.price_confidence_bps < policy.min_price_confidence_bps) {
          pushReasonCode(reasonCodes, 'liquidity_policy_price_confidence_low');
        }

        if (policy.blocked_asset_liquidity_tiers.includes(evaluation.asset_liquidity_tier)) {
          pushReasonCode(reasonCodes, 'liquidity_policy_exposure_exceeded');
        }

        const projectedDailyValueUsd = parseNonNegativeUsd(evaluation.daily_value_usd + evaluation.quote_value_usd) ?? 0;
        const projectedCounterpartyExposureUsd = parseNonNegativeUsd(evaluation.counterparty_exposure_usd + evaluation.quote_value_usd) ?? 0;

        if (projectedDailyValueUsd > policy.max_daily_value_usd
          || projectedCounterpartyExposureUsd > policy.max_counterparty_exposure_usd) {
          pushReasonCode(reasonCodes, 'liquidity_policy_exposure_exceeded');
        }

        if (evaluation.high_volatility && policy.high_volatility_mode === 'quote_only' && evaluation.action_type !== 'quote') {
          pushReasonCode(reasonCodes, 'liquidity_policy_precedence_violation');
        }

        const verdict = reasonCodes.length > 0 ? 'deny' : 'allow';
        const evaluatedAt = new Date(evaluatedAtMs).toISOString();

        const evaluationId = deterministicId(
          'lpeval',
          `${resolvedProvider.provider_id}|${evaluation.operation_id}|${evaluatedAt}|${payloadHash(evaluation)}`
        );
        const auditId = nextAuditId(this.store);

        const inputSummary = {
          action_type: evaluation.action_type,
          spread_bps: evaluation.spread_bps,
          quote_value_usd: evaluation.quote_value_usd,
          daily_value_usd: evaluation.daily_value_usd,
          projected_daily_value_usd: projectedDailyValueUsd,
          counterparty_actor_id: evaluation.counterparty_actor_id,
          counterparty_exposure_usd: evaluation.counterparty_exposure_usd,
          projected_counterparty_exposure_usd: projectedCounterpartyExposureUsd,
          price_confidence_bps: evaluation.price_confidence_bps,
          asset_liquidity_tier: evaluation.asset_liquidity_tier,
          high_volatility: evaluation.high_volatility
        };

        const auditEntry = {
          audit_id: auditId,
          evaluation_id: evaluationId,
          provider_id: resolvedProvider.provider_id,
          operation_id: evaluation.operation_id,
          verdict,
          reason_codes: clone(reasonCodes),
          enforced_precedence: PRECEDENCE,
          policy_ref: clone(policy.policy_ref),
          policy_version: policy.version,
          evaluated_at: evaluatedAt,
          actor: actorRef(actor),
          input_summary: inputSummary
        };

        this.store.state.liquidity_policy_decision_audit.push(auditEntry);

        if (verdict === 'allow') {
          const dayKey = evaluatedAt.slice(0, 10);
          this.store.state.liquidity_policy_daily_usage[resolvedProvider.provider_id] ||= {};
          this.store.state.liquidity_policy_daily_usage[resolvedProvider.provider_id][dayKey] = projectedDailyValueUsd;
          this.store.state.liquidity_policy_counterparty_exposure[resolvedProvider.provider_id] ||= {};
          this.store.state.liquidity_policy_counterparty_exposure[resolvedProvider.provider_id][evaluation.counterparty_actor_id] = projectedCounterpartyExposureUsd;
        }

        return {
          ok: true,
          body: {
            correlation_id: corr,
            provider_id: resolvedProvider.provider_id,
            evaluation: {
              evaluation_id: evaluationId,
              audit_id: auditId,
              operation_id: evaluation.operation_id,
              verdict,
              reason_codes: clone(reasonCodes),
              enforced_precedence: PRECEDENCE,
              policy_ref: clone(policy.policy_ref),
              policy_version: policy.version,
              high_volatility_mode: policy.high_volatility_mode,
              effective_max_spread_bps: effectiveMaxSpreadBps,
              evaluated_at: evaluatedAt,
              input_summary: clone(inputSummary),
              constraints: {
                max_spread_bps: policy.max_spread_bps,
                max_daily_value_usd: policy.max_daily_value_usd,
                max_counterparty_exposure_usd: policy.max_counterparty_exposure_usd,
                min_price_confidence_bps: policy.min_price_confidence_bps,
                blocked_asset_liquidity_tiers: clone(policy.blocked_asset_liquidity_tiers)
              }
            }
          }
        };
      }
    });
  }

  listDecisionAudit({ actor, auth, providerId, query }) {
    const op = 'liquidityDecision.audit.list';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const partnerGuard = this._requirePartner({
      actor,
      operationId: op,
      correlationId: corr,
      reasonCode: 'liquidity_decision_audit_query_invalid'
    });
    if (partnerGuard) return partnerGuard;

    const resolvedProvider = this._resolveProviderForActor({
      actor,
      providerId,
      correlationId: corr,
      invalidReasonCode: 'liquidity_decision_audit_query_invalid'
    });
    if (!resolvedProvider.ok) return { ok: false, body: resolvedProvider.body };

    const allowedKeys = new Set([
      'from_iso',
      'to_iso',
      'limit',
      'cursor_after',
      'verdict',
      'counterparty_actor_id',
      'reason_code',
      'retention_days',
      'now_iso',
      'redact_counterparty'
    ]);

    for (const key of Object.keys(query ?? {})) {
      if (!allowedKeys.has(key)) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity decision audit query', {
            reason_code: 'liquidity_decision_audit_query_invalid',
            key
          })
        };
      }
    }

    const fromIso = normalizeOptionalString(query?.from_iso);
    const toIso = normalizeOptionalString(query?.to_iso);
    const fromMs = fromIso ? parseIsoMs(fromIso) : null;
    const toMs = toIso ? parseIsoMs(toIso) : null;
    const limit = parseLimit(query?.limit, 50);
    const cursorAfter = normalizeOptionalString(query?.cursor_after);
    const verdict = normalizeOptionalString(query?.verdict);
    const counterpartyActorId = normalizeOptionalString(query?.counterparty_actor_id);
    const reasonCode = normalizeOptionalString(query?.reason_code);
    const retentionDays = query?.retention_days === undefined || query?.retention_days === null || query?.retention_days === ''
      ? null
      : parsePositiveInt(query?.retention_days);
    const nowIso = normalizeOptionalString(query?.now_iso) ?? this._nowIso(auth);
    const nowMs = parseIsoMs(nowIso);
    const redactCounterparty = parseBooleanLike(query?.redact_counterparty, false);

    if ((fromIso && fromMs === null)
      || (toIso && toMs === null)
      || (fromMs !== null && toMs !== null && toMs <= fromMs)
      || limit === null
      || (verdict && !VERDICTS.has(verdict))
      || (retentionDays === null && query?.retention_days !== undefined && query?.retention_days !== null && query?.retention_days !== '')
      || (retentionDays !== null && nowMs === null)
      || redactCounterparty === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity decision audit query', {
          reason_code: 'liquidity_decision_audit_query_invalid'
        })
      };
    }

    const retentionCutoffMs = retentionDays === null ? null : (nowMs - retentionDays * DAY_MS);

    const entries = (this.store.state.liquidity_policy_decision_audit ?? [])
      .filter(entry => entry?.provider_id === resolvedProvider.provider_id)
      .filter(entry => {
        const evaluatedMs = parseIsoMs(entry?.evaluated_at);
        if (evaluatedMs === null) return false;
        if (fromMs !== null && evaluatedMs < fromMs) return false;
        if (toMs !== null && evaluatedMs >= toMs) return false;
        if (retentionCutoffMs !== null && evaluatedMs < retentionCutoffMs) return false;
        if (verdict && entry?.verdict !== verdict) return false;
        if (reasonCode && !Array.isArray(entry?.reason_codes)) return false;
        if (reasonCode && !entry.reason_codes.includes(reasonCode)) return false;
        if (counterpartyActorId && entry?.input_summary?.counterparty_actor_id !== counterpartyActorId) return false;
        return true;
      })
      .sort(auditSort);

    let startIndex = 0;
    if (cursorAfter) {
      const idx = entries.findIndex(entry => auditCursor(entry) === cursorAfter);
      if (idx < 0) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cursor_after was not found for liquidity decision audit listing', {
            reason_code: 'liquidity_decision_audit_query_invalid',
            cursor_after: cursorAfter
          })
        };
      }
      startIndex = idx + 1;
    }

    const page = entries.slice(startIndex, startIndex + limit).map(entry => normalizeAuditEntry(entry, { redactCounterparty }));
    const totalFiltered = entries.length;
    const hasNext = startIndex + limit < totalFiltered;
    const nextCursor = hasNext && page.length > 0 ? auditCursor(page[page.length - 1]) : null;

    return {
      ok: true,
      body: {
        correlation_id: corr,
        provider_id: resolvedProvider.provider_id,
        query: {
          from_iso: fromIso ?? undefined,
          to_iso: toIso ?? undefined,
          verdict: verdict ?? undefined,
          counterparty_actor_id: counterpartyActorId ?? undefined,
          reason_code: reasonCode ?? undefined,
          limit,
          cursor_after: cursorAfter ?? undefined,
          retention_days: retentionDays ?? undefined,
          now_iso: nowIso,
          redact_counterparty: redactCounterparty
        },
        total_filtered: totalFiltered,
        entries: page,
        next_cursor: nextCursor ?? undefined
      }
    };
  }

  exportDecisionAudit({ actor, auth, providerId, query }) {
    const op = 'liquidityDecision.audit.export';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const partnerGuard = this._requirePartner({
      actor,
      operationId: op,
      correlationId: corr,
      reasonCode: 'liquidity_decision_audit_query_invalid'
    });
    if (partnerGuard) return partnerGuard;

    const resolvedProvider = this._resolveProviderForActor({
      actor,
      providerId,
      correlationId: corr,
      invalidReasonCode: 'liquidity_decision_audit_query_invalid'
    });
    if (!resolvedProvider.ok) return { ok: false, body: resolvedProvider.body };

    const allowedKeys = new Set([
      'from_iso',
      'to_iso',
      'limit',
      'cursor_after',
      'attestation_after',
      'checkpoint_after',
      'verdict',
      'counterparty_actor_id',
      'reason_code',
      'retention_days',
      'redact_counterparty',
      'now_iso',
      'exported_at_iso'
    ]);

    for (const key of Object.keys(query ?? {})) {
      if (!allowedKeys.has(key)) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity decision audit export query', {
            reason_code: 'liquidity_decision_audit_query_invalid',
            key
          })
        };
      }
    }

    const fromIso = normalizeOptionalString(query?.from_iso);
    const toIso = normalizeOptionalString(query?.to_iso);
    const fromMs = fromIso ? parseIsoMs(fromIso) : null;
    const toMs = toIso ? parseIsoMs(toIso) : null;
    const limit = parseLimit(query?.limit, 50);
    const cursorAfter = normalizeOptionalString(query?.cursor_after);
    const attestationAfter = normalizeOptionalString(query?.attestation_after);
    const checkpointAfter = normalizeOptionalString(query?.checkpoint_after);
    const verdict = normalizeOptionalString(query?.verdict);
    const counterpartyActorId = normalizeOptionalString(query?.counterparty_actor_id);
    const reasonCode = normalizeOptionalString(query?.reason_code);
    const retentionDays = exportRetentionDays(query);
    const redactCounterparty = parseBooleanLike(query?.redact_counterparty, false);
    const nowIso = normalizeOptionalString(query?.now_iso) ?? this._nowIso(auth);
    const nowMs = parseIsoMs(nowIso);
    const exportedAt = normalizeOptionalString(query?.exported_at_iso) ?? nowIso;
    const exportedAtMs = parseIsoMs(exportedAt);

    if ((fromIso && fromMs === null)
      || (toIso && toMs === null)
      || (fromMs !== null && toMs !== null && toMs <= fromMs)
      || limit === null
      || (verdict && !VERDICTS.has(verdict))
      || redactCounterparty === null
      || nowMs === null
      || exportedAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity decision audit export query', {
          reason_code: 'liquidity_decision_audit_query_invalid'
        })
      };
    }

    const retentionCutoffMs = exportedAtMs - retentionDays * DAY_MS;

    const entries = (this.store.state.liquidity_policy_decision_audit ?? [])
      .filter(entry => entry?.provider_id === resolvedProvider.provider_id)
      .filter(entry => {
        const evaluatedMs = parseIsoMs(entry?.evaluated_at);
        if (evaluatedMs === null) return false;
        if (fromMs !== null && evaluatedMs < fromMs) return false;
        if (toMs !== null && evaluatedMs >= toMs) return false;
        if (evaluatedMs < retentionCutoffMs) return false;
        if (verdict && entry?.verdict !== verdict) return false;
        if (reasonCode && !Array.isArray(entry?.reason_codes)) return false;
        if (reasonCode && !entry.reason_codes.includes(reasonCode)) return false;
        if (counterpartyActorId && entry?.input_summary?.counterparty_actor_id !== counterpartyActorId) return false;
        return true;
      })
      .sort(auditSort);

    let startIndex = 0;
    if (cursorAfter) {
      const idx = entries.findIndex(entry => auditCursor(entry) === cursorAfter);
      if (idx < 0) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cursor_after was not found for liquidity decision audit export', {
            reason_code: 'liquidity_decision_audit_query_invalid',
            cursor_after: cursorAfter
          })
        };
      }

      if (!attestationAfter || !checkpointAfter) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'continuation requires attestation_after and checkpoint_after', {
            reason_code: 'liquidity_decision_audit_query_invalid',
            continuation_requires: ['attestation_after', 'checkpoint_after']
          })
        };
      }

      this.store.state.liquidity_policy_export_checkpoints[resolvedProvider.provider_id] ||= {};
      const checkpointState = this.store.state.liquidity_policy_export_checkpoints[resolvedProvider.provider_id][checkpointAfter] ?? null;
      if (!checkpointState) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'checkpoint_after was not found for liquidity decision audit export', {
            reason_code: 'liquidity_decision_audit_query_invalid',
            checkpoint_after: checkpointAfter
          })
        };
      }

      if (checkpointState.next_cursor !== cursorAfter || checkpointState.attestation_chain_hash !== attestationAfter) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'continuation anchors did not match checkpoint state', {
            reason_code: 'liquidity_decision_audit_query_invalid',
            cursor_after: cursorAfter,
            attestation_after: attestationAfter,
            checkpoint_after: checkpointAfter
          })
        };
      }

      const expectedContext = clone(checkpointState.query_context ?? {});
      const currentContext = queryContext({
        fromIso,
        toIso,
        verdict: verdict ?? null,
        counterpartyActorId: counterpartyActorId ?? null,
        reasonCode: reasonCode ?? null,
        limit,
        retentionDays,
        redactCounterparty
      });

      if (JSON.stringify(expectedContext) !== JSON.stringify(currentContext)) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'continuation query context mismatch', {
            reason_code: 'liquidity_decision_audit_query_invalid'
          })
        };
      }

      startIndex = idx + 1;
    }

    const page = entries.slice(startIndex, startIndex + limit).map(entry => normalizeAuditEntry(entry, { redactCounterparty }));
    const totalFiltered = entries.length;
    const hasNext = startIndex + limit < totalFiltered;
    const nextCursor = hasNext && page.length > 0 ? auditCursor(page[page.length - 1]) : null;

    const exportQuery = {
      from_iso: fromIso ?? undefined,
      to_iso: toIso ?? undefined,
      limit,
      cursor_after: cursorAfter ?? undefined,
      attestation_after: attestationAfter ?? undefined,
      checkpoint_after: checkpointAfter ?? undefined,
      now_iso: nowIso
    };

    const payload = buildSignedPolicyAuditExportPayload({
      exportedAt: new Date(exportedAtMs).toISOString(),
      query: exportQuery,
      entries: page,
      totalFiltered,
      nextCursor,
      withAttestation: true,
      withCheckpoint: true,
      keyId: 'dev-pi-k1'
    });

    this.store.state.liquidity_policy_export_checkpoints[resolvedProvider.provider_id] ||= {};
    const providerCheckpointState = this.store.state.liquidity_policy_export_checkpoints[resolvedProvider.provider_id];

    pruneExpiredCheckpoints({
      checkpointState: providerCheckpointState,
      nowMs,
      retentionDays
    });

    if (payload.checkpoint?.checkpoint_hash) {
      providerCheckpointState[payload.checkpoint.checkpoint_hash] = {
        next_cursor: payload.next_cursor ?? null,
        attestation_chain_hash: payload.attestation?.chain_hash ?? null,
        query_context: queryContext({
          fromIso,
          toIso,
          verdict: verdict ?? null,
          counterpartyActorId: counterpartyActorId ?? null,
          reasonCode: reasonCode ?? null,
          limit,
          retentionDays,
          redactCounterparty
        }),
        exported_at: payload.exported_at
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        provider_id: resolvedProvider.provider_id,
        export: payload
      }
    };
  }
}
