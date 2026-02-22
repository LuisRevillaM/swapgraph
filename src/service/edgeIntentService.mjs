import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';

const EDGE_INTENT_TYPES = new Set(['allow', 'prefer', 'block']);
const EDGE_INTENT_STATUS = new Set(['active', 'inactive']);
const EDGE_INTENT_MAX_NOTE_LEN = 400;

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function parseBooleanLike(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) return fallback;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  return null;
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
  store.state.intents ||= {};
  store.state.edge_intents ||= {};
  store.state.edge_intent_counter ||= 0;
}

function actorRef(actor) {
  return {
    type: actor?.type ?? 'unknown',
    id: actor?.id ?? 'unknown'
  };
}

function normalizeEdgeIntentView(input) {
  return {
    id: input.id,
    source_intent_id: input.source_intent_id,
    target_intent_id: input.target_intent_id,
    intent_type: input.intent_type,
    strength: input.strength,
    status: input.status,
    expires_at: input.expires_at ?? null,
    note: input.note ?? null,
    created_by: clone(input.created_by),
    created_at: input.created_at,
    updated_at: input.updated_at
  };
}

function isEdgeIntentActive(edgeIntent, nowIso) {
  if ((edgeIntent?.status ?? 'active') !== 'active') return false;
  const expiresMs = parseIsoMs(edgeIntent?.expires_at);
  if (expiresMs === null) return true;
  const nowMs = parseIsoMs(nowIso) ?? Date.now();
  return expiresMs > nowMs;
}

function normalizeListQuery(query) {
  const allowed = new Set(['source_intent_id', 'target_intent_id', 'intent_type', 'status', 'active_only', 'limit']);
  for (const key of Object.keys(query ?? {})) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        details: {
          key,
          reason_code: 'edge_intent_query_invalid'
        }
      };
    }
  }

  const sourceIntentId = normalizeOptionalString(query?.source_intent_id);
  const targetIntentId = normalizeOptionalString(query?.target_intent_id);
  const intentType = normalizeOptionalString(query?.intent_type)?.toLowerCase() ?? null;
  const status = normalizeOptionalString(query?.status)?.toLowerCase() ?? null;
  const activeOnly = parseBooleanLike(query?.active_only, false);
  const limit = parseLimit(query?.limit, 50);

  if ((intentType && !EDGE_INTENT_TYPES.has(intentType))
    || (status && !EDGE_INTENT_STATUS.has(status))
    || activeOnly === null
    || limit === null) {
    return {
      ok: false,
      details: {
        reason_code: 'edge_intent_query_invalid'
      }
    };
  }

  return {
    ok: true,
    value: {
      source_intent_id: sourceIntentId,
      target_intent_id: targetIntentId,
      intent_type: intentType,
      status,
      active_only: activeOnly,
      limit
    }
  };
}

