import { randomUUID } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { effectiveActorForDelegation } from '../core/tradingPolicyBoundaries.mjs';

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

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRecordedAt(request, auth) {
  return normalizeOptionalString(request?.recorded_at) ?? normalizeOptionalString(auth?.now_iso) ?? new Date().toISOString();
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

function actorEquals(a, b) {
  return (a?.type ?? null) === (b?.type ?? null) && (a?.id ?? null) === (b?.id ?? null);
}

function normalizeActorRef(value) {
  if (!isPlainObject(value)) return null;
  const type = normalizeOptionalString(value.type);
  const id = normalizeOptionalString(value.id);
  if (!type || !id) return null;
  return { type, id };
}

function ensureState(store) {
  store.state.idempotency ||= {};
  store.state.market_execution_grants ||= {};
  store.state.market_execution_grant_counter ||= 0;
}

function nextGrantId(store) {
  store.state.market_execution_grant_counter = Number(store.state.market_execution_grant_counter ?? 0) + 1;
  return `grant_${String(store.state.market_execution_grant_counter).padStart(6, '0')}`;
}

function normalizeGrantView(record) {
  return {
    grant_id: record.grant_id,
    deal_id: record.deal_id ?? null,
    actor: clone(record.actor),
    audience: clone(record.audience),
    scope: clone(record.scope),
    grant_mode: record.grant_mode,
    ciphertext: record.ciphertext ?? null,
    nonce: record.nonce,
    max_uses: 1,
    expires_at: record.expires_at,
    consumed_at: record.consumed_at ?? null,
    created_at: record.created_at
  };
}

function defaultTtlSeconds() {
  const raw = Number.parseInt(String(process.env.MARKET_EXECUTION_GRANT_TTL_SECS ?? '600'), 10);
  if (!Number.isFinite(raw) || raw < 60) return 600;
  return Math.min(raw, 1800);
}

function plusSeconds(iso, seconds) {
  const ms = parseIsoMs(iso);
  if (ms === null) return null;
  return new Date(ms + (seconds * 1000)).toISOString();
}

export class MarketExecutionGrantService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureState(this.store);
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

  _subjectActor({ actor, auth }) {
    return effectiveActorForDelegation({ actor, auth }) ?? actor;
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

  create({ actor, auth, idempotencyKey, request }) {
    const op = 'marketExecutionGrants.create';
    const corr = correlationId(op);
    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const subjectActor = this._subjectActor({ actor, auth });
        const recordedAt = normalizeRecordedAt(request, auth);
        if (parseIsoMs(recordedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid execution grant timestamp', {
              reason_code: 'market_execution_grant_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const grant = request?.grant;
        if (!isPlainObject(grant)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid execution grant payload', {
              reason_code: 'market_execution_grant_invalid'
            })
          };
        }

        const audience = normalizeActorRef(grant.audience);
        const scope = Array.isArray(grant.scope)
          ? Array.from(new Set(grant.scope.map(value => normalizeOptionalString(value)).filter(Boolean)))
          : [];
        const grantMode = normalizeOptionalString(grant.grant_mode)?.toLowerCase() ?? null;
        const requestedId = normalizeOptionalString(grant.grant_id);
        const grantId = requestedId ?? nextGrantId(this.store);
        const dealId = normalizeOptionalString(grant.deal_id);
        const ciphertext = normalizeOptionalString(grant.ciphertext);
        const nonce = normalizeOptionalString(grant.nonce) ?? randomUUID();
        const expiresAt = normalizeOptionalString(grant.expires_at) ?? plusSeconds(recordedAt, defaultTtlSeconds());

        if (!audience || scope.length < 1 || (grantMode !== 'token' && grantMode !== 'encrypted_envelope') || parseIsoMs(expiresAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid execution grant payload', {
              reason_code: 'market_execution_grant_invalid'
            })
          };
        }

        if (grantMode === 'encrypted_envelope' && !ciphertext) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'encrypted_envelope grants require ciphertext', {
              reason_code: 'market_execution_grant_invalid'
            })
          };
        }

        const issuedMs = parseIsoMs(recordedAt);
        const expiryMs = parseIsoMs(expiresAt);
        if (issuedMs === null || expiryMs === null || expiryMs <= issuedMs || (expiryMs - issuedMs) > (1800 * 1000)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'execution grant ttl is invalid', {
              reason_code: 'market_execution_grant_invalid',
              expires_at: expiresAt
            })
          };
        }

        if (this.store.state.market_execution_grants[grantId]) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONFLICT', 'execution grant already exists', {
              reason_code: 'market_execution_grant_conflict',
              grant_id: grantId
            })
          };
        }

        const record = {
          grant_id: grantId,
          deal_id: dealId,
          actor: clone(subjectActor),
          audience,
          scope,
          grant_mode: grantMode,
          ciphertext: ciphertext ?? null,
          nonce,
          max_uses: 1,
          expires_at: expiresAt,
          consumed_at: null,
          created_at: recordedAt
        };
        this.store.state.market_execution_grants[grantId] = record;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            grant: normalizeGrantView(record)
          }
        };
      }
    });
  }

  consume({ actor, auth, grantId, idempotencyKey, request }) {
    const op = 'marketExecutionGrants.consume';
    const corr = correlationId(op);
    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const subjectActor = this._subjectActor({ actor, auth });
        const recordedAt = normalizeRecordedAt(request, auth);
        if (parseIsoMs(recordedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid execution grant timestamp', {
              reason_code: 'market_execution_grant_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const record = this.store.state.market_execution_grants?.[grantId] ?? null;
        if (!record) {
          return {
            ok: false,
            body: errorResponse(corr, 'NOT_FOUND', 'execution grant not found', {
              reason_code: 'market_execution_grant_not_found',
              grant_id: grantId
            })
          };
        }

        if (!actorEquals(subjectActor, record.audience) && !actorEquals(actor, record.audience)) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'execution grant audience required', {
              reason_code: 'market_execution_grant_forbidden',
              actor: subjectActor,
              audience: record.audience
            })
          };
        }

        if ((parseIsoMs(record.expires_at) ?? 0) < (parseIsoMs(recordedAt) ?? 0)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'execution grant expired', {
              reason_code: 'market_execution_grant_expired',
              grant_id: grantId,
              expires_at: record.expires_at
            })
          };
        }

        const requiredScope = normalizeOptionalString(request?.required_scope);
        if (requiredScope && !record.scope.includes(requiredScope)) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'execution grant scope mismatch', {
              reason_code: 'market_execution_grant_scope_invalid',
              grant_id: grantId,
              required_scope: requiredScope,
              granted_scope: record.scope
            })
          };
        }

        if (record.consumed_at) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONFLICT', 'execution grant already consumed', {
              reason_code: 'market_execution_grant_replayed',
              grant_id: grantId,
              consumed_at: record.consumed_at
            })
          };
        }

        record.consumed_at = recordedAt;
        return {
          ok: true,
          body: {
            correlation_id: corr,
            grant: normalizeGrantView(record)
          }
        };
      }
    });
  }
}
