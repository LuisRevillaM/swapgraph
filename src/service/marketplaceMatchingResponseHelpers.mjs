import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';

export function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function errorResponse(correlationIdValue, code, message, details = {}) {
  return {
    correlation_id: correlationIdValue,
    error: {
      code,
      message,
      details
    }
  };
}

export function withIdempotency({
  store,
  actor,
  operationId,
  idempotencyKey,
  requestBody,
  correlationIdValue,
  handler
}) {
  const scopeKey = idempotencyScopeKey({ actor, operationId, idempotencyKey });
  const requestHash = payloadHash(requestBody);
  const existing = store.state.idempotency[scopeKey];

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
        body: errorResponse(correlationIdValue, 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH', 'idempotency key reused with a different payload', {
          operation_id: operationId,
          idempotency_key: idempotencyKey
        })
      }
    };
  }

  const result = handler();
  store.state.idempotency[scopeKey] = {
    payload_hash: requestHash,
    result: clone(result)
  };

  return { replayed: false, result };
}
