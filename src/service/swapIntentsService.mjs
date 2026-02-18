import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { authorizeApiOperation } from '../core/authz.mjs';
import {
  actorKey,
  effectiveActorForDelegation,
  policyForDelegatedActor,
  evaluateIntentAgainstTradingPolicy,
  evaluateHighValueConsentForIntent,
  evaluateDailySpendCapForIntent,
  resolvePolicyNowIso,
  dayKeyFromIsoUtc,
  dailySpendDeltaForIntentMutation
} from '../core/tradingPolicyBoundaries.mjs';

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

function correlationIdForIntentId(intentId) {
  return `corr_${intentId}`;
}

function correlationIdForIntentsList(actor) {
  const t = actor?.type ?? 'unknown';
  const id = actor?.id ?? 'unknown';
  return `corr_swap_intents_list_${t}_${id}`;
}

function policySnapshot(policy) {
  if (!policy) return null;
  return {
    max_value_per_swap_usd: policy.max_value_per_swap_usd ?? null,
    max_value_per_day_usd: policy.max_value_per_day_usd ?? null,
    high_value_consent_threshold_usd: policy.high_value_consent_threshold_usd ?? null,
    min_confidence_score: policy.min_confidence_score ?? null,
    max_cycle_length: policy.max_cycle_length ?? null,
    require_escrow: policy.require_escrow ?? null,
    quiet_hours: policy.quiet_hours ?? null
  };
}

function reasonCodeFromPolicyCheck(check, fallback) {
  return check?.details?.reason_code ?? fallback;
}

function ensurePolicyState(store) {
  store.state.policy_spend_daily ||= {};
  store.state.policy_audit ||= [];
}

function getDailySpend(store, subjectActor, dayKey) {
  const subject = actorKey(subjectActor);
  return Number(store.state.policy_spend_daily?.[subject]?.[dayKey] ?? 0);
}

function setDailySpend(store, subjectActor, dayKey, value) {
  const subject = actorKey(subjectActor);
  store.state.policy_spend_daily ||= {};
  store.state.policy_spend_daily[subject] ||= {};
  store.state.policy_spend_daily[subject][dayKey] = Math.max(0, Number(value));
}

function appendPolicyAudit(store, {
  occurredAt,
  operationId,
  decision,
  reasonCode,
  actor,
  subjectActor,
  intentId,
  delegationId,
  policy,
  details
}) {
  ensurePolicyState(store);

  const idx = (store.state.policy_audit?.length ?? 0) + 1;
  const audit = {
    audit_id: `pa_${idx}`,
    occurred_at: occurredAt,
    operation_id: operationId,
    decision,
    reason_code: reasonCode,
    actor,
    subject_actor: subjectActor,
    intent_id: intentId,
    delegation_id: delegationId ?? null,
    policy: policySnapshot(policy),
    details: details ?? {}
  };

  store.state.policy_audit.push(audit);
}

