import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { authorizeApiOperation } from '../core/authz.mjs';

function actorKey(actor) {
  return `${actor.type}:${actor.id}`;
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

    return this._withIdempotency({
      actor,
      operationId: 'swapIntents.create',
      idempotencyKey,
      requestBody,
      correlationId,
      handler: () => {
        const intent = requestBody.intent;
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

    return this._withIdempotency({
      actor,
      operationId: 'swapIntents.update',
      idempotencyKey,
      requestBody,
      correlationId,
      handler: () => {
        const intent = requestBody.intent;
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

    // v1: actor must match intent.actor.
    const intent = this.store.state.intents[id];
    if (!intent) return { ok: false, body: errorResponse(correlationId, 'NOT_FOUND', 'intent not found', { id }) };
    if (actorKey(intent.actor) !== actorKey(actor)) {
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

    const intents = Object.values(this.store.state.intents).filter(i => actorKey(i.actor) === actorKey(actor));
    return { ok: true, body: { correlation_id: correlationId, intents } };
  }
}
