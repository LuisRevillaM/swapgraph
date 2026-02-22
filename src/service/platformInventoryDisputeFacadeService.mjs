import { createHash } from 'node:crypto';

import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';

const platformConnectionStatuses = new Set(['connected', 'disconnected', 'degraded']);
const disputeTypes = new Set(['delivery', 'billing', 'sla']);
const disputeSeverities = new Set(['low', 'medium', 'high']);

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseIsoMs(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

function actorScopeKey(actor) {
  return `${actor?.type ?? 'unknown'}:${actor?.id ?? 'unknown'}`;
}

function canonicalHash(input) {
  return createHash('sha256').update(String(input), 'utf8').digest('hex');
}

function ensureState(store) {
  store.state.platform_connections ||= {};
  store.state.inventory_snapshots ||= {};
  store.state.partner_program_disputes ||= [];
  store.state.idempotency ||= {};
}

function normalizeConnectionRecord(record) {
  return {
    connection_id: record.connection_id,
    actor: record.actor,
    platform: record.platform,
    account_ref: record.account_ref,
    status: record.status,
    connected_at: record.connected_at,
    updated_at: record.updated_at,
    metadata: isObject(record.metadata) ? record.metadata : {}
  };
}

function normalizeDisputeRecord(record) {
  return {
    dispute_id: record.dispute_id,
    partner_id: record.partner_id,
    dispute_type: record.dispute_type,
    severity: record.severity,
    subject_ref: record.subject_ref,
    reason_code: record.reason_code,
    status: record.status,
    opened_at: record.opened_at,
    resolved_at: record.resolved_at ?? null,
    resolution: record.resolution ?? null,
    evidence_items: Array.isArray(record.evidence_items) ? record.evidence_items : []
  };
}

export class PlatformInventoryDisputeFacadeService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureState(this.store);
  }

  _withIdempotency({ actor, operationId, idempotencyKey, requestBody, correlationId: correlationIdValue, handler }) {
    const scopeKey = idempotencyScopeKey({ actor, operationId, idempotencyKey });
    const requestHash = payloadHash(requestBody);

    const existing = this.store.state.idempotency[scopeKey];
    if (existing) {
      if (existing.payload_hash === requestHash) return { replayed: true, result: existing.result };
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(
            correlationIdValue,
            'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH',
            'idempotency key reused with a different payload',
            { operation_id: operationId, idempotency_key: idempotencyKey }
          )
        }
      };
    }

    const result = handler();
    const snapshot = JSON.parse(JSON.stringify(result));
    this.store.state.idempotency[scopeKey] = { payload_hash: requestHash, result: snapshot };
    return { replayed: false, result: snapshot };
  }

  listPlatformConnections({ actor, auth }) {
    const op = 'platform.connections.list';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) {
      return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };
    }

    const actorKey = actorScopeKey(actor);
    const connectionsByKey = this.store.state.platform_connections?.[actorKey] ?? {};
    const connections = Object.values(connectionsByKey).map(normalizeConnectionRecord);
    connections.sort((a, b) => `${a.platform}|${a.account_ref}|${a.connection_id}`.localeCompare(`${b.platform}|${b.account_ref}|${b.connection_id}`));

    return {
      ok: true,
      body: {
        correlation_id: corr,
        connections
      }
    };
  }

  upsertPlatformConnection({ actor, auth, idempotencyKey, request }) {
    const op = 'platform.connections.upsert';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details)
        }
      };
    }

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const connection = request?.connection ?? {};
        const platform = normalizeOptionalString(connection.platform);
        const accountRef = normalizeOptionalString(connection.account_ref);
        const status = normalizeOptionalString(connection.status);
        const metadata = isObject(connection.metadata) ? connection.metadata : {};

        if (!platform || !accountRef || !status || !platformConnectionStatuses.has(status)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid platform connection payload', {
              reason_code: 'platform_connection_invalid'
            })
          };
        }

        const recordedAt = normalizeOptionalString(request?.recorded_at) ?? auth?.now_iso ?? new Date().toISOString();
        const recordedMs = parseIsoMs(recordedAt);
        if (recordedMs === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid platform connection timestamp', {
              reason_code: 'platform_connection_invalid_timestamp',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const connectedAt = normalizeOptionalString(connection.connected_at) ?? new Date(recordedMs).toISOString();
        if (parseIsoMs(connectedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid platform connection timestamp', {
              reason_code: 'platform_connection_invalid_timestamp',
              connected_at: connection.connected_at ?? null
            })
          };
        }

        const actorKey = actorScopeKey(actor);
        this.store.state.platform_connections[actorKey] ||= {};

        const connectionKey = `${platform}|${accountRef}`;
        const existing = this.store.state.platform_connections[actorKey][connectionKey] ?? null;
        const connectionId = existing?.connection_id ?? `conn_${canonicalHash(`${actorKey}|${connectionKey}`).slice(0, 16)}`;

        const next = {
          connection_id: connectionId,
          actor: { type: actor.type, id: actor.id },
          platform,
          account_ref: accountRef,
          status,
          connected_at: connectedAt,
          updated_at: new Date(recordedMs).toISOString(),
          metadata
        };

        this.store.state.platform_connections[actorKey][connectionKey] = next;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            connection: normalizeConnectionRecord(next)
          }
        };
      }
    });
  }

  recordInventorySnapshot({ actor, auth, idempotencyKey, request }) {
    const op = 'inventory.snapshots.record';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details)
        }
      };
    }

    if (actor?.type !== 'partner') {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(corr, 'FORBIDDEN', 'only partner can record inventory snapshots', { actor })
        }
      };
    }

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const snapshot = request?.snapshot ?? {};
        const platform = normalizeOptionalString(snapshot.platform);
        const capturedAt = normalizeOptionalString(snapshot.captured_at);
        const assets = Array.isArray(snapshot.assets) ? snapshot.assets : [];

        if (!platform || !capturedAt || assets.length === 0) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid inventory snapshot payload', {
              reason_code: 'inventory_snapshot_invalid'
            })
          };
        }

        const capturedMs = parseIsoMs(capturedAt);
        if (capturedMs === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid inventory snapshot timestamp', {
              reason_code: 'inventory_snapshot_invalid_timestamp',
              captured_at: capturedAt
            })
          };
        }

        const normalizedAssets = [];
        for (const asset of assets) {
          const assetId = normalizeOptionalString(asset?.asset_id);
          const quantity = Number.parseInt(String(asset?.quantity ?? ''), 10);
          const metadata = isObject(asset?.metadata) ? asset.metadata : {};
          if (!assetId || !Number.isFinite(quantity) || quantity < 1) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid inventory snapshot payload', {
                reason_code: 'inventory_snapshot_invalid'
              })
            };
          }
          normalizedAssets.push({ asset_id: assetId, quantity, metadata });
        }

        const partnerId = actor.id;
        this.store.state.inventory_snapshots[partnerId] ||= [];
        const seq = this.store.state.inventory_snapshots[partnerId].length + 1;
        const snapshotId = normalizeOptionalString(snapshot.snapshot_id) ?? `inv_snapshot_${String(seq).padStart(6, '0')}`;

        const recordedAt = normalizeOptionalString(request?.recorded_at) ?? auth?.now_iso ?? new Date().toISOString();
        if (parseIsoMs(recordedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid inventory snapshot timestamp', {
              reason_code: 'inventory_snapshot_invalid_timestamp',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const row = {
          snapshot_id: snapshotId,
          partner_id: partnerId,
          platform,
          captured_at: new Date(capturedMs).toISOString(),
          recorded_at: recordedAt,
          assets: normalizedAssets
        };

        this.store.state.inventory_snapshots[partnerId].push(row);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            snapshot: row
          }
        };
      }
    });
  }

  listInventoryAssets({ actor, auth, query }) {
    const op = 'inventory.assets.list';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) {
      return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };
    }

    if (actor?.type !== 'partner') {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can list inventory assets', { actor })
      };
    }

    const allowedQueryKeys = new Set(['platform']);
    for (const key of Object.keys(query ?? {})) {
      if (!allowedQueryKeys.has(key)) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid inventory assets query', {
            reason_code: 'inventory_asset_query_invalid',
            key
          })
        };
      }
    }

    const platformFilter = normalizeOptionalString(query?.platform);
    const snapshots = this.store.state.inventory_snapshots?.[actor.id] ?? [];
    const latestByAsset = new Map();

    for (const snapshot of snapshots) {
      if (platformFilter && snapshot.platform !== platformFilter) continue;
      const capturedMs = parseIsoMs(snapshot.captured_at);
      if (capturedMs === null) continue;

      for (const asset of snapshot.assets ?? []) {
        const key = `${snapshot.platform}|${asset.asset_id}`;
        const prior = latestByAsset.get(key);
        if (!prior) {
          latestByAsset.set(key, { snapshot, asset, capturedMs });
          continue;
        }

        const priorMs = prior.capturedMs;
        if (capturedMs > priorMs || (capturedMs === priorMs && String(snapshot.snapshot_id).localeCompare(String(prior.snapshot.snapshot_id)) > 0)) {
          latestByAsset.set(key, { snapshot, asset, capturedMs });
        }
      }
    }

    const assets = Array.from(latestByAsset.values()).map(({ snapshot, asset }) => ({
      platform: snapshot.platform,
      asset_id: asset.asset_id,
      quantity: asset.quantity,
      metadata: asset.metadata ?? {},
      snapshot_id: snapshot.snapshot_id,
      captured_at: snapshot.captured_at
    }));

    assets.sort((a, b) => `${a.platform}|${a.asset_id}|${a.snapshot_id}`.localeCompare(`${b.platform}|${b.asset_id}|${b.snapshot_id}`));

    return {
      ok: true,
      body: {
        correlation_id: corr,
        assets
      }
    };
  }

  createDisputeFacade({ actor, auth, idempotencyKey, request }) {
    const op = 'disputes.create';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details)
        }
      };
    }

    if (actor?.type !== 'partner') {
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(corr, 'FORBIDDEN', 'only partner can create disputes', { actor })
        }
      };
    }

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const dispute = request?.dispute ?? {};
        const disputeType = normalizeOptionalString(dispute.dispute_type);
        const severity = normalizeOptionalString(dispute.severity);
        const subjectRef = normalizeOptionalString(dispute.subject_ref);
        const reasonCode = normalizeOptionalString(dispute.reason_code);
        const openedAtRaw = normalizeOptionalString(dispute.opened_at) ?? auth?.now_iso ?? new Date().toISOString();
        const openedAtMs = parseIsoMs(openedAtRaw);

        if (!disputeType || !disputeTypes.has(disputeType) || !severity || !disputeSeverities.has(severity) || !subjectRef || !reasonCode || openedAtMs === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid dispute facade payload', {
              reason_code: 'dispute_facade_invalid'
            })
          };
        }

        const disputes = this.store.state.partner_program_disputes;
        const disputeId = `dispute_${String(disputes.length + 1).padStart(6, '0')}`;
        const row = {
          dispute_id: disputeId,
          partner_id: actor.id,
          dispute_type: disputeType,
          severity,
          subject_ref: subjectRef,
          reason_code: reasonCode,
          status: 'open',
          opened_at: new Date(openedAtMs).toISOString(),
          resolved_at: null,
          resolution: null,
          evidence_items: Array.isArray(dispute.evidence_items) ? dispute.evidence_items : []
        };

        disputes.push(row);

        return {
          ok: true,
          body: {
            correlation_id: corr,
            dispute: normalizeDisputeRecord(row)
          }
        };
      }
    });
  }

  getDisputeFacade({ actor, auth, disputeId }) {
    const op = 'disputes.get';
    const corr = correlationId(op);

    const authz = authorizeApiOperation({ operationId: op, actor, auth, store: this.store });
    if (!authz.ok) {
      return { ok: false, body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details) };
    }

    if (actor?.type !== 'partner') {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'only partner can read disputes', { actor })
      };
    }

    const normalizedId = normalizeOptionalString(disputeId);
    if (!normalizedId) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'dispute id is required', {
          reason_code: 'dispute_facade_invalid'
        })
      };
    }

    const dispute = (this.store.state.partner_program_disputes ?? []).find(
      row => row?.partner_id === actor.id && row?.dispute_id === normalizedId
    );

    if (!dispute) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'dispute not found', {
          reason_code: 'dispute_not_found',
          dispute_id: normalizedId
        })
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        dispute: normalizeDisputeRecord(dispute)
      }
    };
  }
}