export class SwapIntentsService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensurePolicyState(this.store);
  }

  /**
   * @param {{ actor: any, operationId: string, idempotencyKey: string, requestBody: any, correlationId: string, handler: () => any }} params
   */
  _withIdempotency({ actor, operationId, idempotencyKey, requestBody, correlationId, handler }) {
    const scopeKey = idempotencyScopeKey({ actor, operationId, idempotencyKey });
    const h = payloadHash(requestBody);

    const existing = this.store.state.idempotency[scopeKey];
    if (existing) {
      if (existing.payload_hash === h) {
        return { replayed: true, result: existing.result };
      }
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(
            correlationId,
            'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH',
            'Idempotency key reused with a different payload',
            { scope_key: scopeKey, original_hash: existing.payload_hash, new_hash: h }
          )
        }
      };
    }

    const result = handler();
    const snapshot = JSON.parse(JSON.stringify(result));
    this.store.state.idempotency[scopeKey] = { payload_hash: h, result: snapshot };
    return { replayed: false, result: snapshot };
  }

  create({ actor, auth, idempotencyKey, requestBody }) {
    const correlationId = correlationIdForIntentId(requestBody?.intent?.id ?? 'unknown');

    const authz = authorizeApiOperation({ operationId: 'swapIntents.create', actor, auth, store: this.store });
    if (!authz.ok) {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details)
        }
      };
    }

    const subjectActor = effectiveActorForDelegation({ actor, auth }) ?? actor;
    if (actor?.type === 'agent' && !subjectActor) {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(correlationId, 'FORBIDDEN', 'agent access requires delegation subject', { actor })
        }
      };
    }

    const intent = requestBody?.intent;
    if (actor?.type === 'agent') {
      if (actorKey(intent?.actor) !== actorKey(subjectActor)) {
        return {
          replayed: false,
          result: {
            ok: false,
            body: errorResponse(correlationId, 'FORBIDDEN', 'agent cannot act for this actor', {
              actor,
              subject_actor: subjectActor,
              intent_actor: intent?.actor ?? null
            })
          }
        };
      }
    }

    return this._withIdempotency({
      actor,
      operationId: 'swapIntents.create',
      idempotencyKey,
      requestBody,
      correlationId,
      handler: () => {
        const previousIntent = this.store.state.intents[intent.id] ?? null;
        const nextIntent = { ...intent, status: intent.status ?? 'active' };

        let dayKey = null;
        let dailyCheck = { ok: true, enforced: false, skipped: true, details: {} };
        let consentCheck = { ok: true, required: false, skipped: true, details: {} };
        let policy = null;
        let nowIso = null;

        if (actor?.type === 'agent') {
          policy = policyForDelegatedActor({ actor, auth });
          nowIso = resolvePolicyNowIso({ auth });

          const intentPolicy = evaluateIntentAgainstTradingPolicy({ policy, intent: nextIntent });
          if (!intentPolicy.ok) {
            appendPolicyAudit(this.store, {
              occurredAt: nowIso,
              operationId: 'swapIntents.create',
              decision: 'deny',
              reasonCode: reasonCodeFromPolicyCheck(intentPolicy, 'policy_violation'),
              actor,
              subjectActor,
              intentId: intent?.id ?? null,
              delegationId: auth?.delegation?.delegation_id,
              policy,
              details: intentPolicy.details
            });
            return { ok: false, body: errorResponse(correlationId, intentPolicy.code, intentPolicy.message, intentPolicy.details) };
          }

          consentCheck = evaluateHighValueConsentForIntent({
            policy,
            intent: nextIntent,
            auth,
            nowIso,
            subjectActor,
            delegationId: auth?.delegation?.delegation_id
          });
          if (!consentCheck.ok) {
            appendPolicyAudit(this.store, {
              occurredAt: nowIso,
              operationId: 'swapIntents.create',
              decision: 'deny',
              reasonCode: reasonCodeFromPolicyCheck(consentCheck, 'consent_required'),
              actor,
              subjectActor,
              intentId: intent?.id ?? null,
              delegationId: auth?.delegation?.delegation_id,
              policy,
              details: consentCheck.details
            });
            return { ok: false, body: errorResponse(correlationId, consentCheck.code, consentCheck.message, consentCheck.details) };
          }

          dailyCheck = evaluateDailySpendCapForIntent({
            policy,
            subjectActor,
            nowIso,
            spendByActorDay: this.store.state.policy_spend_daily,
            existingIntent: previousIntent,
            nextIntent
          });

          if (!dailyCheck.ok) {
            appendPolicyAudit(this.store, {
              occurredAt: nowIso,
              operationId: 'swapIntents.create',
              decision: 'deny',
              reasonCode: reasonCodeFromPolicyCheck(dailyCheck, 'daily_cap_exceeded'),
              actor,
              subjectActor,
              intentId: intent?.id ?? null,
              delegationId: auth?.delegation?.delegation_id,
              policy,
              details: dailyCheck.details
            });
            return { ok: false, body: errorResponse(correlationId, dailyCheck.code, dailyCheck.message, dailyCheck.details) };
          }

          dayKey = dailyCheck.details?.day_key ?? dayKeyFromIsoUtc(nowIso);
        }

        this.store.state.intents[intent.id] = nextIntent;

        if (actor?.type === 'agent') {
          const deltaUsd = dailySpendDeltaForIntentMutation({ previousIntent, nextIntent });
          if (dailyCheck.enforced && dayKey) {
            const used = getDailySpend(this.store, subjectActor, dayKey);
            setDailySpend(this.store, subjectActor, dayKey, used + deltaUsd);
          }

          appendPolicyAudit(this.store, {
            occurredAt: nowIso,
            operationId: 'swapIntents.create',
            decision: 'allow',
            reasonCode: 'ok',
            actor,
            subjectActor,
            intentId: intent?.id ?? null,
            delegationId: auth?.delegation?.delegation_id,
            policy,
            details: {
              day_key: dayKey,
              delta_usd: deltaUsd,
              projected_usd: dailyCheck.details?.projected_usd ?? null,
              cap_usd: dailyCheck.details?.cap_usd ?? null,
              consent_required: !!consentCheck.required,
              consent_id: consentCheck.details?.consent_id ?? null
            }
          });
        }

        return { ok: true, body: { correlation_id: correlationIdForIntentId(nextIntent.id), intent: nextIntent } };
      }
    });
  }

  update({ actor, auth, id, idempotencyKey, requestBody }) {
    const correlationId = correlationIdForIntentId(id);

    const authz = authorizeApiOperation({ operationId: 'swapIntents.update', actor, auth, store: this.store });
    if (!authz.ok) {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details)
        }
      };
    }

    const subjectActor = effectiveActorForDelegation({ actor, auth }) ?? actor;
    if (actor?.type === 'agent' && !subjectActor) {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(correlationId, 'FORBIDDEN', 'agent access requires delegation subject', { actor })
        }
      };
    }

    const intent = requestBody?.intent;
    if (actor?.type === 'agent') {
      if (actorKey(intent?.actor) !== actorKey(subjectActor)) {
        return {
          replayed: false,
          result: {
            ok: false,
            body: errorResponse(correlationId, 'FORBIDDEN', 'agent cannot act for this actor', {
              actor,
              subject_actor: subjectActor,
              intent_actor: intent?.actor ?? null
            })
          }
        };
      }

      const existing = this.store.state.intents[id];
      if (existing && actorKey(existing.actor) !== actorKey(subjectActor)) {
        return {
          replayed: false,
          result: {
            ok: false,
            body: errorResponse(correlationId, 'FORBIDDEN', 'agent cannot modify this intent', {
              actor,
              subject_actor: subjectActor,
              intent_actor: existing.actor
            })
          }
        };
      }
    }

    return this._withIdempotency({
      actor,
      operationId: 'swapIntents.update',
      idempotencyKey,
      requestBody,
      correlationId,
      handler: () => {
        if (intent.id !== id) {
          return { ok: false, body: errorResponse(correlationIdForIntentId(id), 'CONSTRAINT_VIOLATION', 'intent.id must match path id', { id, intent_id: intent.id }) };
        }

        const prev = this.store.state.intents[id] ?? null;
        const status = prev?.status ?? intent.status ?? 'active';
        const nextIntent = { ...intent, status };

        let dayKey = null;
        let dailyCheck = { ok: true, enforced: false, skipped: true, details: {} };
        let consentCheck = { ok: true, required: false, skipped: true, details: {} };
        let policy = null;
        let nowIso = null;

        if (actor?.type === 'agent') {
          policy = policyForDelegatedActor({ actor, auth });
          nowIso = resolvePolicyNowIso({ auth });

          const intentPolicy = evaluateIntentAgainstTradingPolicy({ policy, intent: nextIntent });
          if (!intentPolicy.ok) {
            appendPolicyAudit(this.store, {
              occurredAt: nowIso,
              operationId: 'swapIntents.update',
              decision: 'deny',
              reasonCode: reasonCodeFromPolicyCheck(intentPolicy, 'policy_violation'),
              actor,
              subjectActor,
              intentId: id,
              delegationId: auth?.delegation?.delegation_id,
              policy,
              details: intentPolicy.details
            });
            return { ok: false, body: errorResponse(correlationId, intentPolicy.code, intentPolicy.message, intentPolicy.details) };
          }

          consentCheck = evaluateHighValueConsentForIntent({
            policy,
            intent: nextIntent,
            auth,
            nowIso,
            subjectActor,
            delegationId: auth?.delegation?.delegation_id
          });
          if (!consentCheck.ok) {
            appendPolicyAudit(this.store, {
              occurredAt: nowIso,
              operationId: 'swapIntents.update',
              decision: 'deny',
              reasonCode: reasonCodeFromPolicyCheck(consentCheck, 'consent_required'),
              actor,
              subjectActor,
              intentId: id,
              delegationId: auth?.delegation?.delegation_id,
              policy,
              details: consentCheck.details
            });
            return { ok: false, body: errorResponse(correlationId, consentCheck.code, consentCheck.message, consentCheck.details) };
          }

          dailyCheck = evaluateDailySpendCapForIntent({
            policy,
            subjectActor,
            nowIso,
            spendByActorDay: this.store.state.policy_spend_daily,
            existingIntent: prev,
            nextIntent
          });

          if (!dailyCheck.ok) {
            appendPolicyAudit(this.store, {
              occurredAt: nowIso,
              operationId: 'swapIntents.update',
              decision: 'deny',
              reasonCode: reasonCodeFromPolicyCheck(dailyCheck, 'daily_cap_exceeded'),
              actor,
              subjectActor,
              intentId: id,
              delegationId: auth?.delegation?.delegation_id,
              policy,
              details: dailyCheck.details
            });
            return { ok: false, body: errorResponse(correlationId, dailyCheck.code, dailyCheck.message, dailyCheck.details) };
          }

          dayKey = dailyCheck.details?.day_key ?? dayKeyFromIsoUtc(nowIso);
        }

        this.store.state.intents[id] = nextIntent;

        if (actor?.type === 'agent') {
          const deltaUsd = dailySpendDeltaForIntentMutation({ previousIntent: prev, nextIntent });
          if (dailyCheck.enforced && dayKey) {
            const used = getDailySpend(this.store, subjectActor, dayKey);
            setDailySpend(this.store, subjectActor, dayKey, used + deltaUsd);
          }

          appendPolicyAudit(this.store, {
            occurredAt: nowIso,
            operationId: 'swapIntents.update',
            decision: 'allow',
            reasonCode: 'ok',
            actor,
            subjectActor,
            intentId: id,
            delegationId: auth?.delegation?.delegation_id,
            policy,
            details: {
              day_key: dayKey,
              delta_usd: deltaUsd,
              projected_usd: dailyCheck.details?.projected_usd ?? null,
              cap_usd: dailyCheck.details?.cap_usd ?? null,
              consent_required: !!consentCheck.required,
              consent_id: consentCheck.details?.consent_id ?? null
            }
          });
        }

        return { ok: true, body: { correlation_id: correlationIdForIntentId(nextIntent.id), intent: nextIntent } };
      }
    });
  }

  cancel({ actor, auth, idempotencyKey, requestBody }) {
    const correlationId = correlationIdForIntentId(requestBody?.id ?? 'unknown');

    const authz = authorizeApiOperation({ operationId: 'swapIntents.cancel', actor, auth, store: this.store });
    if (!authz.ok) {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details)
        }
      };
    }

    const subjectActor = effectiveActorForDelegation({ actor, auth }) ?? actor;
    if (actor?.type === 'agent' && !subjectActor) {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(correlationId, 'FORBIDDEN', 'agent access requires delegation subject', { actor })
        }
      };
    }

    return this._withIdempotency({
      actor,
      operationId: 'swapIntents.cancel',
      idempotencyKey,
      requestBody,
      correlationId,
      handler: () => {
        const id = requestBody.id;
        const prev = this.store.state.intents[id];
        if (!prev) {
          return { ok: false, body: errorResponse(correlationIdForIntentId(id), 'NOT_FOUND', 'intent not found', { id }) };
        }

        if (actor?.type === 'agent' && actorKey(prev.actor) !== actorKey(subjectActor)) {
          return {
            ok: false,
            body: errorResponse(correlationIdForIntentId(id), 'FORBIDDEN', 'agent cannot cancel this intent', {
              actor,
              subject_actor: subjectActor,
              intent_actor: prev.actor
            })
          };
        }

        const nextIntent = { ...prev, status: 'cancelled' };
        this.store.state.intents[id] = nextIntent;

        if (actor?.type === 'agent') {
          const policy = policyForDelegatedActor({ actor, auth });
          const nowIso = resolvePolicyNowIso({ auth });
          const dayKey = dayKeyFromIsoUtc(nowIso);

          if (policy && Number.isFinite(policy.max_value_per_day_usd) && dayKey) {
            const deltaUsd = dailySpendDeltaForIntentMutation({ previousIntent: prev, nextIntent });
            const used = getDailySpend(this.store, subjectActor, dayKey);
            setDailySpend(this.store, subjectActor, dayKey, used + deltaUsd);
          }

          appendPolicyAudit(this.store, {
            occurredAt: nowIso,
            operationId: 'swapIntents.cancel',
            decision: 'allow',
            reasonCode: 'ok',
            actor,
            subjectActor,
            intentId: id,
            delegationId: auth?.delegation?.delegation_id,
            policy,
            details: {
              day_key: dayKey,
              cancelled: true
            }
          });
        }

        return { ok: true, body: { correlation_id: correlationIdForIntentId(id), id, status: 'cancelled' } };
      }
    });
  }

  get({ actor, auth, id }) {
    const correlationId = correlationIdForIntentId(id);

    const authz = authorizeApiOperation({ operationId: 'swapIntents.get', actor, auth, store: this.store });
    if (!authz.ok) {
      return { ok: false, body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details) };
    }

    const subjectActor = effectiveActorForDelegation({ actor, auth }) ?? actor;
    if (actor?.type === 'agent' && !subjectActor) {
      return { ok: false, body: errorResponse(correlationId, 'FORBIDDEN', 'agent access requires delegation subject', { actor }) };
    }

    // v1: actor must match intent.actor (agent matches via delegation subject).
    const intent = this.store.state.intents[id];
    if (!intent) return { ok: false, body: errorResponse(correlationId, 'NOT_FOUND', 'intent not found', { id }) };
    if (actorKey(intent.actor) !== actorKey(subjectActor)) {
      return { ok: false, body: errorResponse(correlationId, 'FORBIDDEN', 'actor cannot access this intent', { id }) };
    }
    return { ok: true, body: { correlation_id: correlationId, intent } };
  }

  list({ actor, auth }) {
    const correlationId = correlationIdForIntentsList(actor);

    const authz = authorizeApiOperation({ operationId: 'swapIntents.list', actor, auth, store: this.store });
    if (!authz.ok) {
      return { ok: false, body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details) };
    }

    const subjectActor = effectiveActorForDelegation({ actor, auth }) ?? actor;
    if (actor?.type === 'agent' && !subjectActor) {
      return { ok: false, body: errorResponse(correlationId, 'FORBIDDEN', 'agent access requires delegation subject', { actor }) };
    }

    const intents = Object.values(this.store.state.intents).filter(i => actorKey(i.actor) === actorKey(subjectActor));
    return { ok: true, body: { correlation_id: correlationId, intents } };
  }
}
