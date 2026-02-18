import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { authorizeApiOperation } from '../core/authz.mjs';

function actorKey(actor) {
  return `${actor.type}:${actor.id}`;
}

function effectiveActor({ actor, auth }) {
  if (actor?.type === 'agent') {
    return auth?.delegation?.subject_actor ?? null;
  }
  return actor;
}

function policyForActor({ actor, auth }) {
  if (actor?.type === 'agent') {
    return auth?.delegation?.policy ?? null;
  }
  return null;
}

function enforceTradingPolicyForIntent({ policy, intent }) {
  if (!policy) {
    return { ok: false, code: 'FORBIDDEN', message: 'delegation policy is required', details: { policy: null } };
  }

  const violations = [];

  const maxUsd = intent?.value_band?.max_usd;
  if (Number.isFinite(policy.max_value_per_swap_usd) && Number.isFinite(maxUsd) && maxUsd > policy.max_value_per_swap_usd) {
    violations.push({ field: 'value_band.max_usd', max_allowed: policy.max_value_per_swap_usd, actual: maxUsd });
  }

  const maxCycle = intent?.trust_constraints?.max_cycle_length;
  if (Number.isFinite(policy.max_cycle_length) && Number.isFinite(maxCycle) && maxCycle > policy.max_cycle_length) {
    violations.push({ field: 'trust_constraints.max_cycle_length', max_allowed: policy.max_cycle_length, actual: maxCycle });
  }

  if (typeof policy.require_escrow === 'boolean') {
    const reqEscrow = intent?.settlement_preferences?.require_escrow;
    if (typeof reqEscrow === 'boolean' && reqEscrow !== policy.require_escrow) {
      violations.push({ field: 'settlement_preferences.require_escrow', required: policy.require_escrow, actual: reqEscrow });
    }
  }

  if (violations.length > 0) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      message: 'delegation policy violation',
      details: { violations }
    };
  }

  return { ok: true };
}

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

export class SwapIntentsService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
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

    const authz = authorizeApiOperation({ operationId: 'swapIntents.create', actor, auth });
    if (!authz.ok) {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details)
        }
      };
    }

    const eff = effectiveActor({ actor, auth }) ?? actor;
    if (actor?.type === 'agent' && !eff) {
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
      if (actorKey(intent?.actor) !== actorKey(eff)) {
        return {
          replayed: false,
          result: {
            ok: false,
            body: errorResponse(correlationId, 'FORBIDDEN', 'agent cannot act for this actor', {
              actor,
              subject_actor: eff,
              intent_actor: intent?.actor ?? null
            })
          }
        };
      }

      const policy = policyForActor({ actor, auth });
      const pol = enforceTradingPolicyForIntent({ policy, intent });
      if (!pol.ok) {
        return {
          replayed: false,
          result: {
            ok: false,
            body: errorResponse(correlationId, pol.code, pol.message, pol.details)
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
        const stored = { ...intent, status: intent.status ?? 'active' };
        this.store.state.intents[intent.id] = stored;
        return { ok: true, body: { correlation_id: correlationIdForIntentId(stored.id), intent: stored } };
      }
    });
  }

  update({ actor, auth, id, idempotencyKey, requestBody }) {
    const correlationId = correlationIdForIntentId(id);

    const authz = authorizeApiOperation({ operationId: 'swapIntents.update', actor, auth });
    if (!authz.ok) {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details)
        }
      };
    }

    const eff = effectiveActor({ actor, auth }) ?? actor;
    if (actor?.type === 'agent' && !eff) {
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
      if (actorKey(intent?.actor) !== actorKey(eff)) {
        return {
          replayed: false,
          result: {
            ok: false,
            body: errorResponse(correlationId, 'FORBIDDEN', 'agent cannot act for this actor', {
              actor,
              subject_actor: eff,
              intent_actor: intent?.actor ?? null
            })
          }
        };
      }

      const policy = policyForActor({ actor, auth });
      const pol = enforceTradingPolicyForIntent({ policy, intent });
      if (!pol.ok) {
        return {
          replayed: false,
          result: {
            ok: false,
            body: errorResponse(correlationId, pol.code, pol.message, pol.details)
          }
        };
      }

      const existing = this.store.state.intents[id];
      if (existing && actorKey(existing.actor) !== actorKey(eff)) {
        return {
          replayed: false,
          result: {
            ok: false,
            body: errorResponse(correlationId, 'FORBIDDEN', 'agent cannot modify this intent', {
              actor,
              subject_actor: eff,
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
        const prev = this.store.state.intents[id];
        const status = prev?.status ?? intent.status ?? 'active';
        const stored = { ...intent, status };
        this.store.state.intents[id] = stored;
        return { ok: true, body: { correlation_id: correlationIdForIntentId(stored.id), intent: stored } };
      }
    });
  }

  cancel({ actor, auth, idempotencyKey, requestBody }) {
    const correlationId = correlationIdForIntentId(requestBody?.id ?? 'unknown');

    const authz = authorizeApiOperation({ operationId: 'swapIntents.cancel', actor, auth });
    if (!authz.ok) {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details)
        }
      };
    }

    const eff = effectiveActor({ actor, auth }) ?? actor;
    if (actor?.type === 'agent' && !eff) {
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

        if (actor?.type === 'agent' && actorKey(prev.actor) !== actorKey(eff)) {
          return {
            ok: false,
            body: errorResponse(correlationIdForIntentId(id), 'FORBIDDEN', 'agent cannot cancel this intent', {
              actor,
              subject_actor: eff,
              intent_actor: prev.actor
            })
          };
        }

        this.store.state.intents[id] = { ...prev, status: 'cancelled' };
        return { ok: true, body: { correlation_id: correlationIdForIntentId(id), id, status: 'cancelled' } };
      }
    });
  }

  get({ actor, auth, id }) {
    const correlationId = correlationIdForIntentId(id);

    const authz = authorizeApiOperation({ operationId: 'swapIntents.get', actor, auth });
    if (!authz.ok) {
      return { ok: false, body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details) };
    }

    const eff = effectiveActor({ actor, auth }) ?? actor;
    if (actor?.type === 'agent' && !eff) {
      return { ok: false, body: errorResponse(correlationId, 'FORBIDDEN', 'agent access requires delegation subject', { actor }) };
    }

    // v1: actor must match intent.actor (agent matches via delegation subject).
    const intent = this.store.state.intents[id];
    if (!intent) return { ok: false, body: errorResponse(correlationId, 'NOT_FOUND', 'intent not found', { id }) };
    if (actorKey(intent.actor) !== actorKey(eff)) {
      return { ok: false, body: errorResponse(correlationId, 'FORBIDDEN', 'actor cannot access this intent', { id }) };
    }
    return { ok: true, body: { correlation_id: correlationId, intent } };
  }

  list({ actor, auth }) {
    const correlationId = correlationIdForIntentsList(actor);

    const authz = authorizeApiOperation({ operationId: 'swapIntents.list', actor, auth });
    if (!authz.ok) {
      return { ok: false, body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details) };
    }

    const eff = effectiveActor({ actor, auth }) ?? actor;
    if (actor?.type === 'agent' && !eff) {
      return { ok: false, body: errorResponse(correlationId, 'FORBIDDEN', 'agent access requires delegation subject', { actor }) };
    }

    const intents = Object.values(this.store.state.intents).filter(i => actorKey(i.actor) === actorKey(eff));
    return { ok: true, body: { correlation_id: correlationId, intents } };
  }
}
