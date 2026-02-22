import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { buildSignedPolicyAuditExportPayload } from '../crypto/policyIntegritySigning.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';

const PRECEDENCE = 'safety>trust>commercial>preference';

const FEE_MODELS = new Set(['bps', 'flat_usd']);
const SUBSCRIPTION_TIERS = new Set(['free', 'pro', 'enterprise']);
const TRUST_MILESTONES = new Set(['none', 'verified_identity', 'established_history']);

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

function parseInteger(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : null;
}

function parseNonNegativeNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function stableId(prefix, value) {
  const digest = createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 16);
  return `${prefix}_${digest}`;
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

function ensureState(store) {
  store.state.idempotency ||= {};
  store.state.commercial_policies ||= {};
  store.state.commercial_policy_audit ||= [];
  store.state.commercial_policy_export_checkpoints ||= {};
}

function actorRef(actor) {
  return {
    type: actor?.type ?? 'unknown',
    id: actor?.id ?? 'unknown'
  };
}

function partnerPolicyState(store, partnerId) {
  store.state.commercial_policies ||= {};
  store.state.commercial_policies[partnerId] ||= {};
  return store.state.commercial_policies[partnerId];
}

function defaultTransactionFeePolicy({ partnerId, nowIso, actor }) {
  return {
    partner_id: partnerId,
    version: 1,
    fee_model: 'bps',
    fee_bps: 250,
    fee_flat_usd: null,
    min_fee_usd: 0,
    max_fee_usd: null,
    updated_at: nowIso,
    updated_by: actorRef(actor)
  };
}

function defaultSubscriptionTierPolicy({ partnerId, nowIso, actor }) {
  return {
    partner_id: partnerId,
    version: 1,
    tier: 'free',
    monthly_subscription_usd: 0,
    trust_milestone_required: 'verified_identity',
    max_cycle_notional_usd: 250,
    max_open_intents: 25,
    mobile_contract_notes: [
      'App Store constraints are represented as contract notes and require platform-specific validation.'
    ],
    updated_at: nowIso,
    updated_by: actorRef(actor)
  };
}

function defaultBoostPolicy({ partnerId, nowIso, actor }) {
  return {
    partner_id: partnerId,
    version: 1,
    enabled: false,
    max_multiplier: 1,
    allow_safety_bypass: false,
    allow_trust_bypass: false,
    allow_settlement_constraint_bypass: false,
    updated_at: nowIso,
    updated_by: actorRef(actor)
  };
}

function defaultQuotaPolicy({ partnerId, nowIso, actor }) {
  return {
    partner_id: partnerId,
    version: 1,
    monthly_quota_units: 100,
    overage_enabled: false,
    overage_unit_price_usd: 0,
    hard_stop_on_quota_exceeded: true,
    updated_at: nowIso,
    updated_by: actorRef(actor)
  };
}

function parseTransactionFeePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null;

  const feeModel = normalizeOptionalString(policy.fee_model);
  if (!feeModel || !FEE_MODELS.has(feeModel)) return null;

  const feeBps = parseInteger(policy.fee_bps);
  const feeFlatUsd = parseNonNegativeNumber(policy.fee_flat_usd);

  if (feeModel === 'bps') {
    if (feeBps === null || feeBps < 0 || feeBps > 10000) return null;
  }

  if (feeModel === 'flat_usd') {
    if (feeFlatUsd === null) return null;
  }

  const minFeeUsdRaw = policy.min_fee_usd === undefined ? 0 : parseNonNegativeNumber(policy.min_fee_usd);
  const maxFeeUsdRaw = policy.max_fee_usd === undefined || policy.max_fee_usd === null ? null : parseNonNegativeNumber(policy.max_fee_usd);

  if (minFeeUsdRaw === null) return null;
  if (maxFeeUsdRaw !== null && maxFeeUsdRaw < minFeeUsdRaw) return null;

  return {
    fee_model: feeModel,
    fee_bps: feeModel === 'bps' ? feeBps : null,
    fee_flat_usd: feeModel === 'flat_usd' ? feeFlatUsd : null,
    min_fee_usd: minFeeUsdRaw,
    max_fee_usd: maxFeeUsdRaw
  };
}

function parseSubscriptionTierPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null;

  const tier = normalizeOptionalString(policy.tier);
  const trustMilestoneRequired = normalizeOptionalString(policy.trust_milestone_required);
  const monthlySubscriptionUsd = parseNonNegativeNumber(policy.monthly_subscription_usd);
  const maxCycleNotionalUsd = parseNonNegativeNumber(policy.max_cycle_notional_usd);
  const maxOpenIntents = parseInteger(policy.max_open_intents);

  const mobileContractNotes = Array.isArray(policy.mobile_contract_notes)
    ? policy.mobile_contract_notes
      .filter(x => typeof x === 'string' && x.trim())
      .map(x => x.trim())
    : null;

  if (!tier || !SUBSCRIPTION_TIERS.has(tier)) return null;
  if (!trustMilestoneRequired || !TRUST_MILESTONES.has(trustMilestoneRequired)) return null;
  if (monthlySubscriptionUsd === null || maxCycleNotionalUsd === null) return null;
  if (!Number.isFinite(maxOpenIntents) || maxOpenIntents < 1 || maxOpenIntents > 1000000) return null;
  if (!mobileContractNotes || mobileContractNotes.length < 1) return null;

  return {
    tier,
    monthly_subscription_usd: monthlySubscriptionUsd,
    trust_milestone_required: trustMilestoneRequired,
    max_cycle_notional_usd: maxCycleNotionalUsd,
    max_open_intents: maxOpenIntents,
    mobile_contract_notes: mobileContractNotes
  };
}

function parseBoostPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null;

  if (typeof policy.enabled !== 'boolean') return null;
  if (typeof policy.allow_safety_bypass !== 'boolean') return null;
  if (typeof policy.allow_trust_bypass !== 'boolean') return null;
  if (typeof policy.allow_settlement_constraint_bypass !== 'boolean') return null;

  const maxMultiplier = Number(policy.max_multiplier);
  if (!Number.isFinite(maxMultiplier) || maxMultiplier < 1 || maxMultiplier > 5) return null;

  return {
    enabled: policy.enabled,
    max_multiplier: Math.round((maxMultiplier + Number.EPSILON) * 100) / 100,
    allow_safety_bypass: policy.allow_safety_bypass,
    allow_trust_bypass: policy.allow_trust_bypass,
    allow_settlement_constraint_bypass: policy.allow_settlement_constraint_bypass
  };
}

function parseQuotaPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null;

  const monthlyQuotaUnits = parseInteger(policy.monthly_quota_units);
  const overageUnitPriceUsd = parseNonNegativeNumber(policy.overage_unit_price_usd);

  if (!Number.isFinite(monthlyQuotaUnits) || monthlyQuotaUnits < 0 || monthlyQuotaUnits > 1000000000) return null;
  if (typeof policy.overage_enabled !== 'boolean') return null;
  if (overageUnitPriceUsd === null) return null;
  if (typeof policy.hard_stop_on_quota_exceeded !== 'boolean') return null;

  return {
    monthly_quota_units: monthlyQuotaUnits,
    overage_enabled: policy.overage_enabled,
    overage_unit_price_usd: overageUnitPriceUsd,
    hard_stop_on_quota_exceeded: policy.hard_stop_on_quota_exceeded
  };
}

function auditCursor(entry) {
  return `${entry.updated_at}|${entry.audit_id}`;
}

function queryContext(query) {
  return {
    from_iso: normalizeOptionalString(query?.from_iso) ?? null,
    to_iso: normalizeOptionalString(query?.to_iso) ?? null,
    limit: parseLimit(query?.limit, 50)
  };
}

function normalizeAuditEntry(entry) {
  return {
    audit_id: entry.audit_id,
    partner_id: entry.partner_id,
    policy_type: entry.policy_type,
    operation_id: entry.operation_id,
    version: entry.version,
    updated_at: entry.updated_at,
    actor: clone(entry.actor),
    summary: clone(entry.summary ?? {})
  };
}

