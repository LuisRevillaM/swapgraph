import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { authorizeApiOperation } from '../core/authz.mjs';
import { mintDelegationToken, encodeDelegationTokenString } from '../crypto/delegationTokenSigning.mjs';

function actorKey(actor) {
  return `${actor.type}:${actor.id}`;
}

function errorResponse(correlationId, code, message, details = {}) {
  return { correlation_id: correlationId, error: { code, message, details } };
}

function correlationIdForDelegationId(delegationId) {
  return `corr_delegation_${delegationId}`;
}

function delegationResponse(correlationId, delegation) {
  const token = mintDelegationToken({ delegation });
  const delegation_token = encodeDelegationTokenString(token);
  return { correlation_id: correlationId, delegation, delegation_token };
}

export class DelegationsService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    this.store.state.delegations ||= {};
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

  create({ actor, auth, idempotencyKey, requestBody, occurredAt }) {
    const delegationId = requestBody?.delegation?.delegation_id ?? 'unknown';
    const correlationId = correlationIdForDelegationId(delegationId);

    const authz = authorizeApiOperation({ operationId: 'delegations.create', actor, auth, store: this.store });
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
      operationId: 'delegations.create',
      idempotencyKey,
      requestBody,
      correlationId,
      handler: () => {
        if (!occurredAt) throw new Error('occurredAt is required');

        if (actor?.type !== 'user') {
          return {
            ok: false,
            body: errorResponse(correlationId, 'FORBIDDEN', 'only user can create delegations', { actor })
          };
        }

        const d = requestBody?.delegation;
        if (!d?.delegation_id) {
          return { ok: false, body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'delegation.delegation_id is required', {}) };
        }

        const existing = this.store.state.delegations[d.delegation_id];
        if (existing) {
          if (actorKey(existing.subject_actor) !== actorKey(actor)) {
            return {
              ok: false,
              body: errorResponse(correlationId, 'FORBIDDEN', 'delegation belongs to a different user', {
                delegation_id: d.delegation_id
              })
            };
          }

          const conflict =
            JSON.stringify(existing.principal_agent) !== JSON.stringify(d.principal_agent) ||
            JSON.stringify(existing.scopes) !== JSON.stringify(d.scopes) ||
            JSON.stringify(existing.policy) !== JSON.stringify(d.policy) ||
            existing.expires_at !== d.expires_at;

          if (conflict) {
            return {
              ok: false,
              body: errorResponse(correlationId, 'CONFLICT', 'delegation_id already exists with different parameters', {
                delegation_id: d.delegation_id
              })
            };
          }

          return { ok: true, body: delegationResponse(correlationId, existing) };
        }

        const grant = {
          delegation_id: d.delegation_id,
          principal_agent: d.principal_agent,
          subject_actor: actor,
          scopes: d.scopes,
          policy: d.policy,
          issued_at: occurredAt,
          expires_at: d.expires_at
        };

        this.store.state.delegations[d.delegation_id] = grant;

        return { ok: true, body: delegationResponse(correlationId, grant) };
      }
    });
  }

  get({ actor, auth, delegationId }) {
    const correlationId = correlationIdForDelegationId(delegationId);

    const authz = authorizeApiOperation({ operationId: 'delegations.get', actor, auth, store: this.store });
    if (!authz.ok) {
      return { ok: false, body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details) };
    }

    if (!delegationId) {
      return { ok: false, body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'delegationId is required', {}) };
    }

    const grant = this.store.state.delegations[delegationId];
    if (!grant) {
      return { ok: false, body: errorResponse(correlationId, 'NOT_FOUND', 'delegation not found', { delegation_id: delegationId }) };
    }

    if (actor?.type !== 'user') {
      return { ok: false, body: errorResponse(correlationId, 'FORBIDDEN', 'only user can read delegations', { actor }) };
    }

    if (actorKey(grant.subject_actor) !== actorKey(actor)) {
      return { ok: false, body: errorResponse(correlationId, 'FORBIDDEN', 'delegation belongs to a different user', { delegation_id: delegationId }) };
    }

    return { ok: true, body: delegationResponse(correlationId, grant) };
  }

  revoke({ actor, auth, idempotencyKey, delegationId, requestBody }) {
    const correlationId = correlationIdForDelegationId(delegationId);

    const authz = authorizeApiOperation({ operationId: 'delegations.revoke', actor, auth, store: this.store });
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
      operationId: 'delegations.revoke',
      idempotencyKey,
      requestBody,
      correlationId,
      handler: () => {
        if (actor?.type !== 'user') {
          return {
            ok: false,
            body: errorResponse(correlationId, 'FORBIDDEN', 'only user can revoke delegations', { actor })
          };
        }

        if (!delegationId) {
          return { ok: false, body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'delegationId is required', {}) };
        }

        const grant = this.store.state.delegations[delegationId];
        if (!grant) {
          return { ok: false, body: errorResponse(correlationId, 'NOT_FOUND', 'delegation not found', { delegation_id: delegationId }) };
        }

        if (actorKey(grant.subject_actor) !== actorKey(actor)) {
          return { ok: false, body: errorResponse(correlationId, 'FORBIDDEN', 'delegation belongs to a different user', { delegation_id: delegationId }) };
        }

        const revokedAt = requestBody?.revoked_at;
        if (!revokedAt) {
          return { ok: false, body: errorResponse(correlationId, 'CONSTRAINT_VIOLATION', 'revoked_at is required', {}) };
        }

        if (grant.revoked_at) {
          return { ok: true, body: delegationResponse(correlationId, grant) };
        }

        grant.revoked_at = revokedAt;
        return { ok: true, body: delegationResponse(correlationId, grant) };
      }
    });
  }
}
