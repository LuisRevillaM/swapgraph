import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';

function actorKey(actor) {
  return `${actor.type}:${actor.id}`;
}

function errorResponse(code, message, details = {}) {
  return {
    error: {
      code,
      message,
      details
    }
  };
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
   * @param {{ actor: any, operationId: string, idempotencyKey: string, requestBody: any, handler: () => any }} params
   */
  _withIdempotency({ actor, operationId, idempotencyKey, requestBody, handler }) {
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
            'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH',
            'Idempotency key reused with a different payload',
            { scope_key: scopeKey, original_hash: existing.payload_hash, new_hash: h }
          )
        }
      };
    }

    const result = handler();
    this.store.state.idempotency[scopeKey] = { payload_hash: h, result };
    return { replayed: false, result };
  }

  create({ actor, idempotencyKey, requestBody }) {
    return this._withIdempotency({
      actor,
      operationId: 'swapIntents.create',
      idempotencyKey,
      requestBody,
      handler: () => {
        const intent = requestBody.intent;
        const stored = { ...intent, status: intent.status ?? 'active' };
        this.store.state.intents[intent.id] = stored;
        return { ok: true, body: { intent: stored } };
      }
    });
  }

  update({ actor, id, idempotencyKey, requestBody }) {
    return this._withIdempotency({
      actor,
      operationId: 'swapIntents.update',
      idempotencyKey,
      requestBody,
      handler: () => {
        const intent = requestBody.intent;
        if (intent.id !== id) {
          return { ok: false, body: errorResponse('CONSTRAINT_VIOLATION', 'intent.id must match path id', { id, intent_id: intent.id }) };
        }
        const prev = this.store.state.intents[id];
        const status = prev?.status ?? intent.status ?? 'active';
        const stored = { ...intent, status };
        this.store.state.intents[id] = stored;
        return { ok: true, body: { intent: stored } };
      }
    });
  }

  cancel({ actor, idempotencyKey, requestBody }) {
    return this._withIdempotency({
      actor,
      operationId: 'swapIntents.cancel',
      idempotencyKey,
      requestBody,
      handler: () => {
        const id = requestBody.id;
        const prev = this.store.state.intents[id];
        if (!prev) {
          return { ok: false, body: errorResponse('NOT_FOUND', 'intent not found', { id }) };
        }
        this.store.state.intents[id] = { ...prev, status: 'cancelled' };
        return { ok: true, body: { id, status: 'cancelled' } };
      }
    });
  }

  get({ actor, id }) {
    // v1: auth not implemented; we still restrict list/get to the same actor.
    const intent = this.store.state.intents[id];
    if (!intent) return { ok: false, body: errorResponse('NOT_FOUND', 'intent not found', { id }) };
    if (actorKey(intent.actor) !== actorKey(actor)) {
      return { ok: false, body: errorResponse('FORBIDDEN', 'actor cannot access this intent', { id }) };
    }
    return { ok: true, body: { intent } };
  }

  list({ actor }) {
    const intents = Object.values(this.store.state.intents).filter(i => actorKey(i.actor) === actorKey(actor));
    return { ok: true, body: { intents } };
  }
}
