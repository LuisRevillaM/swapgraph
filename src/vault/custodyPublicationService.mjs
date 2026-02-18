import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import {
  buildCustodySnapshot,
  buildCustodyInclusionProof
} from '../custody/proofOfCustody.mjs';

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

function correlationId(operationId, id) {
  return `corr_${operationId}_${id ?? 'unknown'}`;
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function ensureVaultCustodyState(store) {
  store.state.idempotency ||= {};
  store.state.vault_custody_snapshots ||= {};
  store.state.vault_custody_snapshot_order ||= [];
}

function normalizeNowIso(nowIso) {
  return nowIso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
}

function parseLimit(limit) {
  const n = Number.parseInt(String(limit ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 200);
}

function requirePartnerActor(actor, correlationId) {
  if (actor?.type === 'partner') return null;

  return {
    ok: false,
    body: errorResponse(correlationId, 'FORBIDDEN', 'only partner can access vault custody publication', {
      actor
    })
  };
}

function snapshotSummary(snapshot) {
  return {
    snapshot_id: snapshot.snapshot_id,
    recorded_at: snapshot.recorded_at,
    leaf_count: snapshot.leaf_count,
    root_hash: snapshot.root_hash
  };
}

export class VaultCustodyPublicationService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureVaultCustodyState(this.store);
  }

  _withIdempotency({ actor, operationId, idempotencyKey, requestBody, correlationId, handler }) {
    const scopeKey = idempotencyScopeKey({ actor, operationId, idempotencyKey });
    const hash = payloadHash(requestBody);

    const existing = this.store.state.idempotency[scopeKey];
    if (existing) {
      if (existing.payload_hash === hash) {
        return { replayed: true, result: clone(existing.result) };
      }

      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(
            correlationId,
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

  publishSnapshot({ actor, idempotencyKey, requestBody, nowIso }) {
    const snapshotId = requestBody?.snapshot_id ?? 'unknown';
    const correlation = correlationId('vault.custody.publish', snapshotId);

    const partnerRequired = requirePartnerActor(actor, correlation);
    if (partnerRequired) {
      return {
        replayed: false,
        result: partnerRequired
      };
    }

    return this._withIdempotency({
      actor,
      operationId: 'vault.custody.publish',
      idempotencyKey,
      requestBody,
      correlationId: correlation,
      handler: () => {
        const now = normalizeNowIso(nowIso);
        const requestedSnapshotId = String(requestBody?.snapshot_id ?? '').trim();
        const recordedAt = String(requestBody?.recorded_at ?? now).trim();
        const holdings = requestBody?.holdings ?? [];

        if (!requestedSnapshotId || !Array.isArray(holdings)) {
          return {
            ok: false,
            body: errorResponse(correlation, 'SCHEMA_INVALID', 'vault custody snapshot payload is invalid', {
              reason_code: 'vault_custody_snapshot_invalid'
            })
          };
        }

        if (this.store.state.vault_custody_snapshots[requestedSnapshotId]) {
          return {
            ok: false,
            body: errorResponse(correlation, 'CONSTRAINT_VIOLATION', 'vault custody snapshot already exists', {
              reason_code: 'vault_custody_snapshot_exists',
              snapshot_id: requestedSnapshotId
            })
          };
        }

        const snapshot = buildCustodySnapshot({
          snapshotId: requestedSnapshotId,
          recordedAt,
          holdings
        });

        this.store.state.vault_custody_snapshots[requestedSnapshotId] = snapshot;
        this.store.state.vault_custody_snapshot_order.push(requestedSnapshotId);

        return {
          ok: true,
          body: {
            correlation_id: correlation,
            snapshot: snapshotSummary(snapshot)
          }
        };
      }
    });
  }

  listSnapshots({ actor, query }) {
    const correlation = correlationId('vault.custody.list', actor?.id);

    const partnerRequired = requirePartnerActor(actor, correlation);
    if (partnerRequired) return partnerRequired;

    const limit = parseLimit(query?.limit);
    const cursorAfter = typeof query?.cursor_after === 'string' && query.cursor_after.trim()
      ? query.cursor_after.trim()
      : null;

    const order = [...(this.store.state.vault_custody_snapshot_order ?? [])];
    let start = 0;

    if (cursorAfter) {
      const idx = order.indexOf(cursorAfter);
      if (idx < 0) {
        return {
          ok: false,
          body: errorResponse(correlation, 'CONSTRAINT_VIOLATION', 'cursor_after not found in custody snapshot catalog', {
            reason_code: 'vault_custody_cursor_not_found',
            cursor_after: cursorAfter
          })
        };
      }
      start = idx + 1;
    }

    const selectedIds = order.slice(start, start + limit);
    const snapshots = selectedIds
      .map(snapshotId => this.store.state.vault_custody_snapshots[snapshotId])
      .filter(Boolean)
      .map(snapshotSummary);

    const hasMore = (start + limit) < order.length;
    const nextCursor = hasMore && snapshots.length > 0
      ? snapshots[snapshots.length - 1].snapshot_id
      : null;

    const body = {
      correlation_id: correlation,
      snapshots,
      total: order.length
    };

    if (nextCursor) body.next_cursor = nextCursor;

    return {
      ok: true,
      body
    };
  }

  getSnapshot({ actor, snapshotId }) {
    const correlation = correlationId('vault.custody.get', snapshotId);

    const partnerRequired = requirePartnerActor(actor, correlation);
    if (partnerRequired) return partnerRequired;

    const snapshot = this.store.state.vault_custody_snapshots[snapshotId] ?? null;
    if (!snapshot) {
      return {
        ok: false,
        body: errorResponse(correlation, 'NOT_FOUND', 'vault custody snapshot not found', {
          reason_code: 'vault_custody_snapshot_not_found',
          snapshot_id: snapshotId
        })
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: correlation,
        snapshot
      }
    };
  }

  getInclusionProof({ actor, snapshotId, holdingId }) {
    const correlation = correlationId('vault.custody.proof', `${snapshotId}_${holdingId}`);

    const partnerRequired = requirePartnerActor(actor, correlation);
    if (partnerRequired) return partnerRequired;

    const snapshot = this.store.state.vault_custody_snapshots[snapshotId] ?? null;
    if (!snapshot) {
      return {
        ok: false,
        body: errorResponse(correlation, 'NOT_FOUND', 'vault custody snapshot not found', {
          reason_code: 'vault_custody_snapshot_not_found',
          snapshot_id: snapshotId
        })
      };
    }

    const holdings = snapshot.holdings ?? [];
    const entry = holdings.find(h => h?.holding?.holding_id === holdingId) ?? null;

    if (!entry) {
      return {
        ok: false,
        body: errorResponse(correlation, 'NOT_FOUND', 'vault custody holding not found in snapshot', {
          reason_code: 'vault_custody_holding_not_found',
          snapshot_id: snapshotId,
          holding_id: holdingId
        })
      };
    }

    const proofResult = buildCustodyInclusionProof({ snapshot, holding: entry.holding });
    if (!proofResult.ok) {
      return {
        ok: false,
        body: errorResponse(correlation, 'CONSTRAINT_VIOLATION', 'unable to build custody inclusion proof', {
          reason_code: proofResult.error,
          snapshot_id: snapshotId,
          holding_id: holdingId
        })
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: correlation,
        snapshot_id: snapshot.snapshot_id,
        root_hash: snapshot.root_hash,
        holding: entry.holding,
        proof: proofResult.proof
      }
    };
  }
}