export class EdgeIntentService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureState(this.store);
  }

  _nextEdgeIntentId() {
    this.store.state.edge_intent_counter = Number(this.store.state.edge_intent_counter ?? 0) + 1;
    const n = String(this.store.state.edge_intent_counter).padStart(6, '0');
    return `edge_${n}`;
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

  _normalizeUpsertRequest({ actor, auth, request }) {
    const edgeIntent = request?.edge_intent;
    if (!edgeIntent || typeof edgeIntent !== 'object' || Array.isArray(edgeIntent)) {
      return {
        ok: false,
        code: 'CONSTRAINT_VIOLATION',
        message: 'edge_intent payload is required',
        details: { reason_code: 'edge_intent_invalid' }
      };
    }

    const sourceIntentId = normalizeOptionalString(edgeIntent.source_intent_id);
    const targetIntentId = normalizeOptionalString(edgeIntent.target_intent_id);
    const intentType = normalizeOptionalString(edgeIntent.intent_type)?.toLowerCase() ?? null;
    const status = normalizeOptionalString(edgeIntent.status)?.toLowerCase() ?? 'active';
    const explicitId = normalizeOptionalString(edgeIntent.id);
    const note = normalizeOptionalString(edgeIntent.note);
    const recordedAt = normalizeOptionalString(request?.recorded_at) ?? normalizeOptionalString(auth?.now_iso) ?? new Date().toISOString();
    const expiresAt = normalizeOptionalString(edgeIntent.expires_at);
    const strengthRaw = edgeIntent.strength ?? 1;
    const strength = Number(strengthRaw);

    const recordedAtMs = parseIsoMs(recordedAt);
    const expiresAtMs = expiresAt ? parseIsoMs(expiresAt) : null;

    if (!sourceIntentId
      || !targetIntentId
      || sourceIntentId === targetIntentId
      || !intentType
      || !EDGE_INTENT_TYPES.has(intentType)
      || !EDGE_INTENT_STATUS.has(status)
      || !Number.isFinite(strength)
      || strength < 0
      || strength > 1
      || (note && note.length > EDGE_INTENT_MAX_NOTE_LEN)) {
      return {
        ok: false,
        code: 'CONSTRAINT_VIOLATION',
        message: 'invalid edge_intent request',
        details: { reason_code: 'edge_intent_invalid' }
      };
    }

    if (recordedAtMs === null || (expiresAt && expiresAtMs === null)) {
      return {
        ok: false,
        code: 'CONSTRAINT_VIOLATION',
        message: 'invalid timestamp in edge_intent request',
        details: { reason_code: 'edge_intent_invalid_timestamp' }
      };
    }

    if (expiresAtMs !== null && expiresAtMs <= recordedAtMs) {
      return {
        ok: false,
        code: 'CONSTRAINT_VIOLATION',
        message: 'edge intent expiry must be after recorded_at',
        details: { reason_code: 'edge_intent_invalid_expiry' }
      };
    }

    const sourceIntent = this.store.state.intents?.[sourceIntentId] ?? null;
    if (!sourceIntent) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        message: 'source intent not found',
        details: {
          source_intent_id: sourceIntentId,
          reason_code: 'edge_intent_source_not_found'
        }
      };
    }

    const targetIntent = this.store.state.intents?.[targetIntentId] ?? null;
    if (!targetIntent) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        message: 'target intent not found',
        details: {
          target_intent_id: targetIntentId,
          reason_code: 'edge_intent_target_not_found'
        }
      };
    }

    if (actor?.type === 'user') {
      const sourceActor = sourceIntent.actor ?? null;
      if (sourceActor?.type !== 'user' || sourceActor?.id !== actor.id) {
        return {
          ok: false,
          code: 'FORBIDDEN',
          message: 'user actor can only express edges from their own source intent',
          details: {
            source_intent_id: sourceIntentId,
            actor,
            reason_code: 'edge_intent_source_not_owned'
          }
        };
      }
    }

    return {
      ok: true,
      value: {
        id: explicitId,
        source_intent_id: sourceIntentId,
        target_intent_id: targetIntentId,
        intent_type: intentType,
        strength,
        status,
        note: note ?? null,
        expires_at: expiresAt ?? null,
        recorded_at: recordedAt
      }
    };
  }

  upsertEdgeIntent({ actor, auth, idempotencyKey, request }) {
    const op = 'edgeIntents.upsert';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const normalized = this._normalizeUpsertRequest({ actor, auth, request });
        if (!normalized.ok) {
          return {
            ok: false,
            body: errorResponse(corr, normalized.code, normalized.message, normalized.details)
          };
        }

        const n = normalized.value;
        const edgeIntentId = n.id ?? this._nextEdgeIntentId();
        const existing = this.store.state.edge_intents?.[edgeIntentId] ?? null;
        const createdBy = existing?.created_by ?? actorRef(actor);
        const createdAt = existing?.created_at ?? n.recorded_at;

        const row = {
          id: edgeIntentId,
          source_intent_id: n.source_intent_id,
          target_intent_id: n.target_intent_id,
          intent_type: n.intent_type,
          strength: n.strength,
          status: n.status,
          note: n.note,
          expires_at: n.expires_at,
          created_by: createdBy,
          created_at: createdAt,
          updated_at: n.recorded_at
        };

        this.store.state.edge_intents[edgeIntentId] = row;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            edge_intent: normalizeEdgeIntentView(row)
          }
        };
      }
    });
  }

  getEdgeIntent({ actor, auth, edgeIntentId }) {
    const op = 'edgeIntents.get';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    const normalizedId = normalizeOptionalString(edgeIntentId);
    if (!normalizedId) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'edge intent id is required', {
          reason_code: 'edge_intent_invalid'
        })
      };
    }

    const row = this.store.state.edge_intents?.[normalizedId] ?? null;
    if (!row) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'edge intent not found', {
          edge_intent_id: normalizedId,
          reason_code: 'edge_intent_not_found'
        })
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        edge_intent: normalizeEdgeIntentView(row)
      }
    };
  }

  listEdgeIntents({ actor, auth, query }) {
    const op = 'edgeIntents.list';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };

    const normalized = normalizeListQuery(query ?? {});
    if (!normalized.ok) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid edge intent query', normalized.details)
      };
    }

    const nowIso = normalizeOptionalString(auth?.now_iso) ?? new Date().toISOString();
    const value = normalized.value;
    const rows = Object.values(this.store.state.edge_intents ?? {})
      .filter(row => {
        if (value.source_intent_id && row.source_intent_id !== value.source_intent_id) return false;
        if (value.target_intent_id && row.target_intent_id !== value.target_intent_id) return false;
        if (value.intent_type && row.intent_type !== value.intent_type) return false;
        if (value.status && row.status !== value.status) return false;
        if (value.active_only && !isEdgeIntentActive(row, nowIso)) return false;
        return true;
      })
      .sort((a, b) => {
        const aMs = parseIsoMs(a?.updated_at) ?? 0;
        const bMs = parseIsoMs(b?.updated_at) ?? 0;
        if (aMs !== bMs) return bMs - aMs;
        return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
      })
      .slice(0, value.limit);

    return {
      ok: true,
      body: {
        correlation_id: corr,
        edge_intents: rows.map(normalizeEdgeIntentView),
        total: rows.length
      }
    };
  }
}