export class CommercialPolicyService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureState(this.store);
  }

  _nowIso(auth) {
    return normalizeOptionalString(auth?.now_iso) ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
  }

  _authorize({ operationId, actor, auth, corr }) {
    const authz = authorizeApiOperation({ operationId, actor, auth, store: this.store });
    if (!authz.ok) {
      return {
        ok: false,
        response: {
          ok: false,
          body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details)
        }
      };
    }

    return { ok: true };
  }

  _requirePartner({ actor, corr, operationId }) {
    if (actor?.type === 'partner' && normalizeOptionalString(actor?.id)) return null;
    return {
      ok: false,
      body: errorResponse(corr, 'FORBIDDEN', 'only partner actors are allowed for commercial policy operations', {
        operation_id: operationId,
        actor: actor ?? null
      })
    };
  }

  _withIdempotency({ actor, operationId, idempotencyKey, requestBody, correlationId: corr, handler }) {
    const scopeKey = idempotencyScopeKey({ actor, operationId, idempotencyKey });
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

  _resolvePolicies({ actor, auth }) {
    const nowIso = this._nowIso(auth);
    const partnerId = actor.id;
    const partnerPolicies = partnerPolicyState(this.store, partnerId);

    return {
      transaction_fee: clone(partnerPolicies.transaction_fee ?? defaultTransactionFeePolicy({ partnerId, nowIso, actor })),
      subscription_tier: clone(partnerPolicies.subscription_tier ?? defaultSubscriptionTierPolicy({ partnerId, nowIso, actor })),
      boost: clone(partnerPolicies.boost ?? defaultBoostPolicy({ partnerId, nowIso, actor })),
      quota: clone(partnerPolicies.quota ?? defaultQuotaPolicy({ partnerId, nowIso, actor }))
    };
  }

  _appendAudit({ actor, operationId, policyType, version, updatedAt, summary }) {
    const audit = {
      audit_id: stableId('cmpol', `${actor.id}|${policyType}|${version}|${updatedAt}`),
      partner_id: actor.id,
      policy_type: policyType,
      operation_id: operationId,
      version,
      updated_at: updatedAt,
      actor: actorRef(actor),
      summary: clone(summary)
    };

    this.store.state.commercial_policy_audit.push(audit);
    return audit;
  }

  getTransactionFeePolicy({ actor, auth }) {
    const op = 'commercialPolicy.transaction_fee.get';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, corr });
    if (!authz.ok) return authz.response;

    const partnerGuard = this._requirePartner({ actor, corr, operationId: op });
    if (partnerGuard) return partnerGuard;

    const policies = this._resolvePolicies({ actor, auth });

    return {
      ok: true,
      body: {
        correlation_id: corr,
        policy: policies.transaction_fee
      }
    };
  }

  upsertTransactionFeePolicy({ actor, auth, idempotencyKey, request }) {
    const op = 'commercialPolicy.transaction_fee.upsert';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, corr });
    if (!authz.ok) return { replayed: false, result: authz.response };

    const partnerGuard = this._requirePartner({ actor, corr, operationId: op });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const parsed = parseTransactionFeePolicy(request?.policy);
        if (!parsed) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid commercial policy payload', {
              reason_code: 'commercial_policy_invalid',
              policy_type: 'transaction_fee'
            })
          };
        }

        const recordedAtRaw = normalizeOptionalString(request?.recorded_at) ?? this._nowIso(auth);
        const recordedMs = parseIsoMs(recordedAtRaw);
        if (recordedMs === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid commercial policy timestamp', {
              reason_code: 'commercial_policy_invalid_timestamp',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const updatedAt = new Date(recordedMs).toISOString();
        const state = partnerPolicyState(this.store, actor.id);
        const prior = state.transaction_fee ?? null;
        const version = (Number(prior?.version) || 0) + 1;

        const policy = {
          partner_id: actor.id,
          version,
          ...parsed,
          updated_at: updatedAt,
          updated_by: actorRef(actor)
        };

        state.transaction_fee = policy;
        this._appendAudit({
          actor,
          operationId: op,
          policyType: 'transaction_fee',
          version,
          updatedAt,
          summary: {
            fee_model: policy.fee_model,
            fee_bps: policy.fee_bps,
            fee_flat_usd: policy.fee_flat_usd
          }
        });

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

  getSubscriptionTierPolicy({ actor, auth }) {
    const op = 'commercialPolicy.subscription_tier.get';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, corr });
    if (!authz.ok) return authz.response;

    const partnerGuard = this._requirePartner({ actor, corr, operationId: op });
    if (partnerGuard) return partnerGuard;

    const policies = this._resolvePolicies({ actor, auth });

    return {
      ok: true,
      body: {
        correlation_id: corr,
        policy: policies.subscription_tier
      }
    };
  }

  upsertSubscriptionTierPolicy({ actor, auth, idempotencyKey, request }) {
    const op = 'commercialPolicy.subscription_tier.upsert';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, corr });
    if (!authz.ok) return { replayed: false, result: authz.response };

    const partnerGuard = this._requirePartner({ actor, corr, operationId: op });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const parsed = parseSubscriptionTierPolicy(request?.policy);
        if (!parsed) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid commercial policy payload', {
              reason_code: 'commercial_policy_invalid',
              policy_type: 'subscription_tier'
            })
          };
        }

        if (parsed.tier !== 'free' && parsed.trust_milestone_required === 'none') {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'subscription tier policy violates precedence safeguards', {
              reason_code: 'commercial_policy_precedence_violation',
              required_precedence: PRECEDENCE
            })
          };
        }

        const recordedAtRaw = normalizeOptionalString(request?.recorded_at) ?? this._nowIso(auth);
        const recordedMs = parseIsoMs(recordedAtRaw);
        if (recordedMs === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid commercial policy timestamp', {
              reason_code: 'commercial_policy_invalid_timestamp',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const updatedAt = new Date(recordedMs).toISOString();
        const state = partnerPolicyState(this.store, actor.id);
        const prior = state.subscription_tier ?? null;
        const version = (Number(prior?.version) || 0) + 1;

        const policy = {
          partner_id: actor.id,
          version,
          ...parsed,
          updated_at: updatedAt,
          updated_by: actorRef(actor)
        };

        state.subscription_tier = policy;
        this._appendAudit({
          actor,
          operationId: op,
          policyType: 'subscription_tier',
          version,
          updatedAt,
          summary: {
            tier: policy.tier,
            trust_milestone_required: policy.trust_milestone_required,
            max_cycle_notional_usd: policy.max_cycle_notional_usd,
            max_open_intents: policy.max_open_intents
          }
        });

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

  getBoostPolicy({ actor, auth }) {
    const op = 'commercialPolicy.boost_policy.get';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, corr });
    if (!authz.ok) return authz.response;

    const partnerGuard = this._requirePartner({ actor, corr, operationId: op });
    if (partnerGuard) return partnerGuard;

    const policies = this._resolvePolicies({ actor, auth });

    return {
      ok: true,
      body: {
        correlation_id: corr,
        policy: policies.boost
      }
    };
  }

  upsertBoostPolicy({ actor, auth, idempotencyKey, request }) {
    const op = 'commercialPolicy.boost_policy.upsert';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, corr });
    if (!authz.ok) return { replayed: false, result: authz.response };

    const partnerGuard = this._requirePartner({ actor, corr, operationId: op });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const parsed = parseBoostPolicy(request?.policy);
        if (!parsed) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid commercial policy payload', {
              reason_code: 'commercial_policy_invalid',
              policy_type: 'boost'
            })
          };
        }

        if (parsed.allow_safety_bypass === true) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'boost policy cannot bypass safety gates', {
              reason_code: 'commercial_policy_safety_bypass_denied'
            })
          };
        }

        if (parsed.allow_trust_bypass === true) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'boost policy cannot bypass trust gates', {
              reason_code: 'commercial_policy_trust_gate_denied'
            })
          };
        }

        if (parsed.allow_settlement_constraint_bypass === true) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'boost policy cannot bypass settlement constraints', {
              reason_code: 'commercial_policy_boost_guardrail_denied'
            })
          };
        }

        const recordedAtRaw = normalizeOptionalString(request?.recorded_at) ?? this._nowIso(auth);
        const recordedMs = parseIsoMs(recordedAtRaw);
        if (recordedMs === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid commercial policy timestamp', {
              reason_code: 'commercial_policy_invalid_timestamp',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const updatedAt = new Date(recordedMs).toISOString();
        const state = partnerPolicyState(this.store, actor.id);
        const prior = state.boost ?? null;
        const version = (Number(prior?.version) || 0) + 1;

        const policy = {
          partner_id: actor.id,
          version,
          ...parsed,
          updated_at: updatedAt,
          updated_by: actorRef(actor)
        };

        state.boost = policy;
        this._appendAudit({
          actor,
          operationId: op,
          policyType: 'boost',
          version,
          updatedAt,
          summary: {
            enabled: policy.enabled,
            max_multiplier: policy.max_multiplier
          }
        });

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

  getQuotaPolicy({ actor, auth }) {
    const op = 'commercialPolicy.quota_policy.get';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, corr });
    if (!authz.ok) return authz.response;

    const partnerGuard = this._requirePartner({ actor, corr, operationId: op });
    if (partnerGuard) return partnerGuard;

    const policies = this._resolvePolicies({ actor, auth });

    return {
      ok: true,
      body: {
        correlation_id: corr,
        policy: policies.quota
      }
    };
  }

  upsertQuotaPolicy({ actor, auth, idempotencyKey, request }) {
    const op = 'commercialPolicy.quota_policy.upsert';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, corr });
    if (!authz.ok) return { replayed: false, result: authz.response };

    const partnerGuard = this._requirePartner({ actor, corr, operationId: op });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const parsed = parseQuotaPolicy(request?.policy);
        if (!parsed) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid commercial policy payload', {
              reason_code: 'commercial_policy_invalid',
              policy_type: 'quota'
            })
          };
        }

        const recordedAtRaw = normalizeOptionalString(request?.recorded_at) ?? this._nowIso(auth);
        const recordedMs = parseIsoMs(recordedAtRaw);
        if (recordedMs === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid commercial policy timestamp', {
              reason_code: 'commercial_policy_invalid_timestamp',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const updatedAt = new Date(recordedMs).toISOString();
        const state = partnerPolicyState(this.store, actor.id);
        const prior = state.quota ?? null;
        const version = (Number(prior?.version) || 0) + 1;

        const policy = {
          partner_id: actor.id,
          version,
          ...parsed,
          updated_at: updatedAt,
          updated_by: actorRef(actor)
        };

        state.quota = policy;
        this._appendAudit({
          actor,
          operationId: op,
          policyType: 'quota',
          version,
          updatedAt,
          summary: {
            monthly_quota_units: policy.monthly_quota_units,
            overage_enabled: policy.overage_enabled,
            hard_stop_on_quota_exceeded: policy.hard_stop_on_quota_exceeded
          }
        });

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

  evaluatePolicy({ actor, auth, idempotencyKey, request }) {
    const op = 'commercialPolicy.evaluate';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, corr });
    if (!authz.ok) return { replayed: false, result: authz.response };

    const partnerGuard = this._requirePartner({ actor, corr, operationId: op });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const evaluation = request?.evaluation;
        if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid commercial policy evaluation payload', {
              reason_code: 'commercial_policy_invalid'
            })
          };
        }

        const operationId = normalizeOptionalString(evaluation.operation_id);
        const precedenceAssertion = normalizeOptionalString(evaluation.precedence_assertion);
        const safetyGatePassed = evaluation.safety_gate_passed;
        const trustGatePassed = evaluation.trust_gate_passed;
        const settlementGuardrailPassed = evaluation.settlement_guardrail_passed;
        const requestedBoostMultiplier = Number(evaluation.requested_boost_multiplier);
        const currentQuotaUsageUnits = parseInteger(evaluation.current_quota_usage_units);
        const requestedQuotaUnits = parseInteger(evaluation.requested_quota_units);

        if (!operationId
          || !precedenceAssertion
          || typeof safetyGatePassed !== 'boolean'
          || typeof trustGatePassed !== 'boolean'
          || typeof settlementGuardrailPassed !== 'boolean'
          || !Number.isFinite(requestedBoostMultiplier)
          || requestedBoostMultiplier < 1
          || !Number.isFinite(currentQuotaUsageUnits)
          || currentQuotaUsageUnits < 0
          || !Number.isFinite(requestedQuotaUnits)
          || requestedQuotaUnits < 0) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid commercial policy evaluation payload', {
              reason_code: 'commercial_policy_invalid'
            })
          };
        }

        const recordedAtRaw = normalizeOptionalString(request?.recorded_at) ?? this._nowIso(auth);
        const recordedMs = parseIsoMs(recordedAtRaw);
        if (recordedMs === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid commercial policy timestamp', {
              reason_code: 'commercial_policy_invalid_timestamp',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        if (precedenceAssertion !== PRECEDENCE) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'policy precedence assertion failed', {
              reason_code: 'commercial_policy_precedence_violation',
              expected: PRECEDENCE,
              received: precedenceAssertion
            })
          };
        }

        if (!safetyGatePassed) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'commercial policy cannot bypass safety gates', {
              reason_code: 'commercial_policy_safety_bypass_denied'
            })
          };
        }

        if (!trustGatePassed) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'commercial policy blocked by trust gate', {
              reason_code: 'commercial_policy_trust_gate_denied'
            })
          };
        }

        const policies = this._resolvePolicies({ actor, auth });

        if (!settlementGuardrailPassed || requestedBoostMultiplier > Number(policies.boost.max_multiplier ?? 1)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'boost request violates guardrails', {
              reason_code: 'commercial_policy_boost_guardrail_denied',
              requested_boost_multiplier: requestedBoostMultiplier,
              max_multiplier: policies.boost.max_multiplier
            })
          };
        }

        const projectedQuotaUsageUnits = currentQuotaUsageUnits + requestedQuotaUnits;
        const quotaLimit = Number(policies.quota.monthly_quota_units ?? 0);

        if (policies.quota.hard_stop_on_quota_exceeded === true && projectedQuotaUsageUnits > quotaLimit) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'quota exceeded under hard stop policy', {
              reason_code: 'commercial_policy_quota_exceeded',
              quota_limit_units: quotaLimit,
              projected_quota_usage_units: projectedQuotaUsageUnits
            })
          };
        }

        const evaluatedAt = new Date(recordedMs).toISOString();
        const evaluationId = stableId('cmpeval', `${actor.id}|${operationId}|${evaluatedAt}`);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            evaluation: {
              evaluation_id: evaluationId,
              operation_id: operationId,
              enforced_precedence: PRECEDENCE,
              verdict: 'allow',
              evaluated_at: evaluatedAt,
              projected_quota_usage_units: projectedQuotaUsageUnits,
              quota_remaining_units: Math.max(0, quotaLimit - projectedQuotaUsageUnits),
              effective: {
                transaction_fee: {
                  fee_model: policies.transaction_fee.fee_model,
                  fee_bps: policies.transaction_fee.fee_bps,
                  fee_flat_usd: policies.transaction_fee.fee_flat_usd,
                  min_fee_usd: policies.transaction_fee.min_fee_usd,
                  max_fee_usd: policies.transaction_fee.max_fee_usd
                },
                subscription_tier: {
                  tier: policies.subscription_tier.tier,
                  trust_milestone_required: policies.subscription_tier.trust_milestone_required,
                  max_cycle_notional_usd: policies.subscription_tier.max_cycle_notional_usd,
                  max_open_intents: policies.subscription_tier.max_open_intents,
                  mobile_contract_notes: clone(policies.subscription_tier.mobile_contract_notes)
                },
                boost: {
                  enabled: policies.boost.enabled,
                  max_multiplier: policies.boost.max_multiplier
                },
                quota: {
                  monthly_quota_units: policies.quota.monthly_quota_units,
                  overage_enabled: policies.quota.overage_enabled,
                  overage_unit_price_usd: policies.quota.overage_unit_price_usd,
                  hard_stop_on_quota_exceeded: policies.quota.hard_stop_on_quota_exceeded
                }
              }
            }
          }
        };
      }
    });
  }

  exportPolicies({ actor, auth, query }) {
    const op = 'commercialPolicy.export';
    const corr = correlationId(op);

    const authz = this._authorize({ operationId: op, actor, auth, corr });
    if (!authz.ok) return authz.response;

    const partnerGuard = this._requirePartner({ actor, corr, operationId: op });
    if (partnerGuard) return partnerGuard;

    const allowedKeys = new Set(['from_iso', 'to_iso', 'limit', 'cursor_after', 'attestation_after', 'checkpoint_after', 'now_iso', 'exported_at_iso']);
    for (const key of Object.keys(query ?? {})) {
      if (!allowedKeys.has(key)) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid commercial policy export query', {
            reason_code: 'commercial_policy_export_query_invalid',
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
    const nowIso = normalizeOptionalString(query?.now_iso) ?? this._nowIso(auth);
    const exportedAt = normalizeOptionalString(query?.exported_at_iso) ?? nowIso;
    const exportedAtMs = parseIsoMs(exportedAt);

    if ((fromIso && fromMs === null)
      || (toIso && toMs === null)
      || (fromMs !== null && toMs !== null && toMs <= fromMs)
      || limit === null
      || exportedAtMs === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid commercial policy export query', {
          reason_code: 'commercial_policy_export_query_invalid'
        })
      };
    }

    const auditEntries = (this.store.state.commercial_policy_audit ?? [])
      .filter(row => row?.partner_id === actor.id)
      .filter(row => {
        const updatedMs = parseIsoMs(row?.updated_at);
        if (updatedMs === null) return false;
        if (fromMs !== null && updatedMs < fromMs) return false;
        if (toMs !== null && updatedMs >= toMs) return false;
        return true;
      })
      .map(normalizeAuditEntry)
      .sort((a, b) => {
        const aMs = parseIsoMs(a.updated_at) ?? 0;
        const bMs = parseIsoMs(b.updated_at) ?? 0;
        if (aMs !== bMs) return aMs - bMs;
        return String(a.audit_id).localeCompare(String(b.audit_id));
      });

    let startIndex = 0;

    if (cursorAfter) {
      const idx = auditEntries.findIndex(entry => auditCursor(entry) === cursorAfter);
      if (idx < 0) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'cursor_after was not found for commercial policy export', {
            reason_code: 'commercial_policy_export_cursor_not_found',
            cursor_after: cursorAfter
          })
        };
      }

      if (!attestationAfter || !checkpointAfter) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'continuation requires attestation_after and checkpoint_after', {
            reason_code: 'commercial_policy_export_query_invalid',
            continuation_requires: ['attestation_after', 'checkpoint_after']
          })
        };
      }

      this.store.state.commercial_policy_export_checkpoints ||= {};
      this.store.state.commercial_policy_export_checkpoints[actor.id] ||= {};

      const checkpointState = this.store.state.commercial_policy_export_checkpoints[actor.id][checkpointAfter] ?? null;
      if (!checkpointState) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'checkpoint_after was not found for commercial policy export', {
            reason_code: 'commercial_policy_export_query_invalid',
            checkpoint_after: checkpointAfter
          })
        };
      }

      if (checkpointState.next_cursor !== cursorAfter || checkpointState.attestation_chain_hash !== attestationAfter) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'continuation anchors did not match checkpoint state', {
            reason_code: 'commercial_policy_export_query_invalid',
            cursor_after: cursorAfter,
            attestation_after: attestationAfter,
            checkpoint_after: checkpointAfter
          })
        };
      }

      const expectedContext = clone(checkpointState.query_context ?? {});
      const currentContext = queryContext(query);
      if (JSON.stringify(expectedContext) !== JSON.stringify(currentContext)) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'continuation query context mismatch', {
            reason_code: 'commercial_policy_export_query_invalid'
          })
        };
      }

      startIndex = idx + 1;
    }

    const page = auditEntries.slice(startIndex, startIndex + limit);
    const totalFiltered = auditEntries.length;
    const hasNext = startIndex + limit < totalFiltered;
    const nextCursor = hasNext && page.length > 0 ? auditCursor(page[page.length - 1]) : null;

    const exportQuery = {
      from_iso: fromIso ?? undefined,
      to_iso: toIso ?? undefined,
      now_iso: nowIso,
      limit,
      cursor_after: cursorAfter ?? undefined,
      attestation_after: attestationAfter ?? undefined,
      checkpoint_after: checkpointAfter ?? undefined,
      exported_at_iso: exportedAt
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

    this.store.state.commercial_policy_export_checkpoints ||= {};
    this.store.state.commercial_policy_export_checkpoints[actor.id] ||= {};

    if (payload.checkpoint?.checkpoint_hash) {
      this.store.state.commercial_policy_export_checkpoints[actor.id][payload.checkpoint.checkpoint_hash] = {
        next_cursor: payload.next_cursor ?? null,
        attestation_chain_hash: payload.attestation?.chain_hash ?? null,
        query_context: queryContext(query)
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        ...payload
      }
    };
  }
}
