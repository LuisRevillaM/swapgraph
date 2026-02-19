import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { authorizeApiOperation } from '../core/authz.mjs';

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

function correlationId(operationId, holdingId) {
  return `corr_${operationId}_${holdingId ?? 'unknown'}`;
}

function actorKey(actor) {
  return `${actor?.type}:${actor?.id}`;
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function ensureVaultState(store) {
  store.state.idempotency ||= {};
  store.state.vault_holdings ||= {};
  store.state.vault_events ||= [];
}

function authorizeOrError({ store, operationId, actor, auth, correlationId }) {
  const authz = authorizeApiOperation({ operationId, actor, auth, store });
  if (authz.ok) return null;

  return {
    ok: false,
    body: errorResponse(correlationId, authz.error.code, authz.error.message, authz.error.details)
  };
}

function appendVaultEvent(store, {
  operationId,
  eventType,
  occurredAt,
  actor,
  holdingId,
  details
}) {
  ensureVaultState(store);
  const idx = (store.state.vault_events?.length ?? 0) + 1;
  const event = {
    event_id: `ve_${idx}`,
    operation_id: operationId,
    event_type: eventType,
    occurred_at: occurredAt,
    actor,
    holding_id: holdingId,
    details: details ?? {}
  };
  store.state.vault_events.push(event);
  return event;
}

function normalizeNowIso(nowIso) {
  return nowIso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
}

function makeVaultHolding({ holding, ownerActor, nowIso }) {
  return {
    holding_id: holding.holding_id,
    vault_id: holding.vault_id,
    asset: holding.asset,
    owner_actor: ownerActor,
    status: 'available',
    deposit_id: holding.deposit_id ?? null,
    deposited_at: holding.deposited_at ?? nowIso,
    reservation_id: null,
    withdrawn_at: null,
    settlement_cycle_id: null,
    updated_at: nowIso
  };
}

export class VaultLifecycleService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureVaultState(this.store);
  }

  _withIdempotency({ actor, operationId, idempotencyKey, requestBody, correlation, handler }) {
    const scopeKey = idempotencyScopeKey({ actor, operationId, idempotencyKey });
    const hash = payloadHash(requestBody);

    const existing = this.store.state.idempotency[scopeKey];
    if (existing) {
      if (existing.payload_hash === hash) return { replayed: true, result: existing.result };

      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(
            correlation,
            'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH',
            'Idempotency key reused with a different payload',
            {
              scope_key: scopeKey,
              original_hash: existing.payload_hash,
              new_hash: hash
            }
          )
        }
      };
    }

    const result = handler();
    this.store.state.idempotency[scopeKey] = {
      payload_hash: hash,
      result: clone(result)
    };

    return { replayed: false, result };
  }

  deposit({ actor, auth, idempotencyKey, requestBody, nowIso }) {
    const holdingId = requestBody?.holding?.holding_id ?? requestBody?.holding_id ?? 'unknown';
    const corr = correlationId('vault.deposit', holdingId);

    const authFailure = authorizeOrError({
      store: this.store,
      operationId: 'vault.deposit',
      actor,
      auth,
      correlationId: corr
    });
    if (authFailure) {
      return {
        replayed: false,
        result: authFailure
      };
    }

    if (actor?.type !== 'user') {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(corr, 'FORBIDDEN', 'only user can deposit to vault', { actor })
        }
      };
    }

    return this._withIdempotency({
      actor,
      operationId: 'vault.deposit',
      idempotencyKey,
      requestBody,
      correlation: corr,
      handler: () => {
        const now = normalizeNowIso(nowIso);
        const holding = requestBody?.holding;

        if (!holding?.holding_id || !holding?.vault_id || !holding?.asset?.platform || !holding?.asset?.asset_id) {
          return {
            ok: false,
            body: errorResponse(corr, 'SCHEMA_INVALID', 'vault holding payload is invalid', {
              reason_code: 'vault_holding_invalid'
            })
          };
        }

        const owner = holding?.owner_actor ?? actor;
        if (actorKey(owner) !== actorKey(actor)) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'user can only deposit holdings for self', {
              reason_code: 'vault_owner_mismatch',
              actor,
              owner_actor: owner
            })
          };
        }

        const existing = this.store.state.vault_holdings[holding.holding_id] ?? null;
        if (existing) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'holding_id already exists in vault state', {
              reason_code: 'vault_holding_exists',
              holding_id: holding.holding_id,
              status: existing.status
            })
          };
        }

        const vaultHolding = makeVaultHolding({ holding, ownerActor: owner, nowIso: now });
        this.store.state.vault_holdings[vaultHolding.holding_id] = vaultHolding;

        appendVaultEvent(this.store, {
          operationId: 'vault.deposit',
          eventType: 'vault.deposit_confirmed',
          occurredAt: now,
          actor,
          holdingId: vaultHolding.holding_id,
          details: {
            vault_id: vaultHolding.vault_id,
            deposit_id: vaultHolding.deposit_id
          }
        });

        return {
          ok: true,
          body: {
            correlation_id: corr,
            holding: vaultHolding
          }
        };
      }
    });
  }

  reserve({ actor, auth, idempotencyKey, requestBody, nowIso }) {
    const holdingId = requestBody?.holding_id ?? 'unknown';
    const corr = correlationId('vault.reserve', holdingId);

    const authFailure = authorizeOrError({
      store: this.store,
      operationId: 'vault.reserve',
      actor,
      auth,
      correlationId: corr
    });
    if (authFailure) {
      return {
        replayed: false,
        result: authFailure
      };
    }

    if (actor?.type !== 'partner') {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(corr, 'FORBIDDEN', 'only partner can reserve vaulted holding', { actor })
        }
      };
    }

    return this._withIdempotency({
      actor,
      operationId: 'vault.reserve',
      idempotencyKey,
      requestBody,
      correlation: corr,
      handler: () => {
        const now = normalizeNowIso(nowIso);
        const holdingIdValue = requestBody?.holding_id;
        const reservationId = requestBody?.reservation_id;

        if (!holdingIdValue || !reservationId) {
          return {
            ok: false,
            body: errorResponse(corr, 'SCHEMA_INVALID', 'reservation payload is invalid', {
              reason_code: 'vault_reservation_invalid'
            })
          };
        }

        const holding = this.store.state.vault_holdings[holdingIdValue] ?? null;
        if (!holding) {
          return {
            ok: false,
            body: errorResponse(corr, 'NOT_FOUND', 'vault holding not found', {
              reason_code: 'vault_holding_not_found',
              holding_id: holdingIdValue
            })
          };
        }

        if (holding.status !== 'available') {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'vault holding is not available for reservation', {
              reason_code: 'vault_holding_not_available',
              holding_id: holdingIdValue,
              status: holding.status,
              reservation_id: holding.reservation_id ?? null
            })
          };
        }

        holding.status = 'reserved';
        holding.reservation_id = reservationId;
        holding.updated_at = now;

        appendVaultEvent(this.store, {
          operationId: 'vault.reserve',
          eventType: 'vault.holding_reserved',
          occurredAt: now,
          actor,
          holdingId: holdingIdValue,
          details: {
            reservation_id: reservationId
          }
        });

        return {
          ok: true,
          body: {
            correlation_id: corr,
            holding
          }
        };
      }
    });
  }

  release({ actor, auth, idempotencyKey, requestBody, nowIso }) {
    const holdingId = requestBody?.holding_id ?? 'unknown';
    const corr = correlationId('vault.release', holdingId);

    const authFailure = authorizeOrError({
      store: this.store,
      operationId: 'vault.release',
      actor,
      auth,
      correlationId: corr
    });
    if (authFailure) {
      return {
        replayed: false,
        result: authFailure
      };
    }

    if (actor?.type !== 'partner') {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(corr, 'FORBIDDEN', 'only partner can release vaulted reservation', { actor })
        }
      };
    }

    return this._withIdempotency({
      actor,
      operationId: 'vault.release',
      idempotencyKey,
      requestBody,
      correlation: corr,
      handler: () => {
        const now = normalizeNowIso(nowIso);
        const holdingIdValue = requestBody?.holding_id;
        const reservationId = requestBody?.reservation_id;

        if (!holdingIdValue || !reservationId) {
          return {
            ok: false,
            body: errorResponse(corr, 'SCHEMA_INVALID', 'release payload is invalid', {
              reason_code: 'vault_release_invalid'
            })
          };
        }

        const holding = this.store.state.vault_holdings[holdingIdValue] ?? null;
        if (!holding) {
          return {
            ok: false,
            body: errorResponse(corr, 'NOT_FOUND', 'vault holding not found', {
              reason_code: 'vault_holding_not_found',
              holding_id: holdingIdValue
            })
          };
        }

        if (holding.status !== 'reserved') {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'vault holding is not reserved', {
              reason_code: 'vault_holding_not_reserved',
              holding_id: holdingIdValue,
              status: holding.status
            })
          };
        }

        if (holding.reservation_id !== reservationId) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'reservation_id does not match holding reservation', {
              reason_code: 'vault_reservation_mismatch',
              holding_id: holdingIdValue,
              expected_reservation_id: holding.reservation_id,
              reservation_id: reservationId
            })
          };
        }

        holding.status = 'available';
        holding.reservation_id = null;
        holding.updated_at = now;

        appendVaultEvent(this.store, {
          operationId: 'vault.release',
          eventType: 'vault.holding_released',
          occurredAt: now,
          actor,
          holdingId: holdingIdValue,
          details: {
            reservation_id: reservationId
          }
        });

        return {
          ok: true,
          body: {
            correlation_id: corr,
            holding
          }
        };
      }
    });
  }

  withdraw({ actor, auth, idempotencyKey, requestBody, nowIso }) {
    const holdingId = requestBody?.holding_id ?? 'unknown';
    const corr = correlationId('vault.withdraw', holdingId);

    const authFailure = authorizeOrError({
      store: this.store,
      operationId: 'vault.withdraw',
      actor,
      auth,
      correlationId: corr
    });
    if (authFailure) {
      return {
        replayed: false,
        result: authFailure
      };
    }

    if (actor?.type !== 'user') {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(corr, 'FORBIDDEN', 'only user can withdraw from vault', { actor })
        }
      };
    }

    return this._withIdempotency({
      actor,
      operationId: 'vault.withdraw',
      idempotencyKey,
      requestBody,
      correlation: corr,
      handler: () => {
        const now = normalizeNowIso(nowIso);
        const holdingIdValue = requestBody?.holding_id;

        if (!holdingIdValue) {
          return {
            ok: false,
            body: errorResponse(corr, 'SCHEMA_INVALID', 'withdraw payload is invalid', {
              reason_code: 'vault_withdraw_invalid'
            })
          };
        }

        const holding = this.store.state.vault_holdings[holdingIdValue] ?? null;
        if (!holding) {
          return {
            ok: false,
            body: errorResponse(corr, 'NOT_FOUND', 'vault holding not found', {
              reason_code: 'vault_holding_not_found',
              holding_id: holdingIdValue
            })
          };
        }

        if (actorKey(holding.owner_actor) !== actorKey(actor)) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'user cannot withdraw holding owned by another user', {
              reason_code: 'vault_owner_mismatch',
              actor,
              owner_actor: holding.owner_actor
            })
          };
        }

        if (holding.status === 'reserved') {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'vault holding is reserved', {
              reason_code: 'vault_holding_reserved',
              holding_id: holdingIdValue,
              reservation_id: holding.reservation_id ?? null
            })
          };
        }

        if (holding.status === 'withdrawn') {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'vault holding already withdrawn', {
              reason_code: 'vault_holding_already_withdrawn',
              holding_id: holdingIdValue,
              withdrawn_at: holding.withdrawn_at ?? null
            })
          };
        }

        holding.status = 'withdrawn';
        holding.withdrawn_at = requestBody?.withdrawn_at ?? now;
        holding.reservation_id = null;
        holding.updated_at = now;

        appendVaultEvent(this.store, {
          operationId: 'vault.withdraw',
          eventType: 'vault.holding_withdrawn',
          occurredAt: now,
          actor,
          holdingId: holdingIdValue,
          details: {
            withdrawn_at: holding.withdrawn_at
          }
        });

        return {
          ok: true,
          body: {
            correlation_id: corr,
            holding
          }
        };
      }
    });
  }

  get({ actor, auth, holdingId }) {
    const corr = correlationId('vault.get', holdingId);

    const authFailure = authorizeOrError({
      store: this.store,
      operationId: 'vault.get',
      actor,
      auth,
      correlationId: corr
    });
    if (authFailure) return authFailure;

    const holding = this.store.state.vault_holdings[holdingId] ?? null;

    if (!holding) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'vault holding not found', {
          reason_code: 'vault_holding_not_found',
          holding_id: holdingId
        })
      };
    }

    if (actor?.type === 'user' && actorKey(holding.owner_actor) !== actorKey(actor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'user cannot access holding owned by another user', {
          reason_code: 'vault_owner_mismatch',
          actor,
          owner_actor: holding.owner_actor
        })
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        holding
      }
    };
  }

  list({ actor, auth, query }) {
    const corr = correlationId('vault.list', actor?.id ?? 'unknown');

    const authFailure = authorizeOrError({
      store: this.store,
      operationId: 'vault.list',
      actor,
      auth,
      correlationId: corr
    });
    if (authFailure) return authFailure;

    const includeWithdrawn = query?.include_withdrawn === true;

    const holdings = Object.values(this.store.state.vault_holdings ?? {})
      .filter(h => {
        if (actor?.type === 'user') return actorKey(h.owner_actor) === actorKey(actor);
        if (actor?.type === 'partner') return true;
        return false;
      })
      .filter(h => includeWithdrawn ? true : h.status !== 'withdrawn')
      .sort((a, b) => String(a.holding_id).localeCompare(String(b.holding_id)));

    return {
      ok: true,
      body: {
        correlation_id: corr,
        holdings
      }
    };
  }
}
